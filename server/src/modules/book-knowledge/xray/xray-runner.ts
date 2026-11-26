import type { Logger } from '@nestjs/common';
import type { BookKnowledgeXrayStep, BookKnowledgeXrayStepId } from '@bookorbit/types';
import { extractJson } from '../../ai/ai-json';
import { isAiError, type AiResult } from '../../ai/ai-client.types';
import { repairJson } from '../core/json-repair';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { Sentence } from '../core/model';
import type { Read, Rejections } from './xray-checks';
import type { ReplayableSend, XrayReplay } from './xray-unit-store';

/** Units of one step in flight at once; the connection's own limiter still decides what reaches the model. */
export const XRAY_UNIT_CONCURRENCY = 16;
/** One retry after an unreadable reply, then the unit is skipped and counted. */
const TRIES = 2;

/** What every call of a run sent, for the privacy record. */
export class XrayPrivacy {
  readonly sent = new Set<number>();
  sentCharacters = 0;
  constructor(private readonly sentences: readonly Sentence[]) {}

  /** Records one call's sentences and returns its figures. */
  record(ordinals: Iterable<number>): { sentences: number; characters: number; sections: Set<number> } {
    const unique = [...new Set(ordinals)];
    let characters = 0;
    const sections = new Set<number>();
    for (const ordinal of unique) {
      const sentence = this.sentences[ordinal - 1];
      characters += sentence.text.length;
      sections.add(sentence.spineIndex);
      this.sent.add(ordinal);
    }
    this.sentCharacters += characters;
    return { sentences: unique.length, characters, sections };
  }

  distinctCharacters(): number {
    let characters = 0;
    for (const ordinal of this.sent) characters += this.sentences[ordinal - 1].text.length;
    return characters;
  }
}

export interface XrayUnit<T> {
  id: string;
  ordinals: readonly number[];
  send: () => Promise<AiResult>;
  read: Read<T>;
  /** Sends before the unit is skipped; an unreadable or cut reply is sent again until then. */
  tries?: number;
}

/** A reply that can be retried: unreadable JSON or a cut-short reply. A refusal is not retried. */
export function retryable(error: unknown): boolean {
  return isAiError(error) && (error.code === 'invalid-json' || error.code === 'too-long');
}

export class XrayStepRun {
  readonly record: BookKnowledgeXrayStep;
  private readonly sections = new Set<number>();

  constructor(
    step: BookKnowledgeXrayStepId,
    slot: 'fast' | 'careful',
    private readonly privacy: XrayPrivacy,
    private readonly logger: Logger,
    private readonly ids: string,
    private readonly replay?: XrayReplay,
  ) {
    this.record = {
      step,
      slot,
      units: 0,
      calls: 0,
      invalid: 0,
      skipped: 0,
      rejected: {},
      privacy: { calls: 0, sentences: 0, characters: 0, sections: 0 },
      start: new Date().toISOString(),
      end: null,
    };
  }

  /** Sends a unit, retrying an unreadable reply once; null when it is skipped. Other AI errors end the build. */
  async unit<T>(unit: XrayUnit<T>): Promise<T | null> {
    this.record.units++;
    const request = (unit.send as ReplayableSend).replayRequest;
    const stored = request && this.replay?.answer(this.record.step, unit.id, request);
    if (stored !== undefined && stored !== '') {
      const read = unit.read(stored);
      if (read) {
        this.tally('counts', { replayed: 1 });
        this.reject(read.rejected);
        return read.items;
      }
    }
    for (let attempt = 1; attempt <= (unit.tries ?? TRIES); attempt++) {
      const sent = this.privacy.record(unit.ordinals);
      for (const section of sent.sections) this.sections.add(section);
      this.record.calls++;
      this.record.privacy.calls++;
      this.record.privacy.sentences += sent.sentences;
      this.record.privacy.characters += sent.characters;
      this.record.privacy.sections = this.sections.size;
      this.logger.log(
        `[book_knowledge.xray_call] [start] ${this.ids} step=${this.record.step} unit=${unit.id} attempt=${attempt} sentences=${sent.sentences} characters=${sent.characters} sections=${sent.sections.size} - sending sentences`,
      );
      let read: ReturnType<Read<T>> = null;
      let refused = false;
      const sentAt = Date.now();
      try {
        const reply = await unit.send();
        this.used(reply.usage, Date.now() - sentAt);
        refused = reply.finish === 'refused' || reply.finish === 'filtered';
        const first = extractJson(reply.text);
        const json = first.ok ? first : extractJson(repairJson(reply.text));
        read = json.ok ? unit.read(json.value) : null;
        if (read && json.ok && request) this.replay?.save(this.record.step, unit.id, request, json.value, read.rejected);
      } catch (error) {
        if (!retryable(error)) throw error;
        if (isAiError(error) && error.code === 'too-long') {
          this.record.cut = (this.record.cut ?? 0) + 1;
          // The same prompt at the same hard cap is cut again.
          if ((unit.send as ReplayableSend).capped) {
            this.record.invalid++;
            break;
          }
        }
      }
      if (read) {
        this.reject(read.rejected);
        return read.items;
      }
      this.record.invalid++;
      // The same prompt is refused again, so a second paid call buys nothing.
      if (refused) break;
    }
    this.record.skipped++;
    (this.record.skippedUnits ??= []).push(unit.id);
    this.logger.warn(
      `[book_knowledge.xray_unit] [fail] ${this.ids} step=${this.record.step} unit=${sanitizeLogValue(unit.id)} durationMs=0 errorClass=InvalidReply error="unreadable after retry" - unit skipped`,
    );
    return null;
  }

  private used(usage: AiResult['usage'] | undefined, ms: number): void {
    const total = (this.record.usage ??= { input: 0, output: 0, reasoning: 0, cost: 0, callMs: 0 });
    total.input += usage?.input ?? 0;
    total.output += usage?.output ?? 0;
    total.reasoning += usage?.reasoning ?? 0;
    total.cost += usage?.cost ?? 0;
    total.callMs += ms;
  }

  /** Counts into one of the record's tallies, such as `firstTry` or `mapped`. */
  tally(field: 'firstTry' | 'mapped' | 'counts', counts: Rejections): void {
    const into = (this.record[field] ??= {});
    for (const [key, count] of Object.entries(counts)) into[key] = (into[key] ?? 0) + count;
  }

  reject(rejected: Rejections): void {
    for (const [reason, count] of Object.entries(rejected)) this.record.rejected[reason] = (this.record.rejected[reason] ?? 0) + count;
  }

  finish(): BookKnowledgeXrayStep {
    this.record.end = new Date().toISOString();
    return this.record;
  }
}

/** Marks a send whose output limit is a hard cap, so the step runner does not resend it after a cut-short reply. */
export function capped(send: ReplayableSend): ReplayableSend {
  return Object.assign(send, { capped: true as const });
}

/**
 * A run's model calls: one signal stops them all, and `settled` waits for every call launched, including any launched while
 * it waits. An error that ends the build aborts the rest before the step that sent it hears of it, so nothing launches on its back.
 */
export class XrayRunCalls {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly controller: AbortController) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  track<T>(call: Promise<T>): Promise<T> {
    this.pending.add(call);
    call.then(
      () => this.pending.delete(call),
      (error: unknown) => {
        this.pending.delete(call);
        if (!retryable(error)) this.controller.abort();
      },
    );
    return call;
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

/** A gate that lets at most `limit` tasks run at once, first come first served. */
export function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    // A finished task hands its place straight to the next waiter, so a newcomer cannot slip in between.
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/** Runs `work` over `items` with at most `limit` at once, keeping results in item order. */
export async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Runs `send` on the whole list; when it is skipped, on each half, down to single items, so one bad
 * reply cannot cost a whole call's worth of items.
 */
export async function inHalves<T, R>(items: readonly T[], id: string, send: (items: readonly T[], id: string) => Promise<R[] | null>): Promise<R[]> {
  const result = await send(items, id);
  if (result || items.length < 2) return result ?? [];
  const half = Math.ceil(items.length / 2);
  return [...(await inHalves(items.slice(0, half), `${id}a`, send)), ...(await inHalves(items.slice(half), `${id}b`, send))];
}
