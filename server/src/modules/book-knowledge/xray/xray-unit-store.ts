import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createGunzip, gzipSync } from 'node:zlib';
import type { AiResult } from '../../ai/ai-client.types';
import type { Rejections } from './xray-checks';

/** What a stored answer must match to be replayed: the same book text, the same prompts and the same model. */
export interface XrayUnitScope {
  fingerprint: string;
  promptVersion: number;
  model: string;
}

export interface StoredXrayUnit extends XrayUnitScope {
  step: string;
  unit: string;
  /** Hash of the exact request, so an answer is only replayed to the prompt it was given for. */
  request: string;
  answer: unknown;
  rejected: Rejections;
}

/**
 * A send tagged with the hash of its request, which the step runner uses to look up and store the answer. `capped`: its
 * output limit is a hard cap, so a reply cut short is not sent again unchanged.
 */
export type ReplayableSend = (() => Promise<AiResult>) & { replayRequest?: string; capped?: true };

export function requestHash(request: object): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function replayable(send: () => Promise<AiResult>, request: object): ReplayableSend {
  return Object.assign(send, { replayRequest: requestHash(request) });
}

export interface XrayReplay {
  answer(step: string, unit: string, request: string): unknown;
  save(step: string, unit: string, request: string, answer: unknown, rejected: Rejections): void;
}

const keyOf = (step: string, unit: string, request: string) => `${step}\u0000${unit}\u0000${request}`;

/** An answer kept in memory: the scope is the store's and the step, unit and request are its key, so only these stay per line. */
interface KeptAnswer {
  answer: unknown;
  rejected: Rejections;
}

/**
 * A build's finished model answers as gzip JSONL beside the book's artifact, one gzip member per line so a
 * line is appended without rewriting the file. A later build of the same book, prompts and model replays them.
 */
export class XrayUnitStore implements XrayReplay {
  private readonly kept = new Map<string, KeptAnswer>();
  private writing: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  stale = 0;
  /** The file stopped decoding before its end, so appending after it would leave every later line unreadable. */
  damaged = false;
  failedWrites = 0;

  constructor(
    private readonly path: string,
    private readonly scope: XrayUnitScope,
  ) {}

  /**
   * Streams the file, keeping only this scope's answers; a corrupt or cut line is skipped. A file that stops decoding
   * (a cut gzip member from a killed build) marks the store damaged, so its first write rewrites the file without the tail.
   */
  async load(): Promise<number> {
    const source = createReadStream(this.path);
    const gunzip = createGunzip();
    source.on('error', (error) => gunzip.destroy(error));
    source.pipe(gunzip);
    // Decoded by the stream, so a character split across two chunks is joined before the line is read.
    gunzip.setEncoding('utf8');
    let rest = '';
    try {
      for await (const chunk of gunzip as AsyncIterable<string>) {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) this.take(line);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      this.damaged = true;
    }
    return this.kept.size;
  }

  private take(line: string): void {
    let entry: StoredXrayUnit;
    try {
      entry = JSON.parse(line) as StoredXrayUnit;
    } catch {
      return;
    }
    const { fingerprint, promptVersion, model } = this.scope;
    if (entry?.fingerprint !== fingerprint || entry.promptVersion !== promptVersion || entry.model !== model) {
      this.stale++;
      return;
    }
    this.kept.set(keyOf(entry.step, entry.unit, entry.request), { answer: entry.answer, rejected: entry.rejected ?? {} });
  }

  answer(step: string, unit: string, request: string): unknown {
    return this.kept.get(keyOf(step, unit, request))?.answer;
  }

  save(step: string, unit: string, request: string, answer: unknown, rejected: Rejections): void {
    if (this.closed) return;
    const entry: StoredXrayUnit = { ...this.scope, step, unit, request, answer, rejected };
    this.kept.set(keyOf(step, unit, request), { answer, rejected });
    this.writing = this.writing
      .then(() => this.write(entry))
      .catch(() => {
        this.failedWrites++;
      });
  }

  /** Ends the build's writes: a call still in flight when the build stops stores nothing. */
  close(): void {
    this.closed = true;
  }

  /** Waits for the pending appends. */
  async flush(): Promise<void> {
    await this.writing;
  }

  private async write(entry: StoredXrayUnit): Promise<void> {
    const line = gzipSync(`${JSON.stringify(entry)}\n`);
    if (this.started) return appendFile(this.path, line);
    this.started = true;
    await mkdir(dirname(this.path), { recursive: true });
    // The first write of a build drops answers from older prompts or models, so the file does not grow with every version.
    if (!this.stale && !this.damaged) return appendFile(this.path, line);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const lines = [...this.kept].map(([key, kept]) => {
        const [step, unit, request] = key.split('\u0000');
        const stored: StoredXrayUnit = { ...this.scope, step, unit, request, ...kept };
        return gzipSync(`${JSON.stringify(stored)}\n`);
      });
      await writeFile(temporary, Buffer.concat(lines));
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** A fresh build ignores what is stored and starts the file over. */
  async reset(): Promise<void> {
    this.kept.clear();
    this.stale = 0;
    this.damaged = false;
    this.started = true;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, Buffer.alloc(0));
  }
}
