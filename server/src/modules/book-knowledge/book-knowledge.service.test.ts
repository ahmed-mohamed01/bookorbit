import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageConfig } from '../../config/config';
import { bookKnowledgeConfig } from './book-knowledge.config';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { BookReadService } from '../book/book-read.service';
import { BOOK_TOO_LONG_ERROR, BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import { BookKnowledgeTermsService } from './book-knowledge-terms.service';
import { BookKnowledgeKindsService } from './book-knowledge-kinds.service';
import { BookKnowledgeCardService } from './book-knowledge-card.service';
import { BookKnowledgeAskService } from './book-knowledge-ask.service';
import { BookKnowledgeModelService } from './book-knowledge-model.service';
import * as artifactIO from './core/artifact';
import { ArtifactTooLargeError, artifactPath, writeArtifact } from './core/artifact';
import * as pipeline from './core/build-pipeline';
import { ARTIFACT_VERSION, TEXT_VERSION, TERMS_VERSION } from './core/versions';
import type { Artifact, Term } from './core/model';
import { retrieve } from './book-knowledge-retrieval';
import * as retrieval from './book-knowledge-retrieval';
import { answerPrompt, ANSWER_SCHEMA } from './book-knowledge-prompts';
const EPUB_BYTES = 'invented epub bytes';
const fingerprintOf = (identity: string) => createHash('sha256').update(identity).digest('hex');
const fingerprint = fingerprintOf(`stored-file-hash:${EPUB_BYTES.length}`);
vi.mock('./core/build-pipeline', async (original) => ({ ...(await original<typeof import('./core/build-pipeline')>()), buildArtifact: vi.fn() }));
const makeTerm = (key: string, ordinal: number): Term => ({
  key,
  rarity: 1,
  wordCount: 2,
  deltas: [ordinal],
  features: [{ alias: key, definition: false, capitalized: false, person: false, place: false, nested: false, structural: false, noun: true }],
});
function fixture(): Artifact {
  return {
    formatVersion: ARTIFACT_VERSION,
    textVersion: TEXT_VERSION,
    termsVersion: TERMS_VERSION,
    fingerprint,
    seeds: [],
    aliasLinks: [],
    sentences: Array.from({ length: 40 }, (_, i) => ({
      ordinal: i + 1,
      spineIndex: i < 20 ? 0 : 1,
      paragraphIndex: i,
      href: 'body.xhtml',
      text: i < 20 ? 'Lumen lattice stores echoes.' : 'Hidden prism changes echoes.',
      structure: 'body',
      heading: false,
      emphasis: [],
    })),
    terms: [makeTerm('lumen lattice', 1), makeTerm('hidden prism', 30)],
  };
}
describe('Book Knowledge access and cut-offs', () => {
  let directory: string;
  let knowledge: BookKnowledgeService;
  let terms: BookKnowledgeTermsService;
  let cards: BookKnowledgeCardService;
  let questions: BookKnowledgeAskService;
  const user = { id: 7 } as RequestUser;
  const books = { verifyBookAccess: vi.fn() };
  const read = { knowledgeEpubFiles: vi.fn(), findProgressByBook: vi.fn() };
  const repo = {
    state: vi.fn(),
    resume: vi.fn(),
    next: vi.fn(),
    update: vi.fn(),
    cleanupIds: vi.fn(),
    cleanupDone: vi.fn(),
    enqueueCleanup: vi.fn(),
    queue: vi.fn(),
    cached: vi.fn(),
    cache: vi.fn(),
    kindReviews: vi.fn(),
    saveKindReview: vi.fn(),
  };
  const model = { generate: vi.fn(), chat: vi.fn(), choice: vi.fn(), choiceWithSnapshot: vi.fn(), checkReaderCap: vi.fn(), configured: vi.fn() };
  const hangUp = () => new AbortController().signal;
  const useModel = () => {
    model.choice.mockResolvedValue(choice);
    model.choiceWithSnapshot.mockResolvedValue({ choice, snapshot: {} });
  };
  const settings = { get: vi.fn(), enabled: vi.fn() };
  const choice = { slot: 'fast', connectionId: 1, model: 'fixture', prices: null, jsonMode: 'auto' };
  beforeEach(async () => {
    vi.resetAllMocks();
    model.choice.mockResolvedValue(null);
    model.choiceWithSnapshot.mockResolvedValue(null);
    model.configured.mockResolvedValue(false);
    settings.enabled.mockResolvedValue(true);
    directory = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    await writeArtifact(artifactPath(directory, 3, fingerprint), fixture());
    await writeFile(join(directory, 'book.epub'), EPUB_BYTES);
    books.verifyBookAccess.mockResolvedValue(undefined);
    read.knowledgeEpubFiles.mockResolvedValue([{ id: 9, absolutePath: join(directory, 'book.epub'), fileHash: 'stored-file-hash' }]);
    read.findProgressByBook.mockImplementation((userId: number) => Promise.resolve([{ fileId: 9, percentage: userId === 7 ? 50 : 0 }]));
    repo.state.mockResolvedValue({
      bookId: 3,
      fingerprint,
      textVersion: TEXT_VERSION,
      termsVersion: TERMS_VERSION,
      status: 'ready',
      progress: 100,
      error: null,
    });
    repo.cleanupIds.mockResolvedValue([]);
    repo.kindReviews.mockResolvedValue([]);
    model.chat.mockResolvedValue('{}');
    const module = await Test.createTestingModule({
      providers: [
        BookKnowledgeService,
        BookKnowledgeTermsService,
        BookKnowledgeKindsService,
        BookKnowledgeCardService,
        BookKnowledgeAskService,
        { provide: BookService, useValue: books },
        { provide: BookReadService, useValue: read },
        { provide: BookKnowledgeRepository, useValue: repo },
        {
          provide: BookKnowledgeSettingsService,
          useValue: settings,
        },
        { provide: BookKnowledgeModelService, useValue: model },
        { provide: storageConfig.KEY, useValue: { appDataPath: directory } },
        { provide: bookKnowledgeConfig.KEY, useValue: { glinerThreads: 2 } },
      ],
    }).compile();
    knowledge = module.get(BookKnowledgeService);
    terms = module.get(BookKnowledgeTermsService);
    cards = module.get(BookKnowledgeCardService);
    questions = module.get(BookKnowledgeAskService);
  });
  afterEach(async () => {
    knowledge.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });
  const listQuery = { scope: 'position' as const, limit: 50, offset: 0 };
  it.each([403, 404])('preserves book access errors %s on every book operation', async (status) => {
    books.verifyBookAccess.mockRejectedValue(status === 403 ? new ForbiddenException() : new NotFoundException());
    for (const operation of [
      () => knowledge.status(3, user),
      () => knowledge.build(3, user),
      () => terms.list(3, user, listQuery),
      () => terms.detail(3, user, 'lumen lattice', 'position'),
      () => cards.card(3, user, 'lumen lattice', 'position', hangUp()),
      () => questions.ask(3, user, 'echoes?', 'position', hangUp()),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status });
    }
    expect(read.knowledgeEpubFiles).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });
  it('coalesces cold loads and clears rejected pending loads', async () => {
    const load = vi.spyOn(artifactIO, 'readArtifact');
    await Promise.all([knowledge.context(3, user), knowledge.context(3, user)]);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockRestore();
  });
  it('allows another cold load after failure', async () => {
    const load = vi.spyOn(artifactIO, 'readArtifact').mockRejectedValueOnce(new Error('invented failure'));
    await expect(knowledge.context(3, user)).rejects.toMatchObject({ status: 409 });
    await expect(knowledge.context(3, user)).resolves.toHaveProperty('artifact');
    expect(load).toHaveBeenCalledTimes(2);
    load.mockRestore();
  });
  it('uses the selected EPUB current position per user and requires explicit full scope', async () => {
    const status = await knowledge.status(3, user);
    expect(status.scope).toBe('position');
    expect(status.cutoffOrdinal).toBeLessThan(30);
    expect(status).not.toHaveProperty('termCount');
    const list = await terms.list(3, user, listQuery);
    expect(list.total).toBe(1);
    expect(list.items.map((t) => t.key)).toEqual(['lumen lattice']);
    expect((await terms.list(3, user, { ...listQuery, scope: 'full' })).items.map((t) => t.key)).toContain('hidden prism');
    expect((await knowledge.status(3, { id: 8 } as RequestUser)).noProgress).toBe(true);
    expect((await terms.list(3, { id: 8 } as RequestUser, listQuery)).items).toEqual([]);
  });
  it('returns identical 404 responses for invisible and absent terms, including cards', async () => {
    const results: unknown[] = [];
    for (const key of ['hidden prism', 'missing term']) {
      for (const operation of [() => terms.detail(3, user, key, 'position'), () => cards.card(3, user, key, 'position', hangUp())]) {
        try {
          await operation();
        } catch (error) {
          results.push((error as NotFoundException).getResponse());
        }
      }
    }
    expect(results).toHaveLength(4);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(model.generate).not.toHaveBeenCalled();
  });
  it('bounds detail evidence, relations, histograms, cards and ask passages', async () => {
    const detail = await terms.detail(3, user, 'lumen lattice', 'position');
    expect(detail.histogram).toEqual([{ spineIndex: 0, count: 1 }]);
    expect(detail.related).toEqual([]);
    expect(detail.passages.flatMap((p) => p.ordinals).every((o) => o <= detail.cutoffOrdinal)).toBe(true);
    const card = await cards.card(3, user, 'lumen lattice', 'position', hangUp());
    expect(card.card.insufficient).toBe(true);
    expect(model.generate).not.toHaveBeenCalled();
    const answer = await questions.ask(3, user, 'hidden prism', 'position', hangUp());
    expect(answer.passages).toEqual([]);
    expect(answer.route).toBe('search');
    expect(model.generate).not.toHaveBeenCalled();
    const full = retrieve(fixture(), 40, 'hidden prism');
    expect(full.some((p) => p.ordinals.some((o) => o >= 30))).toBe(true);
  });
  it('sends one visible passage through the Ask prompt and preserves model refusal', async () => {
    useModel();
    model.generate.mockResolvedValue({ answer: '', points: [], notInBook: true });
    const result = await questions.ask(3, user, 'echoes', 'position', hangUp());
    expect(result.passages).toHaveLength(1);
    expect(model.generate).toHaveBeenCalledWith(answerPrompt('echoes', result.passages), ANSWER_SCHEMA, choice, {
      signal: expect.any(AbortSignal),
      userId: user.id,
    });
    expect(model.generate.mock.calls[0][0]).not.toContain('Hidden prism');
    expect(result.answer.notInBook).toBe(true);
  });
  it('answers a focused term through retrieval and the Ask prompt without calling cards', async () => {
    useModel();
    model.generate.mockResolvedValue({ answer: '', points: [], notInBook: true });
    const card = vi.spyOn(cards, 'card').mockRejectedValue(new NotFoundException('Invented missing card'));
    const search = vi.spyOn(retrieval, 'retrieve');
    try {
      const result = await questions.ask(3, user, 'Who is lumen lattice?', 'position', hangUp());
      expect(card).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledWith(expect.anything(), result.cutoffOrdinal, 'Who is lumen lattice?', 'lumen lattice');
      expect(result.route).toBe('term');
      expect(model.generate).toHaveBeenCalledWith(answerPrompt('Who is lumen lattice?', result.passages, true), ANSWER_SCHEMA, choice, {
        signal: expect.any(AbortSignal),
        userId: user.id,
      });
      expect(result.passages.every((p) => p.ordinals.every((o) => o <= result.cutoffOrdinal))).toBe(true);
    } finally {
      card.mockRestore();
      search.mockRestore();
    }
  });
  it('retrieves only completed body sentences and adds named-term occurrences', () => {
    const data = fixture();
    data.sentences[0].text = 'A quiet engine hums.';
    data.sentences[1].paragraphIndex = data.sentences[0].paragraphIndex;
    data.sentences[1].text = 'Future secret.';
    expect(retrieve(data, 1, 'lumen lattice')[0].text).toBe('A quiet engine hums.');
    expect(retrieve(data, 1, 'future secret')).toEqual([]);
    expect(retrieve(data, 1, 'lumen lattice')).toEqual(retrieve({ ...data, sentences: data.sentences.slice(0, 1) }, 1, 'lumen lattice'));
  });
  it('generates only from the checkpoint prefix and reuses checked cards', async () => {
    const data = fixture();
    const feature = data.terms[0].features[0];
    data.terms[0].deltas = [1, 14];
    data.terms[0].features = [{ ...feature, definition: true }, feature];
    await writeArtifact(artifactPath(directory, 3, fingerprint), data);
    useModel();
    model.generate.mockResolvedValue({
      meaning: 'It stores echoes.',
      meaningQuote: 'stores echoes',
      meaningPassage: 1,
      points: [{ text: 'It stores echoes.', quote: 'stores echoes', passage: 1 }],
      insufficient: false,
    });
    const result = await cards.card(3, user, 'lumen lattice', 'position', hangUp());
    expect(result.checks.meaningVerified).toBe(true);
    expect(model.generate.mock.calls[0][3]).toEqual({ signal: expect.any(AbortSignal), userId: user.id });
    expect(result.passages.every((p) => p.ordinals.every((o) => o <= result.cutoffOrdinal))).toBe(true);
    expect(model.generate.mock.calls[0][0]).not.toContain('Hidden prism');
    expect(repo.cache).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 3, evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/), cutoffOrdinal: result.cutoffOrdinal }),
    );
    repo.cached.mockResolvedValue({ card: result.card, checks: result.checks });
    expect(await cards.card(3, user, 'lumen lattice', 'position', hangUp())).toEqual(result);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it('keeps build idempotent and applies position scope unless full is explicit', async () => {
    expect((await knowledge.build(3, user)).cutoffOrdinal).toBeLessThan(30);
    expect((await knowledge.build(3, user, 'full')).cutoffOrdinal).toBe(40);
    expect(repo.queue).not.toHaveBeenCalled();
  });
  it('queues stale stage versions on the next accessed request', async () => {
    repo.state.mockResolvedValue({ fingerprint, textVersion: TEXT_VERSION - 1, termsVersion: TERMS_VERSION, status: 'ready', progress: 100 });
    expect((await knowledge.status(3, user)).status).toBe('queued');
    expect(repo.queue).toHaveBeenCalledWith(3, fingerprint, TEXT_VERSION, TERMS_VERSION);
  });
  describe('source fingerprint', () => {
    it('changes with the file size even when the stored hash does not', async () => {
      const before = (await knowledge.context(3, user, 'position', false)).fingerprint;
      expect(before).toBe(fingerprint);
      await writeFile(join(directory, 'book.epub'), `${EPUB_BYTES} plus a rewrite`);
      const after = (await knowledge.context(3, user, 'position', false)).fingerprint;
      expect(after).not.toBe(before);
      expect(after).toBe(fingerprintOf(`stored-file-hash:${EPUB_BYTES.length + ' plus a rewrite'.length}`));
    });
    it('uses size and modification time without reading the file when no hash is stored', async () => {
      // A directory stats like a file but cannot be streamed, so success proves no read stream was opened.
      const folder = join(directory, 'unreadable.epub');
      await mkdir(folder);
      read.knowledgeEpubFiles.mockResolvedValue([{ id: 9, absolutePath: folder, fileHash: null }]);
      const result = await knowledge.context(3, user, 'position', false);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.fingerprint).not.toBe(fingerprint);
    });
  });
  describe('unreadable or outdated artifacts', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      repo.next.mockResolvedValue(undefined);
    });
    afterEach(() => warn.mockRestore());
    it('queues a ready book whose artifact file is gone and reports it queued, not ready or stale', async () => {
      await rm(artifactPath(directory, 3, fingerprint));
      const status = await knowledge.status(3, user);
      expect(status.status).toBe('queued');
      expect(status.noProgress).toBe(false);
      expect(repo.queue).toHaveBeenCalledTimes(1);
      expect(repo.queue).toHaveBeenCalledWith(3, fingerprint, TEXT_VERSION, TERMS_VERSION);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[book_knowledge\.artifact_read\] \[fail\] bookId=3 durationMs=\d+ errorClass=Error /),
      );
      await expect(knowledge.context(3, user)).rejects.toMatchObject({ status: 409 });
    });
    it('queues a ready book whose artifact predates the current format', async () => {
      await writeArtifact(artifactPath(directory, 3, fingerprint), { ...fixture(), formatVersion: ARTIFACT_VERSION - 1 });
      expect((await knowledge.status(3, user)).status).toBe('queued');
      expect(repo.queue).toHaveBeenCalledTimes(1);
    });
  });
  describe('the Enabled switch', () => {
    beforeEach(() => settings.enabled.mockResolvedValue(false));
    it('refuses a build and queues nothing when Book Knowledge is turned off', async () => {
      repo.state.mockResolvedValue(undefined);
      await expect(knowledge.build(3, user)).rejects.toMatchObject({ status: 503 });
      expect(repo.queue).not.toHaveBeenCalled();
    });
    it('does not auto-queue a stale book and reports the switch in status', async () => {
      repo.state.mockResolvedValue({ fingerprint, textVersion: TEXT_VERSION - 1, termsVersion: TERMS_VERSION, status: 'ready', progress: 100 });
      const status = await knowledge.status(3, user);
      expect(status).toMatchObject({ status: 'stale', enabled: false });
      expect(repo.queue).not.toHaveBeenCalled();
    });
    it('leaves queued books waiting instead of draining them', async () => {
      await knowledge['drain']();
      expect(repo.next).not.toHaveBeenCalled();
    });
  });
  it('reports no progress only when an artifact exists to measure it against', async () => {
    repo.state.mockResolvedValue(undefined);
    expect(await knowledge.status(3, { id: 8 } as RequestUser)).toMatchObject({ status: 'none', noProgress: false, enabled: true });
  });
  describe('build queue', () => {
    const buildArtifact = vi.mocked(pipeline.buildArtifact);
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      repo.next.mockResolvedValueOnce({ bookId: 3 }).mockResolvedValue(undefined);
    });
    afterEach(() => error.mockRestore());
    it('marks a book too long to store as failed with a plain reason and does not requeue it on Build', async () => {
      buildArtifact.mockRejectedValue(new ArtifactTooLargeError());
      await knowledge['drain']();
      expect(repo.update).toHaveBeenLastCalledWith(3, { status: 'failed', error: BOOK_TOO_LONG_ERROR, progress: 0 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('errorClass=ArtifactTooLargeError error="Artifact exceeds size limit"'));
      repo.state.mockResolvedValue({
        fingerprint,
        textVersion: TEXT_VERSION,
        termsVersion: TERMS_VERSION,
        status: 'failed',
        progress: 0,
        error: BOOK_TOO_LONG_ERROR,
      });
      expect((await knowledge.build(3, user)).status).toBe('failed');
      expect(repo.queue).not.toHaveBeenCalled();
    });
    it('logs the real error class and a sanitized message when a build fails', async () => {
      buildArtifact.mockRejectedValue(new TypeError('bad "quote"\nline'));
      await knowledge['drain']();
      expect(repo.update).toHaveBeenLastCalledWith(3, { status: 'failed', error: 'Knowledge build failed; retry the build', progress: 0 });
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/durationMs=\d+ errorClass=TypeError error="bad \\"quote\\" line" - build failed$/));
      repo.state.mockResolvedValue({
        fingerprint,
        textVersion: TEXT_VERSION,
        termsVersion: TERMS_VERSION,
        status: 'failed',
        progress: 0,
        error: 'x',
      });
      await knowledge.build(3, user);
      expect(repo.queue).toHaveBeenCalledTimes(1);
    });
  });
  it('keeps cleaning other books when one book fails', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      repo.cleanupIds.mockResolvedValue([3, 4]);
      repo.state.mockImplementation((bookId: number) => (bookId === 3 ? Promise.reject(new Error('invented outage')) : Promise.resolve(undefined)));
      await knowledge['cleanup']();
      expect(repo.cleanupDone).toHaveBeenCalledTimes(1);
      expect(repo.cleanupDone).toHaveBeenCalledWith(4);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[book_knowledge.cleanup] [fail] bookId=3'));
    } finally {
      warn.mockRestore();
    }
  });
  it('recovers persisted jobs on boot without loading a library', async () => {
    repo.next.mockResolvedValue(undefined);
    await knowledge.onApplicationBootstrap();
    await Promise.resolve();
    expect(repo.resume).toHaveBeenCalledOnce();
    expect(repo.next).toHaveBeenCalled();
  });
});
