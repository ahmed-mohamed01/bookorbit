import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BookKnowledgeXrayRun, BookKnowledgeXrayStep } from '@bookorbit/types';
import { AiError, type AiResult, type AiSlotChoice } from '../ai/ai-client.types';
import { AiJobFailure, AiJobPause } from '../ai-jobs/ai-feature';
import type { BookReadService } from '../book/book-read.service';
import { readBookText } from '../story-guides/text/book-text-reader';
import type { BookKnowledgeModelService, BookKnowledgeAiCall } from './book-knowledge-model.service';
import type { BookKnowledgeService } from './book-knowledge.service';
import { BK_COVERAGE_MIN_UNITS, BookKnowledgeXrayService, storyGuideCoverage, type XrayCompleter } from './book-knowledge-xray.service';
import { readEpubMetadata } from './core/epub-metadata';
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
const use: AiSlotChoice = { slot: 'fast', connectionId: 1, model: 'm', prices: null, jsonMode: 'none', maxOutputTokens: 4000 };
const jobInput = (complete: XrayCompleter, signal = new AbortController().signal) => ({ bookId: 7, fileId: 41, user, use, complete, signal });

describe('BookKnowledgeXrayService', () => {
  let dir: string;
  let artifact: Artifact;
  let complete: ReturnType<typeof vi.fn<(call: BookKnowledgeAiCall) => Promise<AiResult>>>;
  let knowledge: {
    context: ReturnType<typeof vi.fn<(...args: Parameters<BookKnowledgeService['context']>) => Promise<unknown>>>;
    xrayUnitsPath: ReturnType<typeof vi.fn<BookKnowledgeService['xrayUnitsPath']>>;
  };
  const findById = vi.fn();
  const unitsPath = () => join(dir, '7', FINGERPRINT, 'xray-units.jsonl.gz');

  const service = () =>
    new BookKnowledgeXrayService(
      knowledge as unknown as BookKnowledgeService,
      { findById } as unknown as BookReadService,
      {
        choice: vi.fn(() => Promise.resolve(use)),
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
    findById.mockReset();
    vi.mocked(readEpubMetadata).mockClear();
    dir = await mkdtemp(join(tmpdir(), 'bk-xray-service-'));
    artifact = artifactOf();
    complete = vi.fn(() => Promise.resolve(reply('{}')));
    knowledge = {
      context: vi.fn(() => Promise.resolve({ artifact, fingerprint: FINGERPRINT, file: { id: 41, format: 'epub', absolutePath: '/books/7.epub' } })),
      xrayUnitsPath: vi.fn((bookId: number, fingerprint: string) => join(dir, String(bookId), fingerprint, 'xray-units.jsonl.gz')),
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

  it.each([
    ['History', 'nonfiction'],
    ['Adventure', 'fiction'],
  ])('derives a MOBI build mode from the catalog subject %s', async (name, mode) => {
    const xray = service();
    knowledge.context.mockResolvedValue({ artifact, fingerprint: FINGERPRINT, file: { format: 'mobi', absolutePath: '/books/7.mobi' } });
    findById.mockResolvedValue({ genreRows: [{ name }] });
    const run = await finished(xray, await xray.start(7, user, { dryRun: true }));
    expect(run.mode).toBe(mode);
    expect(readBookText).toHaveBeenCalledWith('/books/7.mobi');
    expect(readEpubMetadata).not.toHaveBeenCalled();
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

  it('plans a whole-book estimate without calling the model completer or opening the unit store', async () => {
    const estimate = await service().planEstimate(7, user);

    expect(estimate).toMatchObject({ promptTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(estimate.promptTokens).toBeGreaterThan(0);
    expect(knowledge.context).toHaveBeenCalledWith(7, user, 'full', true);
    expect(complete).not.toHaveBeenCalled();
    expect(knowledge.xrayUnitsPath).not.toHaveBeenCalled();
  });

  it('plans while a bench build holds the build slot', async () => {
    const benchReply = Promise.withResolvers<AiResult>();
    complete.mockImplementationOnce(() => benchReply.promise);
    const xray = service();
    const bench = await xray.start(7, user);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    try {
      await expect(xray.planEstimate(7, user)).resolves.toMatchObject({ promptTokens: expect.any(Number) });
      expect(xray.get(bench.runId).status).toBe('running');
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      benchReply.resolve(reply('{}'));
      await finished(xray, bench);
    }
  });

  it('keeps a whole-book bench payload in memory', async () => {
    const xray = service();
    const run = await finished(xray, await xray.start(7, user));

    expect(run.status).toBe('done');
    expect(xray.payload(run.runId)).toMatchObject({ coverage: 1 });
    expect(() => service().payload(run.runId)).toThrow(NotFoundException);
    expect(await readdir(join(dir, '7', FINGERPRINT)).catch(() => [])).not.toContain('xray-payload.json.gz');
  });

  it('names no section past the last one a partial build read', async () => {
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { through: 12 }));
    const payload = xray.payload(run.runId);
    expect(payload.sections.map((section) => section.title)).toEqual(['The Mill', null]);
    expect(JSON.stringify(payload)).not.toContain(SECRET_TITLE);
  });

  it('buildForStoryGuide sends every ask through the given completer', async () => {
    const jobComplete = vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'));
    const jobChoice = { ...use, model: 'job-model' };
    const payload = await service().buildForStoryGuide({ ...jobInput(jobComplete), use: jobChoice });
    expect(payload).toMatchObject({ textKey: `bk:${FINGERPRINT}`, coverage: 1, models: { fast: jobChoice.model } });
    expect(complete).not.toHaveBeenCalled();
    expect(jobComplete).toHaveBeenCalledWith(expect.objectContaining({ use: jobChoice, maxOutputTokens: expect.any(Number) }));
    expect(jobComplete.mock.calls.every(([request]) => request.use.model === jobChoice.model)).toBe(true);
    expect(jobComplete.mock.calls.some(([request]) => request.use.maxOutputTokens === request.maxOutputTokens)).toBe(true);
    expect(await readdir(join(dir, '7', FINGERPRINT)).catch(() => [])).not.toContain('xray-payload.json.gz');
  });

  it('buildForStoryGuide reports kinds, alias, each dense unit and finish in order', async () => {
    const stages: [string, number, number][] = [];
    const withProgress = vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'));
    await service().buildForStoryGuide({ ...jobInput(withProgress), onProgress: (stage, done, total) => stages.push([stage, done, total]) });
    const kinds = stages.filter(([stage]) => stage === 'kinds');
    expect(kinds[0][1]).toBe(0);
    expect(kinds.map(([, done]) => done)).toEqual(kinds.map((_, index) => index));
    expect(kinds.at(-1)![1]).toBe(kinds[0][2]);
    const dense = stages.filter(([stage]) => stage === 'dense');
    const units = dense[0][2];
    expect(units).toBeGreaterThan(0);
    expect(dense).toEqual(Array.from({ length: units + 1 }, (_, done) => ['dense', done, units]));
    expect(stages.map(([stage]) => stage).filter((stage, index, all) => stage !== all[index - 1])).toEqual(['kinds', 'alias', 'dense', 'finish']);
  });

  it('planEstimate reports no progress', async () => {
    const xray = service();
    const spy = vi.spyOn(xray as never as { steps: (input: { onProgress?: unknown }) => unknown }, 'steps');
    await xray.planEstimate(7, user);
    expect(spy.mock.calls[0][0].onProgress).toBeUndefined();
  });

  it.each([
    ['AiJobPause', new AiJobPause('over-estimate')],
    ['provider-down AiError', new AiError('provider-down', 'provider down')],
  ])('buildForStoryGuide rethrows %s from the completer and writes nothing', async (_name, pause) => {
    const pending = Promise.withResolvers<AiResult>();
    const pausing = Promise.withResolvers<AiResult>();
    const jobComplete = vi
      .fn<XrayCompleter>()
      .mockResolvedValueOnce(reply('{}'))
      .mockResolvedValueOnce(reply('{}'))
      .mockImplementationOnce(() => pausing.promise)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(reply('{}'));
    const xray = service();
    const build = xray.buildForStoryGuide(jobInput(jobComplete));
    const settled = vi.fn();
    void build.catch(settled);
    await vi.waitFor(() => expect(jobComplete.mock.calls.length).toBeGreaterThanOrEqual(4));
    pausing.reject(pause);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    await expect(xray.start(7, user)).rejects.toBeInstanceOf(ConflictException);
    pending.resolve(reply('{"notes": {}, "summary": "Viv walks.", "identity": []}'));
    await expect(build).rejects.toBe(pause);
    const stored = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: use.model });
    expect(await stored.load()).toBe(0);
  });

  it('buildForStoryGuide waits for a running bench build instead of throwing', async () => {
    const benchReply = Promise.withResolvers<AiResult>();
    const jobReply = Promise.withResolvers<AiResult>();
    complete.mockImplementationOnce(() => benchReply.promise);
    const jobComplete = vi
      .fn<XrayCompleter>()
      .mockImplementationOnce(() => jobReply.promise)
      .mockResolvedValue(reply('{}'));
    const xray = service();
    const bench = await xray.start(7, user);
    const build = xray.buildForStoryGuide(jobInput(jobComplete));
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(jobComplete).not.toHaveBeenCalled();
    benchReply.resolve(reply('{}'));
    await vi.waitFor(() => expect(jobComplete).toHaveBeenCalled());
    expect(xray.get(bench.runId).status).toBe('done');
    await expect(xray.start(7, user)).rejects.toBeInstanceOf(ConflictException);
    jobReply.resolve(reply('{}'));
    await expect(build).resolves.toMatchObject({ coverage: 1 });
  });

  it('buildForStoryGuide stops on abort', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Job cancelled', 'AbortError');
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(() => {
      controller.abort(reason);
      return Promise.resolve(reply('{}'));
    });
    await expect(service().buildForStoryGuide(jobInput(jobComplete, controller.signal))).rejects.toBe(reason);
    expect(jobComplete).toHaveBeenCalledTimes(1);
  });

  it('buildForStoryGuide replays successful unit answers on a later build', async () => {
    const answered = new Set<string>();
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(({ user }) => {
      if (!user.includes('notes: an object keyed by id')) return Promise.resolve(reply('{}'));
      answered.add(user);
      return Promise.resolve(reply('{"notes": {}, "summary": "Viv walks."}'));
    });
    const xray = service();
    await xray.buildForStoryGuide(jobInput(jobComplete));
    expect(answered.size).toBeGreaterThan(0);
    const store = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: use.model });
    expect(await store.load()).toBeGreaterThan(0);
    const second = vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'));
    await xray.buildForStoryGuide(jobInput(second));
    expect(second.mock.calls.some(([request]) => answered.has(request.user))).toBe(false);
  });

  it('buildForStoryGuide replays within one replay scope and asks again under another', async () => {
    const notes = ({ user }: { user: string }) => user.includes('notes: an object keyed by id');
    const answer = vi
      .fn<XrayCompleter>()
      .mockImplementation((request) => Promise.resolve(reply(notes(request) ? '{"notes": {}, "summary": "Viv walks."}' : '{}')));
    const xray = service();
    await xray.buildForStoryGuide({ ...jobInput(answer), replayScope: '1' });
    const asked = answer.mock.calls.filter(([request]) => notes(request)).length;
    expect(asked).toBeGreaterThan(0);

    const same = vi.fn<XrayCompleter>().mockImplementation(answer);
    await xray.buildForStoryGuide({ ...jobInput(same), replayScope: '1' });
    expect(same.mock.calls.filter(([request]) => notes(request))).toHaveLength(0);

    const rebuilt = vi.fn<XrayCompleter>().mockImplementation(answer);
    await xray.buildForStoryGuide({ ...jobInput(rebuilt), replayScope: '2' });
    expect(rebuilt.mock.calls.filter(([request]) => notes(request))).toHaveLength(asked);
  });

  it('buildForStoryGuide fails as unreadable without a model call when the main file changed', async () => {
    knowledge.context.mockResolvedValue({ artifact, fingerprint: FINGERPRINT, file: { id: 99, format: 'epub', absolutePath: '/books/7b.epub' } });
    const jobComplete = vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'));
    await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason: 'unreadable' });
    expect(jobComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['unreadable', 99],
    ['error', 41],
  ])('buildForStoryGuide fails as %s for an unready index on file %s', async (reason, id) => {
    knowledge.context.mockImplementation((_bookId, _user, _scope, required = true) => {
      if (required) return Promise.reject(new ConflictException('Book Knowledge is not ready'));
      return Promise.resolve({ artifact: undefined, fingerprint: FINGERPRINT, file: { id, format: 'epub', absolutePath: '/books/7.epub' } });
    });
    const jobComplete = vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'));
    await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason });
    expect(knowledge.context).toHaveBeenCalledWith(7, user, 'full', false);
    expect(jobComplete).not.toHaveBeenCalled();
  });

  it('reports the source error as unreadable for a job and preserves it for bench builds and plans', async () => {
    const error = new BadRequestException('Book Knowledge cannot read the source file');
    knowledge.context.mockRejectedValue(error);
    const jobComplete = vi.fn<XrayCompleter>();
    const xray = service();
    await expect(xray.buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason: 'unreadable', message: error.message });
    expect(jobComplete).not.toHaveBeenCalled();
    await expect(xray.start(7, user)).rejects.toBe(error);
    await expect(xray.planEstimate(7, user)).rejects.toBe(error);
  });

  it('buildForStoryGuide lowers the payload coverage to the answered share of a counted step', async () => {
    const xray = service();
    const real = (xray as never as { steps: (...args: unknown[]) => Promise<unknown> }).steps.bind(xray);
    vi.spyOn(xray as never as { steps: (...args: unknown[]) => Promise<unknown> }, 'steps').mockImplementation(async (...args) => {
      const payload = await real(...args);
      (args[0] as { run: BookKnowledgeXrayRun }).run.steps.push(step('describe', 20, 6));
      return payload;
    });
    const payload = await xray.buildForStoryGuide(jobInput(vi.fn<XrayCompleter>().mockResolvedValue(reply('{}'))));
    expect(payload.coverage).toBe(0.7);
  });

  it('keeps an error log out of a paused or cancelled story guide build', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const pausing = vi.fn<XrayCompleter>().mockRejectedValue(new AiJobPause('over-estimate'));
    await expect(service().buildForStoryGuide(jobInput(pausing))).rejects.toBeInstanceOf(AiJobPause);
    const controller = new AbortController();
    const cancelling = vi.fn<XrayCompleter>().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(reply('{}'));
    });
    await expect(service().buildForStoryGuide(jobInput(cancelling, controller.signal))).rejects.toBeDefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('buildForStoryGuide preserves AiJobFailure and wraps unexpected errors', async () => {
    const failure = new AiJobFailure('error', 'job failed');
    const jobComplete = vi.fn<XrayCompleter>().mockRejectedValueOnce(failure).mockRejectedValue(new Error('file unreadable'));
    const xray = service();
    await expect(xray.buildForStoryGuide(jobInput(jobComplete))).rejects.toBe(failure);
    await expect(xray.buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason: 'error', message: 'file unreadable' });
  });
});

function step(id: BookKnowledgeXrayStep['step'], units: number, skipped: number): BookKnowledgeXrayStep {
  return {
    step: id,
    slot: 'fast',
    units,
    calls: units,
    invalid: skipped,
    skipped,
    rejected: {},
    privacy: { calls: 0, sentences: 0, characters: 0, sections: 0 },
    start: '',
    end: '',
  };
}

describe('storyGuideCoverage', () => {
  it('is the lowest answered share over the counted steps', () => {
    expect(storyGuideCoverage([step('notes', 20, 2), step('facts', 40, 8), step('describe', 10, 0)])).toBe(0.8);
  });

  it('counts a refused or filtered unit, which is skipped after one try, against coverage', () => {
    expect(storyGuideCoverage([step('notes', 10, 3)])).toBe(0.7);
  });

  it(`leaves out a step under ${BK_COVERAGE_MIN_UNITS} units`, () => {
    expect(storyGuideCoverage([step('kinds', BK_COVERAGE_MIN_UNITS - 1, 4)])).toBe(1);
  });

  it('leaves out alias, now and about, whose empty results are normal', () => {
    expect(storyGuideCoverage(['alias', 'now', 'about'].map((id) => step(id as BookKnowledgeXrayStep['step'], 20, 20)))).toBe(1);
  });

  it('passes a ties step whose units mostly returned valid empty replies, and fails one with more than 10% skipped', () => {
    // Empty but valid replies are answered units, so only skipped units count against coverage.
    expect(storyGuideCoverage([step('ties', 30, 0)])).toBe(1);
    expect(storyGuideCoverage([step('ties', 30, 3)])).toBeGreaterThanOrEqual(0.9);
    expect(storyGuideCoverage([step('ties', 30, 4)])).toBeLessThan(0.9);
  });
});
