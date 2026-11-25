import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BookKnowledgeXrayRun } from '@bookorbit/types';
import { AiError, type AiResult } from '../ai/ai-client.types';
import type { BookReadService } from '../book/book-read.service';
import { readBookText } from '../story-guides/text/book-text-reader';
import type { BookKnowledgeModelService, BookKnowledgeAiCall } from './book-knowledge-model.service';
import type { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeXrayService } from './book-knowledge-xray.service';
import { KIND_REVIEW_SYSTEM } from './core/kind-review';
import type { Artifact, Sentence } from './core/model';
import { extractAliasLinks, extractTerms } from './core/term-extractor';
import { DENSE_PROMPT_VERSION } from './xray/dense/dense-prompt';
import { XrayUnitStore } from './xray/xray-unit-store';

vi.mock('../story-guides/text/book-text-reader', () => ({ readBookText: vi.fn() }));
vi.mock('./core/epub-metadata', () => ({ readEpubMetadata: vi.fn(() => Promise.resolve({ subjects: [] })) }));

const FINGERPRINT = 'f'.repeat(64);
const SECRET_TITLE = 'The Queen Was Her Mother';

function sentencesOf(): Sentence[] {
  const lines = [
    ...Array.from({ length: 12 }, (_, index) => [`Viv walked with Solfis past the mill ${index}.`, 0] as const),
    ...Array.from({ length: 12 }, (_, index) => [`Solfis spoke to Viv near Harrow ${index}.`, 1] as const),
  ];
  return lines.map(([text, spineIndex], index) => ({
    ordinal: index + 1,
    spineIndex,
    paragraphIndex: index,
    href: `s${spineIndex}.xhtml`,
    text,
    structure: 'body',
    heading: false,
    emphasis: [],
  }));
}

function artifactOf(): Artifact {
  const sentences = sentencesOf();
  const terms = extractTerms(sentences);
  return {
    formatVersion: 3,
    textVersion: 1,
    termsVersion: 1,
    fingerprint: FINGERPRINT,
    seeds: [],
    sentences,
    terms,
    aliasLinks: extractAliasLinks(sentences, terms),
  };
}

const reply = (text: string): AiResult => ({ text, usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' });
const user = { id: 1 } as never;

describe('BookKnowledgeXrayService', () => {
  let dir: string;
  let artifact: Artifact;
  let complete: ReturnType<typeof vi.fn<(call: BookKnowledgeAiCall) => Promise<AiResult>>>;
  let knowledge: { context: ReturnType<typeof vi.fn>; xrayUnitsPath: (bookId: number, fingerprint: string) => string };
  const unitsPath = () => join(dir, '7', FINGERPRINT, 'xray-units.jsonl.gz');

  const service = () =>
    new BookKnowledgeXrayService(
      knowledge as unknown as BookKnowledgeService,
      { knowledgeEpubFiles: vi.fn(() => Promise.resolve([{ absolutePath: '/books/7.epub' }])) } as unknown as BookReadService,
      {
        choice: vi.fn(() => Promise.resolve({ slot: 'fast', connectionId: 1, model: 'm', prices: null, jsonMode: 'none', maxOutputTokens: 4000 })),
        complete,
      } as unknown as BookKnowledgeModelService,
    );
  const finished = async (xray: BookKnowledgeXrayService, run: BookKnowledgeXrayRun) => {
    await vi.waitFor(() => expect(xray.get(run.runId).finishedAt).not.toBeNull(), { timeout: 5000 });
    return xray.get(run.runId);
  };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), 'bk-xray-service-'));
    artifact = artifactOf();
    complete = vi.fn(() => Promise.resolve(reply('{}')));
    knowledge = {
      context: vi.fn(() => Promise.resolve({ artifact, fingerprint: FINGERPRINT })),
      xrayUnitsPath: (bookId, fingerprint) => join(dir, String(bookId), fingerprint, 'xray-units.jsonl.gz'),
    };
    vi.mocked(readBookText).mockResolvedValue({
      kind: 'epub',
      languages: ['en'],
      sections: [0, 1].map((index) => ({
        index,
        linear: true,
        titles: [index === 0 ? 'The Mill' : SECRET_TITLE],
        text: artifact.sentences
          .filter((sentence) => sentence.spineIndex === index)
          .map((sentence) => sentence.text)
          .join(' '),
        blocks: [0],
        hash: `h${index}`,
        error: null,
      })),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a second build started in the same moment', async () => {
    const xray = service();
    const [first, second] = await Promise.allSettled([xray.start(7, user), xray.start(7, user)]);
    expect(first.status).toBe('fulfilled');
    expect(second.status === 'rejected' && second.reason).toBeInstanceOf(ConflictException);
    await finished(xray, (first as PromiseFulfilledResult<BookKnowledgeXrayRun>).value);
  });

  it('frees the guard when setting a build up fails', async () => {
    const xray = service();
    knowledge.context.mockRejectedValueOnce(new NotFoundException());
    await expect(xray.start(7, user)).rejects.toBeInstanceOf(NotFoundException);
    await finished(xray, await xray.start(7, user));
  });

  it('stops every call of a failed build and stores none of their answers', async () => {
    let failedAt = 0;
    const startedAfter: string[] = [];
    const signals: AbortSignal[] = [];
    complete.mockImplementation((call) => {
      if (call.system === KIND_REVIEW_SYSTEM) return Promise.resolve(reply('{}'));
      if (failedAt) startedAfter.push(call.user.slice(0, 20));
      signals.push(call.signal!);
      if (signals.length === 1)
        return new Promise((_, reject) =>
          setTimeout(() => {
            failedAt = Date.now();
            reject(new AiError('provider-down', 'provider down'));
          }, 5),
        );
      return new Promise((resolve) => setTimeout(() => resolve(reply('{"notes": {}, "summary": "Viv walks.", "identity": []}')), 40));
    });
    const xray = service();
    const run = await finished(xray, await xray.start(7, user));
    expect(run).toMatchObject({ status: 'failed', error: 'provider down' });
    expect(startedAfter).toEqual([]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const stored = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: 'm' });
    expect(await stored.load()).toBe(0);
    expect(await readdir(join(dir, '7', FINGERPRINT)).catch(() => [])).not.toContain('xray-payload.json.gz');
  });

  it('cancels a running build: its calls are aborted and the run is failed as cancelled', async () => {
    complete.mockImplementation((call) =>
      call.system === KIND_REVIEW_SYSTEM
        ? Promise.resolve(reply('{}'))
        : new Promise((_, reject) => call.signal!.addEventListener('abort', () => reject(new AiError('cancelled', 'aborted')))),
    );
    const xray = service();
    const started = await xray.start(7, user);
    await vi.waitFor(() => expect(complete.mock.calls.some(([call]) => call.system !== KIND_REVIEW_SYSTEM)).toBe(true));
    expect(xray.cancel(started.runId)).toMatchObject({ status: 'failed', error: 'cancelled' });
    const run = await finished(xray, started);
    expect(run).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(complete.mock.calls.every(([call]) => call.system === KIND_REVIEW_SYSTEM || call.signal?.aborted)).toBe(true);
    complete.mockImplementation(() => Promise.resolve(reply('{}')));
    await finished(xray, await xray.start(7, user));
  });

  it('asks a capped request for no more than the slot allows', async () => {
    const xray = service();
    await finished(xray, await xray.start(7, user));
    const capped = complete.mock.calls.map(([call]) => call).filter((call) => call.use.maxOutputTokens !== 4000);
    expect(capped.length).toBeGreaterThan(0);
    for (const call of capped) expect(call.maxOutputTokens).toBeLessThanOrEqual(call.use.maxOutputTokens!);
  });

  it('stores a whole-book payload that the reader route returns after a restart, and nothing for a partial build', async () => {
    const xray = service();
    const run = await finished(xray, await xray.start(7, user));
    expect(run.status).toBe('done');
    const restarted = service();
    expect(await restarted.storedPayload(7, user)).toEqual(xray.payload(run.runId));
    expect(knowledge.context).toHaveBeenLastCalledWith(7, user, 'full', false);

    knowledge.context.mockRejectedValueOnce(new NotFoundException());
    await expect(restarted.storedPayload(7, user)).rejects.toBeInstanceOf(NotFoundException);

    await rm(join(dir, '7'), { recursive: true, force: true });
    const partial = await finished(restarted, await restarted.start(7, user, { through: 12 }));
    expect(partial.status).toBe('done');
    await expect(restarted.storedPayload(7, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('names no section past the last one a partial build read', async () => {
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { through: 12 }));
    const payload = xray.payload(run.runId);
    expect(payload.sections.map((section) => section.title)).toEqual(['The Mill', null]);
    expect(JSON.stringify(payload)).not.toContain(SECRET_TITLE);
  });
});
