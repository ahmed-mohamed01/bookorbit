import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type BookKnowledgeXrayMode, type BookKnowledgeXrayPayload, type BookKnowledgeXrayRun, type StoryGuideSectionInfo } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { AiError, type AiEffort, type AiResult, type AiSlotChoice } from '../ai/ai-client.types';
import { BookReadService } from '../book/book-read.service';
import { readBookText } from '../story-guides/text/book-text-reader';
import { BookKnowledgeModelService, CLASSIFY_TEMPERATURE } from './book-knowledge-model.service';
import { BookKnowledgeService } from './book-knowledge.service';
import { readGzipJson, writeGzipJsonAtomic } from './core/artifact';
import { fractionToOrdinal } from './core/cutoff';
import { readEpubMetadata } from './core/epub-metadata';
import {
  KIND_REVIEW_MAX_TOKENS,
  KIND_REVIEW_SYSTEM,
  parseReviewAnswers,
  planKindReview,
  reviewCheckpoint,
  type KindAnswer,
  type KindReviewBatch,
} from './core/kind-review';
import type { Artifact } from './core/model';
import { XrayAnchors } from './xray/xray-anchors';
import { densePlannedCalls } from './xray/dense/dense-estimate';
import { headingPairs, windowLinks } from './xray/dense/dense-links';
import { DENSE_PROMPT_VERSION } from './xray/dense/dense-prompt';
import { runDense } from './xray/dense/dense-run';
import type { PassSlot } from './xray/pass/pass-cast';
import { passPayload, unitEnd } from './xray/pass/pass-payload';
import type { Ask } from './xray/pass/pass-run';
import { spoilerSweep, stateCounts } from './xray/pass/pass-state';
import { passUnits } from './xray/pass/pass-units';
import { bodySections, sectionCharacters } from './xray/xray-evidence';
import { xrayEntities } from './xray/xray-entities';
import { namesAt } from './xray/xray-lines';
import { linkCheckpoints } from './xray/xray-links';
import { modeFromSubjects } from './xray/xray-mode';
import { xrayPayload } from './xray/xray-payload';
import { estimate } from './xray/xray-plan';
import { capped, inOrder, limiter, XrayPrivacy, XrayRunCalls, XrayStepRun } from './xray/xray-runner';
import { replayable, XrayUnitStore } from './xray/xray-unit-store';

const KEPT_RUNS = 4;
const RUN_PREFIX = 'bk-xray-';
const XRAY_EFFORT: AiEffort = 'low';
const PAYLOAD_FILE = 'xray-payload.json.gz';
const CANCELLED = 'cancelled';

interface StoredRun {
  run: BookKnowledgeXrayRun;
  payload: BookKnowledgeXrayPayload | null;
  /** Stops the run's model calls: on a failure, so the asks already launched stop spending, and on cancel. */
  abort: AbortController;
}

interface BuildInput {
  stored: StoredRun;
  run: BookKnowledgeXrayRun;
  artifact: Artifact;
  fingerprint: string;
  epubPath: string;
  fast: AiSlotChoice;
  dryRun: boolean;
  /** Ignore the stored answers of earlier builds, so a bench run measures every call. */
  fresh: boolean;
}

type AskWith = (
  use: AiSlotChoice,
  system: string,
  user: string,
  maxOutputTokens: number,
  effort?: AiEffort,
  temperature?: number,
) => () => Promise<AiResult>;

/** Hosted calls in flight at once in a dense run. */
const DENSE_CONCURRENCY = 8;

/**
 * The X-Ray build: Book Knowledge's entities without a model, then the dense pass in chunks through upstream's
 * AI client on the fast slot. One build at a time; runs are kept in memory for the admin and bench routes.
 */
@Injectable()
export class BookKnowledgeXrayService {
  private readonly logger = new Logger(BookKnowledgeXrayService.name);
  private readonly runs = new Map<string, StoredRun>();
  private active: string | null = null;

  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly read: BookReadService,
    private readonly model: BookKnowledgeModelService,
  ) {}

  async start(
    bookId: number,
    user: RequestUser,
    options: { through?: number; dryRun?: boolean; mode?: BookKnowledgeXrayMode; fresh?: boolean } = {},
  ): Promise<BookKnowledgeXrayRun> {
    if (this.active) throw new ConflictException('An X-Ray build is already running');
    const runId = `${RUN_PREFIX}${randomUUID()}`;
    // Taken before the first await, so a second start in the same moment cannot pass the check too.
    this.active = runId;
    let stored: StoredRun;
    let input: BuildInput;
    try {
      ({ stored, input } = await this.prepare(runId, bookId, user, options));
    } catch (error) {
      this.active = null;
      throw error;
    }
    this.keep(stored);
    void this.build(input).finally(() => {
      if (this.active === runId) this.active = null;
    });
    return stored.run;
  }

  private async prepare(
    runId: string,
    bookId: number,
    user: RequestUser,
    options: { through?: number; dryRun?: boolean; mode?: BookKnowledgeXrayMode; fresh?: boolean },
  ): Promise<{ stored: StoredRun; input: BuildInput }> {
    const { through, dryRun = false } = options;
    const fast = await this.model.choice('fast');
    if (!fast) throw new ServiceUnavailableException('Book Knowledge model is not configured');
    const { artifact, fingerprint } = await this.knowledge.context(bookId, user, 'full');
    const [file] = await this.read.knowledgeEpubFiles(bookId);
    if (!file) throw new BadRequestException('Book Knowledge requires an EPUB');
    const subjects = (await readEpubMetadata(file.absolutePath).catch(() => undefined))?.subjects ?? [];
    const full = fractionToOrdinal(artifact.sentences, 1);
    const run: BookKnowledgeXrayRun = {
      runId,
      bookId,
      status: 'running',
      error: null,
      through: through ? Math.min(through, full) : full,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: [],
      privacy: { bookCharacters: 0, bookSentences: 0, sentCharacters: 0, distinctSentences: 0, distinctCharacters: 0 },
      counts: null,
      dryRun,
      estimate: null,
      mode: options.mode ?? modeFromSubjects(subjects),
      tieVote: null,
      passRepeats: null,
    };
    const stored: StoredRun = { run, payload: null, abort: new AbortController() };
    return { stored, input: { stored, run, artifact, fingerprint, epubPath: file.absolutePath, fast, dryRun, fresh: options.fresh ?? false } };
  }

  /** Stops a running build: its model calls are aborted and nothing more is stored. A finished run is returned as it is. */
  cancel(runId: string): BookKnowledgeXrayRun {
    const stored = this.runs.get(runId);
    if (!stored) throw new NotFoundException('X-Ray run not found');
    if (stored.run.status !== 'running') return stored.run;
    stored.run.status = 'failed';
    stored.run.error = CANCELLED;
    stored.abort.abort();
    this.logger.log(`[book_knowledge.xray_cancel] [end] runId=${runId} bookId=${stored.run.bookId} - X-Ray build cancelled`);
    return stored.run;
  }

  /** The last whole-book X-Ray stored for the book's current text; 404 when none was built. */
  async storedPayload(bookId: number, user: RequestUser): Promise<BookKnowledgeXrayPayload> {
    const { fingerprint } = await this.knowledge.context(bookId, user, 'full', false);
    const path = this.payloadPath(bookId, fingerprint);
    const started = Date.now();
    try {
      return await readGzipJson<BookKnowledgeXrayPayload>(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('No X-Ray is stored for this book');
      this.logger.error(
        `[book_knowledge.xray_payload_read] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - stored X-Ray unreadable`,
      );
      throw new InternalServerErrorException('The stored X-Ray could not be read');
    }
  }

  private payloadPath(bookId: number, fingerprint: string): string {
    return join(dirname(this.knowledge.xrayUnitsPath(bookId, fingerprint)), PAYLOAD_FILE);
  }

  get(runId: string): BookKnowledgeXrayRun {
    const stored = this.runs.get(runId);
    if (!stored) throw new NotFoundException('X-Ray run not found');
    return stored.run;
  }

  payload(runId: string): BookKnowledgeXrayPayload {
    const stored = this.runs.get(runId);
    if (!stored?.payload) throw new NotFoundException('X-Ray payload not found');
    return stored.payload;
  }

  private keep(stored: StoredRun): void {
    this.runs.set(stored.run.runId, stored);
    while (this.runs.size > KEPT_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private async build(input: BuildInput): Promise<void> {
    const { run, stored } = input;
    const ids = `runId=${run.runId} bookId=${run.bookId}`;
    const started = Date.now();
    this.logger.log(
      `[book_knowledge.xray] [start] ${ids} through=${run.through} dryRun=${run.dryRun} fast=${sanitizeLogValue(input.fast.model)} fresh=${input.fresh} - X-Ray build started`,
    );
    const calls = new XrayRunCalls(stored.abort);
    const opened: { store: XrayUnitStore | null } = { store: null };
    try {
      const payload = await this.steps(input, ids, calls, opened);
      if (stored.abort.signal.aborted) throw new AiError('cancelled', CANCELLED);
      stored.payload = payload;
      if (payload && run.through >= fractionToOrdinal(input.artifact.sentences, 1)) await this.persist(run, input.fingerprint, payload, ids);
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      this.logger.log(
        `[book_knowledge.xray] [end] ${ids} durationMs=${Date.now() - started} entities=${payload?.entities.length ?? 0} ties=${payload?.ties.length ?? 0} links=${payload?.links.length ?? 0} summaries=${payload?.summaries?.length ?? 0} sentCharacters=${run.privacy.sentCharacters} bookCharacters=${run.privacy.bookCharacters} estimatedMinutes=${run.estimate?.minutes ?? 0} - X-Ray build completed`,
      );
    } catch (error) {
      const cancelled = run.error === CANCELLED;
      // The asks already launched stop, and none of their answers lands in the store a later run reads.
      stored.abort.abort();
      opened.store?.close();
      await calls.settled();
      await opened.store?.flush();
      run.status = 'failed';
      run.error = cancelled ? CANCELLED : error instanceof Error ? error.message : 'X-Ray build failed';
      run.finishedAt = new Date().toISOString();
      for (const step of run.steps) step.end ??= run.finishedAt;
      this.logger.error(
        `[book_knowledge.xray] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(run.error)}" - X-Ray build failed`,
      );
    }
  }

  private async steps(
    input: BuildInput,
    ids: string,
    calls: XrayRunCalls,
    opened: { store: XrayUnitStore | null },
  ): Promise<BookKnowledgeXrayPayload | null> {
    const { run, artifact, fingerprint, epubPath, fast, dryRun } = input;
    const through = run.through;
    const sentences = artifact.sentences;
    const text = await readBookText(epubPath);
    const anchors = new XrayAnchors(
      sentences.filter((sentence) => sentence.ordinal <= through),
      text.sections,
    );
    const store = dryRun ? null : await this.unitStore(input, ids);
    opened.store = store;
    const privacy = new XrayPrivacy(sentences);
    const syncPrivacy = () => {
      run.privacy.sentCharacters = privacy.sentCharacters;
      run.privacy.distinctSentences = privacy.sent.size;
      run.privacy.distinctCharacters = privacy.distinctCharacters();
    };
    const step = (id: BookKnowledgeXrayRun['steps'][number]['step']) => {
      const current = new XrayStepRun(id, 'fast', privacy, this.logger, ids, store ?? undefined);
      run.steps.push(current.record);
      this.logger.log(`[book_knowledge.xray_step] [start] ${ids} step=${id} slot=fast - step started`);
      return current;
    };
    const finish = (current: XrayStepRun) => {
      const record = current.finish();
      syncPrivacy();
      this.logger.log(
        `[book_knowledge.xray_step] [end] ${ids} step=${record.step} durationMs=${Date.parse(record.end!) - Date.parse(record.start)} units=${record.units} calls=${record.calls} invalid=${record.invalid} skipped=${record.skipped} replayed=${record.counts?.replayed ?? 0} sentences=${record.privacy.sentences} characters=${record.privacy.characters} - step completed`,
      );
    };
    // Upstream's usage page looks ledger job ids up in the uuid column of ai_jobs, so the ledger gets the bare uuid.
    const jobId = run.runId.slice(RUN_PREFIX.length);
    const gate = limiter(DENSE_CONCURRENCY);
    const ask: AskWith = (use, system, user, maxOutputTokens, effort = XRAY_EFFORT, temperature) => {
      const request = { system, user, maxOutputTokens, effort, ...(temperature === undefined ? {} : { temperature }) };
      const signal = calls.signal;
      return replayable(
        () =>
          calls.track(
            gate(() =>
              signal.aborted ? Promise.reject(new AiError('cancelled', CANCELLED)) : this.model.complete({ ...request, use, jobId, signal }),
            ),
          ),
        {
          ...request,
          model: use.model,
        },
      );
    };

    const mode = run.mode ?? 'fiction';
    const reviews = planKindReview(artifact, reviewCheckpoint(sentences, through), mode);
    const answers = dryRun ? new Map<string, KindAnswer>() : await this.reviewKinds(reviews, step('kinds'), fast, ask, finish);

    const dropped = { generic: 0, fragment: 0 };
    const entities = xrayEntities(artifact, through, answers, mode, undefined, dropped);
    const sections = bodySections(sentences, through);
    run.privacy.bookCharacters = sectionCharacters(sentences, sections);
    run.privacy.bookSentences = sections.reduce((sum, section) => sum + section.ordinals.length, 0);
    const units = passUnits(sentences, sections);
    const lastRead = sections.at(-1)?.s ?? -1;
    const full = fractionToOrdinal(sentences, 1);
    const counts: Record<string, number> = {
      entities: entities.length,
      kindBatches: reviews.length,
      units: units.length,
      linkCheckpoints: linkCheckpoints(sections).length,
      genericDropped: dropped.generic,
      fragmentDropped: dropped.fragment,
    };
    if (dryRun) {
      run.estimate = estimate(densePlannedCalls(reviews, units, entities, sentences, mode));
      run.counts = counts;
      return null;
    }

    const steps = {
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),
      now: step('now'),
      about: step('about'),
    };
    // A capped ask lowers the slot's own output limit, so upstream's client has no room to double into, and asks for no more than that.
    const dense: Ask = (request) => {
      const limit = request.capped ? Math.min(fast.maxOutputTokens ?? Infinity, request.maxOutputTokens) : request.maxOutputTokens;
      const send = ask(
        request.capped ? { ...fast, maxOutputTokens: limit } : fast,
        request.system,
        request.user,
        limit,
        request.effort,
        request.temperature,
      );
      return request.capped ? capped(send) : send;
    };
    const result = await runDense({
      entities,
      sentences,
      units,
      mode,
      ...steps,
      writesAbout: (slot: PassSlot) => slot.member === null && slot.head.importance <= 2,
      ask: dense,
      askAbout: dense,
    });
    for (const current of Object.values(steps)) finish(current);
    const links = windowLinks(result.cast, units, [...result.linkPairs, ...headingPairs(result.cast, sentences, units, mode)]);
    await store?.flush();
    if (store?.failedWrites)
      this.logger.warn(
        `[book_knowledge.xray_units] [fail] ${ids} durationMs=0 failedWrites=${store.failedWrites} errorClass=WriteError error="stored answers incomplete" - some answers were not stored`,
      );

    const parts = passPayload(result, mode, (ordinal) => anchors.at(ordinal), sentences);
    const spoilers = spoilerSweep(result.state, (unit) => namesAt(entities, unit.ordinals.at(-1)!));
    for (const spoiler of spoilers)
      this.logger.warn(
        `[book_knowledge.xray_spoiler] [fail] ${ids} field=${spoiler.field} id=${sanitizeLogValue(spoiler.id)} durationMs=0 errorClass=Spoiler error="${sanitizeLogValue(spoiler.names.join(', '))}" - text names a later entity`,
      );
    run.merges = result.cast.merges.map((merge) => ({
      rule: merge.rule,
      member: merge.member.name,
      head: merge.head.name,
      ordinal: merge.ordinal,
      mentions: merge.member.count,
      ...(merge.reason ? { reason: merge.reason } : {}),
    }));
    for (const merge of result.cast.merges)
      this.logger.log(
        `[book_knowledge.xray_merge] [end] ${ids} rule=${merge.rule} ordinal=${merge.ordinal} head="${sanitizeLogValue(merge.head.name)}" member="${sanitizeLogValue(merge.member.name)}"${merge.reason ? ` reason="${sanitizeLogValue(merge.reason)}"` : ''} - merged`,
      );
    const payload = xrayPayload(
      {
        fingerprint,
        builtAt: new Date().toISOString(),
        language: 'en',
        models: { fast: fast.model },
        coverage: Math.min(1, through / Math.max(1, full)),
        // A partial build names no section past the last one it read: a chapter title can give the story away.
        sections: text.sections.map((section): StoryGuideSectionInfo => ({
          s: section.index,
          title: through < full && section.index > lastRead ? null : (section.titles[0] ?? null),
          chars: section.text.length,
          h: section.hash,
        })),
        entities: parts.entities,
        ties: parts.ties,
        lines: parts.lines,
        facts: parts.facts,
        summaries: parts.summaries,
        links,
        chronicle: parts.chronicle,
        // A build that stops before the book's end says where; a skipped unit does not shorten it.
        ...(through < full && units.length ? { covers: unitEnd(units.at(-1)!, (ordinal) => anchors.at(ordinal)) } : {}),
      },
      (ordinal) => anchors.at(ordinal),
    );
    run.counts = {
      ...counts,
      ...stateCounts(result.state),
      heads: parts.entities.length,
      importance1: parts.entities.filter((entity) => entity.importance === 1).length,
      importance2: parts.entities.filter((entity) => entity.importance === 2).length,
      patternMerges: result.merged.pattern,
      modelMerges: result.merged.model,
      rewrites: result.rewrites,
      requiredKeys: result.required.keys,
      requiredFirst: result.required.first,
      requiredAfterRetry: result.required.retry,
      unitsWithSummary: new Set(result.state.summaries.map((summary) => summary.unit.id.split('c')[0])).size,
      spoilers: spoilers.length,
      payloadTies: payload.ties.length,
      links: payload.links.length,
      chronicleEntities: Object.keys(payload.chronicle?.entities ?? {}).length,
      chroniclePairs: Object.keys(payload.chronicle?.pairs ?? {}).length,
      anchorMisses: anchors.missed,
    };
    return payload;
  }

  /** A whole-book payload beside the book's artifact, so it outlives the run and goes when the book's text changes. */
  private async persist(run: BookKnowledgeXrayRun, fingerprint: string, payload: BookKnowledgeXrayPayload, ids: string): Promise<void> {
    const started = Date.now();
    try {
      await writeGzipJsonAtomic(this.payloadPath(run.bookId, fingerprint), payload);
      this.logger.log(`[book_knowledge.xray_payload] [end] ${ids} durationMs=${Date.now() - started} - X-Ray payload stored`);
    } catch (error) {
      this.logger.error(
        `[book_knowledge.xray_payload] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - X-Ray payload not stored`,
      );
    }
  }

  /** The book's stored answers for this model and prompt version; a fresh build starts the file over. */
  private async unitStore(input: BuildInput, ids: string): Promise<XrayUnitStore> {
    const started = Date.now();
    const path = this.knowledge.xrayUnitsPath(input.run.bookId, input.fingerprint);
    const store = new XrayUnitStore(path, { fingerprint: input.fingerprint, promptVersion: DENSE_PROMPT_VERSION, model: input.fast.model });
    if (input.fresh) await store.reset();
    const loaded = input.fresh ? 0 : await store.load();
    if (store.damaged)
      this.logger.warn(
        `[book_knowledge.xray_units] [fail] ${ids} durationMs=${Date.now() - started} errorClass=CorruptFile error="stored answers cut short" - stored answers damaged, the first write rewrites them`,
      );
    this.logger.log(
      `[book_knowledge.xray_units] [end] ${ids} durationMs=${Date.now() - started} fresh=${input.fresh} loaded=${loaded} stale=${store.stale} damaged=${store.damaged} - stored answers ready`,
    );
    return store;
  }

  /** The LLM kind review, before the cast is built; answers apply to the entries it was asked about. */
  private async reviewKinds(
    batches: readonly KindReviewBatch[],
    current: XrayStepRun,
    use: AiSlotChoice,
    ask: AskWith,
    finish: (current: XrayStepRun) => void,
  ): Promise<Map<string, KindAnswer>> {
    const answers = new Map<string, KindAnswer>();
    const found = await inOrder([...batches.entries()], DENSE_CONCURRENCY, ([index, batch]) =>
      current.unit({
        id: `k${index + 1}`,
        ordinals: batch.ordinals,
        send: ask(use, KIND_REVIEW_SYSTEM, batch.user, KIND_REVIEW_MAX_TOKENS, XRAY_EFFORT, CLASSIFY_TEMPERATURE),
        read: (value) => {
          const parsed = parseReviewAnswers(JSON.stringify(value), batch.keys);
          return parsed?.size ? { items: parsed, rejected: {} } : null;
        },
      }),
    );
    for (const batch of found) for (const [key, answer] of batch ?? []) answers.set(key, answer);
    finish(current);
    return answers;
  }
}
