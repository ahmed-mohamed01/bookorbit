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
import { wordRarity } from './core/common-words';
import { KIND_REVIEW_SYSTEM, planKindReview, reviewCheckpoint, type KindAnswer } from './core/kind-review';
import type { Artifact, Sentence } from './core/model';
import { extractAliasLinks, extractTerms } from './core/term-extractor';
import { DENSE_PROMPT_VERSION, NOW_SYSTEM } from './xray/dense/dense-prompt';
import { xrayEntities } from './xray/xray-entities';
import { XRAY_MODE_SYSTEM } from './xray/xray-mode';
import {
  EVERYDAY_OBJECT_REVIEW_SYSTEM,
  NONFICTION_ROLE_REVIEW_SYSTEM,
  ROLE_ESCALATION_VOTES,
  ROLE_REVIEW_VOTES,
  roleReviewCandidates,
} from './xray/xray-role-review';
import { XrayUnitStore } from './xray/xray-unit-store';

vi.mock('../story-guides/text/book-text-reader', () => ({ readBookText: vi.fn() }));
const kindReviewPrompt = (system: string) => system === KIND_REVIEW_SYSTEM;

vi.mock('./core/epub-metadata', () => ({ readEpubMetadata: vi.fn(() => Promise.resolve({ subjects: [] })) }));

const FINGERPRINT = 'f'.repeat(64);
const SECRET_TITLE = 'The Queen Was Her Mother';

function sentencesOf(): Sentence[] {
  const lines = [
    ...Array.from({ length: 12 }, (_, index) => [`Nerith walked with Quenric past the mill ${index}.`, 0] as const),
    ...Array.from({ length: 12 }, (_, index) => [`Quenric spoke to Nerith near Droskell ${index}.`, 1] as const),
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
const isRolePrompt = (system?: string) => system === EVERYDAY_OBJECT_REVIEW_SYSTEM || system === NONFICTION_ROLE_REVIEW_SYSTEM;
/** Every role candidate kept; any other prompt gets an empty object. */
const blank = ({ system, user }: { system?: string; user: string }): AiResult =>
  reply(isRolePrompt(system) ? JSON.stringify(Object.fromEntries([...user.matchAll(/^id (e\d+) \|/gm)].map(([, id]) => [id, 'keep']))) : '{}');
const answerBlank = (call: { system?: string; user: string }) => Promise.resolve(blank(call));
/** A readable answer to every prompt, so no unit is skipped: every kind a person, every role candidate kept. */
const answerAll = ({ system, user }: { system?: string; user: string }): Promise<AiResult> => {
  if (isRolePrompt(system)) return answerBlank({ system, user });
  if (system === KIND_REVIEW_SYSTEM) {
    const items = JSON.parse(user.split('\nEntries:\n')[1]) as { id: string }[];
    return Promise.resolve(reply(JSON.stringify(Object.fromEntries(items.map(({ id }) => [id, 'person'])))));
  }
  return Promise.resolve(reply('{"notes": {}, "summary": "Nerith walks.", "identity": [], "relations": []}'));
};
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
    hold: ReturnType<typeof vi.fn<BookKnowledgeService['hold']>>;
  };
  const findById = vi.fn();
  const unitsPath = () => join(dir, '7', FINGERPRINT, 'xray-units.jsonl.gz');

  const service = (careful: AiSlotChoice | null = use) =>
    new BookKnowledgeXrayService(
      knowledge as unknown as BookKnowledgeService,
      { findById } as unknown as BookReadService,
      {
        choice: vi.fn((slot: string) => Promise.resolve(slot === 'careful' ? careful : use)),
        complete,
      } as unknown as BookKnowledgeModelService,
    );
  const finished = async (xray: BookKnowledgeXrayService, run: BookKnowledgeXrayRun) => {
    await vi.waitFor(() => expect(xray.get(run.runId).finishedAt).not.toBeNull(), { timeout: 5000 });
    return xray.get(run.runId);
  };

  function mockBookText(): void {
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
  }

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    findById.mockReset();
    vi.mocked(readEpubMetadata).mockClear();
    dir = await mkdtemp(join(tmpdir(), 'bk-xray-service-'));
    artifact = artifactOf();
    complete = vi.fn(answerBlank);
    knowledge = {
      context: vi.fn(() => Promise.resolve({ artifact, fingerprint: FINGERPRINT, file: { id: 41, format: 'epub', absolutePath: '/books/7.epub' } })),
      xrayUnitsPath: vi.fn((bookId: number, fingerprint: string) => join(dir, String(bookId), fingerprint, 'xray-units.jsonl.gz')),
      hold: vi.fn(() => vi.fn()),
    };
    mockBookText();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function roleFixture(): Map<string, KindAnswer> {
    for (const sentence of artifact.sentences) {
      const cup = [1, 13].includes(sentence.ordinal) ? ' by the cup handle' : '';
      sentence.text =
        (sentence.ordinal % 2 ? 'Nerith pushed the sled over glimmerstone' : 'Quenric turned the sled away from glimmerstone') + cup + '.';
    }
    const terms = ['sled', 'glimmerstone', 'cup', 'nerith'];
    artifact.terms = terms.map((key) => {
      const person = key === 'nerith';
      const hits = artifact.sentences.filter(({ text }) => text.toLowerCase().includes(key));
      return {
        key,
        rarity: wordRarity(key),
        wordCount: 1,
        deltas: hits.map(({ ordinal }, index) => ordinal - (hits[index - 1]?.ordinal ?? 0)),
        features: hits.map(() => ({
          alias: person ? 'Nerith' : key,
          definition: false,
          capitalized: person,
          person,
          place: false,
          nested: false,
          structural: false,
          modifier: key === 'cup',
        })),
      };
    });
    artifact.aliasLinks = [];
    mockBookText();
    return new Map([
      ['sled', 'object'],
      ['glimmerstone', 'idea'],
      ['cup', 'object'],
      ['nerith', 'character'],
    ]);
  }

  const reviewItems = (user: string) => JSON.parse(user.split('\nEntries:\n')[1]) as { id: string; name: string }[];
  const roleItems = (user: string) => [...user.matchAll(/^id (e\d+) \| (.+) \| \d+ sentences$/gm)].map(([, id, name]) => ({ id, name }));
  type RoleOutcome = 'keep' | 'minor' | 'junk' | 'omit' | 'refused' | 'down' | 'malformed';

  /** Answers the role asks in order: the sled gets each scripted outcome, every other entry "keep". */
  function scriptRoles(kinds: Map<string, KindAnswer>, outcomes: readonly RoleOutcome[]): void {
    let roleCall = 0;
    complete.mockImplementation((call) => {
      if (call.system === KIND_REVIEW_SYSTEM) {
        return Promise.resolve(reply(JSON.stringify(Object.fromEntries(reviewItems(call.user).map(({ id, name }) => [id, kinds.get(name)])))));
      }
      if (call.system === EVERYDAY_OBJECT_REVIEW_SYSTEM) {
        const outcome = outcomes[roleCall++] ?? 'keep';
        if (outcome === 'refused') return Promise.reject(new AiError('bad-request', 'The provider refused the request'));
        if (outcome === 'down') return Promise.reject(new AiError('provider-down', 'provider down'));
        const items = roleItems(call.user);
        if (outcome === 'malformed') return Promise.resolve(reply(`{"${items[0].id}":"junk",}`));
        const answers = items
          .filter(({ name }) => outcome !== 'omit' || name !== 'sled')
          .map(({ id, name }) => [id, name === 'sled' ? outcome : 'keep']);
        return Promise.resolve(reply(JSON.stringify(Object.fromEntries(answers))));
      }
      const slots = [...call.user.matchAll(/^(e\d+) \| (sled|glimmerstone) \|/gm)];
      const ordinal = Number(call.user.match(/^\[(\d+)\] /m)?.[1]);
      if (call.user.includes('notes: an object keyed by id')) {
        const notes = Object.fromEntries(
          slots.map(([, id, name]) => [
            id,
            { note: name === 'sled' ? 'Nerith pushes the sled across the path.' : 'Nerith finds glimmerstone on the path.', n: [ordinal] },
          ]),
        );
        return Promise.resolve(reply(JSON.stringify({ notes, summary: 'The travellers move along the path.' })));
      }
      if (call.user.includes('merges: {"a"')) {
        const identity = slots.map(([, id, name]) => ({
          id,
          is: { text: name === 'sled' ? 'A vehicle used on the trail.' : 'A substance found on the trail.', n: [ordinal] },
        }));
        return Promise.resolve(reply(JSON.stringify({ identity, merges: [], abilities: [] })));
      }
      return Promise.resolve(reply('{}'));
    });
  }

  const roleCalls = () => complete.mock.calls.filter(([{ system }]) => system === EVERYDAY_OBJECT_REVIEW_SYSTEM).length;
  const roleEndLine = () =>
    vi
      .mocked(Logger.prototype.log)
      .mock.calls.map(([message]) => String(message))
      .find((message) => message.startsWith('[book_knowledge.xray_role_review] [end]'));

  it.each([
    ['three of three junk', ['junk', 'junk', 'junk'], 3, 1, 0],
    ['two of three junk, both extra votes junk', ['junk', 'junk', 'keep', 'junk', 'junk'], 5, 1, 0],
    ['two of three junk, one extra vote keeps', ['junk', 'junk', 'keep', 'junk', 'keep'], 5, 0, 0],
    ['one of three junk', ['junk', 'keep', 'keep'], 3, 0, 0],
    ['a refused sample beside one junk', ['junk', 'refused', 'keep'], 3, 0, 0],
    ['a malformed sample beside one junk', ['malformed', 'junk', 'keep'], 3, 0, 0],
    ['two of three minor', ['minor', 'keep', 'minor'], 3, 0, 1],
    ['a sample that omits the sled and is asked again', ['omit', 'junk', 'keep', 'junk', 'junk', 'junk'], 6, 1, 0],
  ] as const)('votes on the admitted cast: %s', async (_label, outcomes, calls, removed, minor) => {
    const kinds = roleFixture();
    scriptRoles(kinds, outcomes);
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh: true }));
    expect(run.status).toBe('done');
    const all = complete.mock.calls.map(([call]) => call);
    const roleIndex = all.findIndex(({ system }) => system === EVERYDAY_OBJECT_REVIEW_SYSTEM);
    expect(roleIndex).toBeGreaterThan(0);
    expect(all.slice(0, roleIndex).every(({ system }) => system === KIND_REVIEW_SYSTEM)).toBe(true);
    expect(all.slice(roleIndex).some(({ system }) => system === KIND_REVIEW_SYSTEM)).toBe(false);
    const expectedCast = xrayEntities(artifact, run.through, kinds);
    const expectedCandidates = roleReviewCandidates(expectedCast).candidates.map(({ name }) => name);
    expect(expectedCandidates).toEqual(['glimmerstone', 'nerith', 'sled']);
    expect(roleItems(all[roleIndex].user).map(({ name }) => name)).toEqual(expectedCandidates);
    // No entry's name holds another's, so the batch carries no other names.
    expect(all[roleIndex].user).toMatch(/^Candidates:\n/);
    expect(roleCalls()).toBe(calls);
    expect(run.counts?.roleRemoved).toBe(removed);
    expect(run.steps.find(({ step }) => step === 'kinds')?.counts).toMatchObject({
      roleReviewCalls: calls,
      roleReviewUnits: calls,
      roleReviewRemoved: removed,
      roleReviewMinor: minor,
    });
    expect(roleEndLine()).toContain(`removed=${removed} minor=${minor} names="${removed ? 'sled' : ''}"`);
    const payload = xray.payload(run.runId);
    expect(
      payload.entities
        .filter(({ kind }) => kind !== 'character')
        .map(({ name }) => name)
        .sort(),
    ).toEqual(removed ? ['glimmerstone'] : ['glimmerstone', 'sled']);
    if (removed) {
      expect(all.slice(roleIndex + 1).every(({ user }) => !/^e\d+ \| sled \|/m.test(user))).toBe(true);
      expect(payload.chronicle?.entities).not.toHaveProperty('sled');
      expect(payload.entities.flatMap(({ lines, profiles }) => [...lines, ...(profiles ?? [])]).map(({ text }) => text)).not.toContainEqual(
        expect.stringMatching(/\bsled\b/i),
      );
    } else {
      const sled = payload.entities.find(({ name }) => name === 'sled');
      expect(sled?.lines.map(({ text }) => text)).toContain('A vehicle used on the trail.');
    }
  });

  it('fails the build when more than a third of the role votes are missing', async () => {
    const kinds = roleFixture();
    scriptRoles(kinds, ['junk', 'refused', 'malformed']);
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh: true }));
    expect(run).toMatchObject({ status: 'failed', error: 'The role review answered 33% of its votes' });
    expect(complete.mock.calls.some(([{ user }]) => user.includes('notes: an object keyed by id'))).toBe(false);
  });

  it('lets a provider outage during the role review reach the job engine', async () => {
    const kinds = roleFixture();
    scriptRoles(kinds, ['keep', 'down', 'keep']);
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation((request) => complete({ ...request, signal: undefined } as never));
    await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ code: 'provider-down' });
    expect(jobComplete.mock.calls.some(([{ user }]) => user.includes('notes: an object keyed by id'))).toBe(false);
  });

  it('judges a nonfiction build with the nonfiction prompt', async () => {
    const kinds = roleFixture();
    scriptRoles(kinds, []);
    complete.mockImplementation((call) => {
      if (call.system === KIND_REVIEW_SYSTEM) {
        return Promise.resolve(reply(JSON.stringify(Object.fromEntries(reviewItems(call.user).map(({ id, name }) => [id, kinds.get(name)])))));
      }
      if (call.system !== NONFICTION_ROLE_REVIEW_SYSTEM) return Promise.resolve(reply('{}'));
      const answers = roleItems(call.user).map(({ id, name }) => [id, name === 'sled' ? 'junk' : 'keep']);
      return Promise.resolve(reply(JSON.stringify(Object.fromEntries(answers))));
    });
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { mode: 'nonfiction', fresh: true }));
    expect(run.status).toBe('done');
    expect(complete.mock.calls.some(([{ system }]) => system === EVERYDAY_OBJECT_REVIEW_SYSTEM)).toBe(false);
    expect(complete.mock.calls.filter(([{ system }]) => system === NONFICTION_ROLE_REVIEW_SYSTEM)).toHaveLength(ROLE_REVIEW_VOTES);
    expect(run.counts?.roleRemoved).toBe(1);
  });

  it('replays every role sample, the asked-again one included, without a new call', async () => {
    const kinds = roleFixture();
    scriptRoles(kinds, ['omit', 'junk', 'keep', 'junk', 'junk', 'junk']);
    const xray = service();
    const first = await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh: true }));
    expect(first.counts?.roleRemoved).toBe(1);
    expect(roleCalls()).toBe(6);
    complete.mockClear();
    const second = await finished(xray, await xray.start(7, user, { mode: 'fiction' }));
    expect(second.status).toBe('done');
    expect(roleCalls()).toBe(0);
    expect(second.counts?.roleRemoved).toBe(1);
    expect(second.steps.find(({ step }) => step === 'kinds')?.counts).toMatchObject({
      roleReviewCalls: 0,
      roleReviewUnits: 6,
      roleReviewEscalated: 1,
    });
  });

  it('includes dry-run role batches in the kinds estimate', async () => {
    roleFixture();
    const xray = service();
    const run = await finished(xray, await xray.start(7, user, { mode: 'fiction', dryRun: true }));
    const standard = planKindReview(artifact, reviewCheckpoint(artifact.sentences, run.through), 'fiction', true);
    expect(run.estimate?.steps.find(({ step }) => step === 'kinds')?.calls).toBe(standard.length + ROLE_REVIEW_VOTES + ROLE_ESCALATION_VOTES);
    expect(complete).not.toHaveBeenCalled();
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

  describe('mode', () => {
    const modeCalls = () => complete.mock.calls.filter(([{ system }]) => system === XRAY_MODE_SYSTEM);
    const answerMode = (answer: () => Promise<AiResult>) =>
      complete.mockImplementation((call) => (call.system === XRAY_MODE_SYSTEM ? answer() : answerBlank(call)));

    it('takes the model answer over the subjects and puts it in the payload', async () => {
      vi.mocked(readEpubMetadata).mockResolvedValueOnce({ titles: [], authors: [], subjects: ['Fantasy'] });
      findById.mockResolvedValue({ book: { book_metadata: { title: 'The Salt Ledger', description: '<p>A true account.</p>' } }, authorRows: [] });
      answerMode(() => Promise.resolve(reply('{"mode": "nonfiction"}')));
      const xray = service();
      const run = await finished(xray, await xray.start(7, user, { fresh: true }));
      expect(run).toMatchObject({ status: 'done', mode: 'nonfiction', modeSource: 'model' });
      expect(xray.payload(run.runId)).toMatchObject({ mode: 'nonfiction', modeSource: 'model' });
      expect(modeCalls()).toHaveLength(1);
      const [call] = modeCalls()[0];
      expect(call).toMatchObject({ temperature: 0 });
      expect(call.user).toContain('Title: The Salt Ledger');
      expect(call.user).toContain('Description: A true account.');
      expect(call.user).toContain('Subjects: Fantasy');
      expect(call.user).toContain('Nerith walked with Quenric past the mill 0.');
      expect(run.steps[0]).toMatchObject({ step: 'mode', units: 1, calls: 1 });
    });

    it('keeps an override without asking the model', async () => {
      const xray = service();
      const run = await finished(xray, await xray.start(7, user, { mode: 'nonfiction', fresh: true }));
      expect(run).toMatchObject({ status: 'done', mode: 'nonfiction', modeSource: 'override' });
      expect(xray.payload(run.runId)).toMatchObject({ mode: 'nonfiction', modeSource: 'override' });
      expect(modeCalls()).toHaveLength(0);
    });

    it.each([
      ['a refused call', () => Promise.reject(new AiError('bad-request', 'The provider refused the request')), 1],
      ['two unreadable replies', () => Promise.resolve(reply('fiction, probably')), 2],
    ])('falls back to the subjects after %s', async (_label, answer, calls) => {
      vi.mocked(readEpubMetadata).mockResolvedValueOnce({ titles: [], authors: [], subjects: ['History'] });
      answerMode(answer);
      const xray = service();
      const run = await finished(xray, await xray.start(7, user, { fresh: true }));
      expect(run).toMatchObject({ status: 'done', mode: 'nonfiction', modeSource: 'subjects' });
      expect(xray.payload(run.runId)).toMatchObject({ mode: 'nonfiction', modeSource: 'subjects' });
      expect(modeCalls()).toHaveLength(calls);
    });

    it('replays the stored answer on a rebuild', async () => {
      answerMode(() => Promise.resolve(reply('{"mode": "nonfiction"}')));
      const xray = service();
      await finished(xray, await xray.start(7, user, { fresh: true }));
      const second = await finished(xray, await xray.start(7, user));
      expect(modeCalls()).toHaveLength(1);
      expect(second).toMatchObject({ mode: 'nonfiction', modeSource: 'model' });
      expect(second.steps[0].counts).toMatchObject({ replayed: 1 });
    });

    it('plans the mode call in a dry run without sending it', async () => {
      vi.mocked(readEpubMetadata).mockResolvedValueOnce({ titles: [], authors: [], subjects: ['Philosophy'] });
      const xray = service();
      const run = await finished(xray, await xray.start(7, user, { dryRun: true }));
      expect(run).toMatchObject({ mode: 'nonfiction', modeSource: 'subjects' });
      expect(run.estimate?.steps.find(({ step }) => step === 'mode')?.calls).toBe(1);
      expect(complete).not.toHaveBeenCalled();
    });

    it('rethrows a provider outage from the mode call instead of leaving the mode to the subjects', async () => {
      vi.mocked(readEpubMetadata).mockResolvedValueOnce({ titles: [], authors: [], subjects: ['History'] });
      const jobComplete = vi
        .fn<XrayCompleter>()
        .mockImplementation((call) =>
          call.system === XRAY_MODE_SYSTEM ? Promise.reject(new AiError('provider-down', 'provider down')) : answerBlank(call),
        );
      await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ code: 'provider-down' });
      expect(jobComplete.mock.calls.filter(([{ system }]) => system === KIND_REVIEW_SYSTEM)).toHaveLength(0);
    });

    it('rethrows a pause from the mode call', async () => {
      const pause = new AiJobPause('over-estimate');
      const jobComplete = vi
        .fn<XrayCompleter>()
        .mockImplementation((call) => (call.system === XRAY_MODE_SYSTEM ? Promise.reject(pause) : answerBlank(call)));
      await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toBe(pause);
    });
  });

  it("holds the book's files against cleanup for the whole build", async () => {
    const release = vi.fn();
    knowledge.hold.mockReturnValue(release);
    const xray = service();
    const run = await finished(xray, await xray.start(7, user));
    expect(run.status).toBe('done');
    expect(knowledge.hold).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledOnce();
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

  it('stops every call of a failed build and stores none of the answers in flight', async () => {
    let failedAt = 0;
    const startedAfter: string[] = [];
    const signals: AbortSignal[] = [];
    complete.mockImplementation((call) => {
      if (kindReviewPrompt(call.system)) return Promise.resolve(reply('{}'));
      if (isRolePrompt(call.system)) return answerBlank(call);
      if (call.system === XRAY_MODE_SYSTEM) return Promise.resolve(reply('unreadable'));
      if (failedAt) startedAfter.push(call.user.slice(0, 20));
      signals.push(call.signal!);
      if (signals.length === 1)
        return new Promise((_, reject) =>
          setTimeout(() => {
            failedAt = Date.now();
            reject(new AiError('provider-down', 'provider down'));
          }, 5),
        );
      return new Promise((resolve) => setTimeout(() => resolve(reply('{"notes": {}, "summary": "Nerith walks.", "identity": []}')), 40));
    });
    const xray = service();
    const run = await finished(xray, await xray.start(7, user));
    expect(run).toMatchObject({ status: 'failed', error: 'provider down' });
    expect(startedAfter).toEqual([]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const stored = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: 'm' });
    // Only the role votes that finished before the failure are kept.
    expect(await stored.load()).toBe(complete.mock.calls.filter(([call]) => isRolePrompt(call.system)).length);
    expect(await readdir(join(dir, '7', FINGERPRINT)).catch(() => [])).not.toContain('xray-payload.json.gz');
  });

  it('cancels a running build: its calls are aborted and the run is failed as cancelled', async () => {
    complete.mockImplementation((call) =>
      kindReviewPrompt(call.system)
        ? Promise.resolve(reply('{}'))
        : new Promise((_, reject) => call.signal!.addEventListener('abort', () => reject(new AiError('cancelled', 'aborted')))),
    );
    const xray = service();
    const started = await xray.start(7, user);
    await vi.waitFor(() => expect(complete.mock.calls.some(([call]) => !kindReviewPrompt(call.system))).toBe(true));
    expect(xray.cancel(started.runId)).toMatchObject({ status: 'failed', error: 'cancelled' });
    const run = await finished(xray, started);
    expect(run).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(complete.mock.calls.every(([call]) => kindReviewPrompt(call.system) || call.signal?.aborted)).toBe(true);
    complete.mockImplementation(answerBlank);
    await finished(xray, await xray.start(7, user));
  });

  it('asks a capped request for no more than the slot allows', async () => {
    const xray = service();
    await finished(xray, await xray.start(7, user));
    const capped = complete.mock.calls.map(([call]) => call).filter((call) => call.use.maxOutputTokens !== 4000);
    expect(capped.length).toBeGreaterThan(0);
    for (const call of capped) expect(call.maxOutputTokens).toBeLessThanOrEqual(call.use.maxOutputTokens!);
  });

  const writesText = (system = '') =>
    system === NOW_SYSTEM || system.startsWith('For each name, use only the supplied evidence') || system.startsWith('You keep short descriptions');
  const careful: AiSlotChoice = { slot: 'careful', connectionId: 2, model: 'c', prices: null, jsonMode: 'auto', maxOutputTokens: 2000 };

  const statusFacts = (call: BookKnowledgeAiCall) => {
    if (!call.user.includes('merges: {"a"')) return answerBlank(call);
    const ordinal = Number(call.user.match(/^\[(\d+)\] /m)?.[1]);
    const identity = [...call.user.matchAll(/^(e\d+) \| ([^|]+) \|/gm)].flatMap(([, id, name]) => [
      { id, fact: `${name.trim()} is a miller.`, kind: 'identity', n: [ordinal] },
      { id, fact: `${name.trim()} works at the mill.`, kind: 'status', n: [ordinal] },
    ]);
    return Promise.resolve(reply(JSON.stringify({ identity, merges: [], abilities: [] })));
  };

  it('writes describe, now and about on the careful model and reads the book on fast', async () => {
    complete.mockImplementation(statusFacts);
    const xray = service(careful);
    const run = await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh: true }));
    expect(run.status).toBe('done');
    const calls = complete.mock.calls.map(([call]) => call);
    for (const call of calls) expect(call.use.model).toBe(writesText(call.system) ? 'c' : 'm');
    const written = calls.filter((call) => call.use.model === 'c').map(({ system }) => system ?? '');
    expect(written).toContain(NOW_SYSTEM);
    expect(written.some((system) => system.startsWith('For each name'))).toBe(true);
    expect(written.some((system) => system.startsWith('You keep short descriptions'))).toBe(true);
    const slots = Object.fromEntries(run.steps.map(({ step, slot }) => [step, slot]));
    expect(slots).toMatchObject({
      kinds: 'fast',
      notes: 'fast',
      facts: 'fast',
      ties: 'fast',
      alias: 'fast',
      describe: 'careful',
      now: 'careful',
      about: 'careful',
    });
    expect(xray.payload(run.runId).models).toEqual({ fast: 'm', careful: 'c' });
  });

  it.each([
    ['unset', null],
    ['the fast model', { ...use, slot: 'careful' as const }],
  ])('keeps every step on fast when careful is %s', async (_name, choice) => {
    const xray = service(choice);
    const run = await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh: true }));
    expect(run.status).toBe('done');
    expect(complete.mock.calls.some(([call]) => writesText(call.system))).toBe(true);
    expect(complete.mock.calls.every(([call]) => call.use.slot === 'fast' && call.use.model === 'm')).toBe(true);
    expect(run.steps.every(({ slot }) => slot === 'fast')).toBe(true);
    expect(xray.payload(run.runId).models).toEqual({ fast: 'm' });
  });

  it('replays careful answers for the same careful model and asks them again after it changes, keeping fast answers', async () => {
    complete.mockImplementation((call) => {
      if (call.user.includes('notes: an object keyed by id')) return Promise.resolve(reply('{"notes": {}, "summary": "Nerith walks."}'));
      if (!call.system?.startsWith('For each name')) return answerBlank(call);
      const ordinal = Number(call.user.match(/\[(\d+)\]/)?.[1]);
      const ids = [...new Set([...call.user.matchAll(/\b(e\d+)\b/g)].map(([, id]) => id))];
      return Promise.resolve(reply(JSON.stringify(Object.fromEntries(ids.map((id) => [id, { about: 'A miller by the river.', n: [ordinal] }])))));
    });
    const build = async (choice: AiSlotChoice, fresh = false) => {
      complete.mockClear();
      const xray = service(choice);
      await finished(xray, await xray.start(7, user, { mode: 'fiction', fresh }));
      return complete.mock.calls.map(([call]) => call);
    };
    const notesOf = (calls: BookKnowledgeAiCall[]) => calls.filter((call) => call.user.includes('notes: an object keyed by id'));
    const describesOf = (calls: BookKnowledgeAiCall[]) => calls.filter((call) => call.system?.startsWith('For each name'));

    const first = await build(careful, true);
    expect(notesOf(first).length).toBeGreaterThan(0);
    expect(describesOf(first).length).toBeGreaterThan(0);
    expect(describesOf(first).every((call) => call.use.model === 'c')).toBe(true);

    const same = await build(careful);
    expect(notesOf(same)).toEqual([]);
    expect(describesOf(same)).toEqual([]);

    const changed = await build({ ...careful, model: 'c2' });
    expect(notesOf(changed)).toEqual([]);
    expect(describesOf(changed).length).toBeGreaterThan(0);
    expect(describesOf(changed).every((call) => call.use.model === 'c2')).toBe(true);
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
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(answerAll);
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
    const withProgress = vi.fn<XrayCompleter>().mockImplementation(answerBlank);
    await service().buildForStoryGuide({ ...jobInput(withProgress), onProgress: (stage, done, total) => stages.push([stage, done, total]) });
    const kinds = stages.filter(([stage]) => stage === 'kinds');
    expect(kinds[0][1]).toBe(0);
    expect(kinds.map(([, done]) => done)).toEqual(kinds.map((_, index) => index));
    expect(kinds.at(-1)![1]).toBe(kinds.at(-1)![2]);
    const dense = stages.filter(([stage]) => stage === 'dense');
    const units = dense[0][2];
    expect(units).toBeGreaterThan(0);
    expect(dense).toEqual(Array.from({ length: units + 1 }, (_, done) => ['dense', done, units]));
    expect(stages.map(([stage]) => stage).filter((stage, index, all) => stage !== all[index - 1])).toEqual(['kinds', 'alias', 'dense', 'finish']);
  });

  it.each([
    ['AiJobPause', new AiJobPause('over-estimate')],
    ['provider-down AiError', new AiError('provider-down', 'provider down')],
  ])('buildForStoryGuide rethrows %s from the completer and writes nothing', async (_name, pause) => {
    const pending = Promise.withResolvers<AiResult>();
    const pausing = Promise.withResolvers<AiResult>();
    const queue = [() => Promise.resolve(reply('{}')), () => Promise.resolve(reply('{}')), () => pausing.promise, () => pending.promise];
    const roleReview = (system: string) => isRolePrompt(system) || system === XRAY_MODE_SYSTEM;
    const jobComplete = vi
      .fn<XrayCompleter>()
      .mockImplementation((call) =>
        isRolePrompt(call.system)
          ? answerBlank(call)
          : call.system === XRAY_MODE_SYSTEM
            ? Promise.resolve(reply('unreadable'))
            : (queue.shift() ?? (() => Promise.resolve(reply('{}'))))(),
      );
    const xray = service();
    const build = xray.buildForStoryGuide(jobInput(jobComplete));
    const settled = vi.fn();
    void build.catch(settled);
    await vi.waitFor(() => expect(jobComplete.mock.calls.filter(([{ system }]) => !roleReview(system)).length).toBeGreaterThanOrEqual(4));
    pausing.reject(pause);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    await expect(xray.start(7, user)).rejects.toBeInstanceOf(ConflictException);
    pending.resolve(reply('{"notes": {}, "summary": "Nerith walks.", "identity": []}'));
    await expect(build).rejects.toBe(pause);
    const stored = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: use.model });
    expect(await stored.load()).toBe(jobComplete.mock.calls.filter(([call]) => isRolePrompt(call.system)).length);
  });

  it('buildForStoryGuide waits for a running bench build instead of throwing', async () => {
    const benchReply = Promise.withResolvers<AiResult>();
    const jobReply = Promise.withResolvers<AiResult>();
    complete.mockImplementationOnce(() => benchReply.promise);
    const jobComplete = vi
      .fn<XrayCompleter>()
      .mockImplementationOnce(() => jobReply.promise)
      .mockImplementation(answerAll);
    const xray = service();
    const bench = await xray.start(7, user);
    const build = xray.buildForStoryGuide(jobInput(jobComplete));
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(jobComplete).not.toHaveBeenCalled();
    benchReply.resolve(reply('{}'));
    await vi.waitFor(() => expect(jobComplete).toHaveBeenCalled());
    expect(xray.get(bench.runId).status).toBe('done');
    await expect(xray.start(7, user)).rejects.toBeInstanceOf(ConflictException);
    jobReply.resolve(reply('{"mode": "fiction"}'));
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
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(({ system, user }) => {
      if (!user.includes('notes: an object keyed by id')) return answerBlank({ system, user });
      answered.add(user);
      return Promise.resolve(reply('{"notes": {}, "summary": "Nerith walks."}'));
    });
    const xray = service();
    await xray.buildForStoryGuide(jobInput(jobComplete));
    expect(answered.size).toBeGreaterThan(0);
    const store = new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: use.model });
    expect(await store.load()).toBeGreaterThan(0);
    const second = vi.fn<XrayCompleter>().mockImplementation(answerBlank);
    await xray.buildForStoryGuide(jobInput(second));
    expect(second.mock.calls.some(([request]) => answered.has(request.user))).toBe(false);
  });

  it('buildForStoryGuide replays within one replay scope and asks again under another', async () => {
    const notes = ({ user }: { user: string }) => user.includes('notes: an object keyed by id');
    const answer = vi
      .fn<XrayCompleter>()
      .mockImplementation((request) => (notes(request) ? Promise.resolve(reply('{"notes": {}, "summary": "Nerith walks."}')) : answerBlank(request)));
    const xray = service();
    await xray.buildForStoryGuide({ ...jobInput(answer), replayScope: '1' });
    const asked = answer.mock.calls.filter(([request]) => notes(request)).length;
    expect(asked).toBeGreaterThan(0);

    const same = vi.fn<XrayCompleter>().mockImplementation(answer);
    await xray.buildForStoryGuide({ ...jobInput(same), replayScope: '1' });
    expect(same.mock.calls.filter(([request]) => notes(request))).toHaveLength(0);

    const store = () => new XrayUnitStore(unitsPath(), { fingerprint: FINGERPRINT, promptVersion: DENSE_PROMPT_VERSION, model: use.model });
    const oneGeneration = await store().load();

    const rebuilt = vi.fn<XrayCompleter>().mockImplementation(answer);
    await xray.buildForStoryGuide({ ...jobInput(rebuilt), replayScope: '2' });
    expect(rebuilt.mock.calls.filter(([request]) => notes(request))).toHaveLength(asked);
    // The finished rebuild drops the first generation's answers instead of keeping both.
    expect(await store().load()).toBe(oneGeneration);
  });

  it('asks again on another connection or effort that serves the same model name', async () => {
    const notes = ({ user }: { user: string }) => user.includes('notes: an object keyed by id');
    const answer = vi
      .fn<XrayCompleter>()
      .mockImplementation((request) => (notes(request) ? Promise.resolve(reply('{"notes": {}, "summary": "Nerith walks."}')) : answerBlank(request)));
    const xray = service();
    await xray.buildForStoryGuide(jobInput(answer));
    const asked = answer.mock.calls.filter(([request]) => notes(request)).length;
    for (const other of [
      { ...use, connectionId: 2 },
      { ...use, effort: 'high' as const },
    ]) {
      const again = vi.fn<XrayCompleter>().mockImplementation(answer);
      await xray.buildForStoryGuide({ ...jobInput(again), use: other });
      expect(again.mock.calls.filter(([request]) => notes(request))).toHaveLength(asked);
    }
  });

  it('buildForStoryGuide fails as unreadable without a model call when the main file changed', async () => {
    knowledge.context.mockResolvedValue({ artifact, fingerprint: FINGERPRINT, file: { id: 99, format: 'epub', absolutePath: '/books/7b.epub' } });
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(answerBlank);
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
    const jobComplete = vi.fn<XrayCompleter>().mockImplementation(answerBlank);
    await expect(service().buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason });
    expect(knowledge.context).toHaveBeenCalledWith(7, user, 'full', false);
    expect(jobComplete).not.toHaveBeenCalled();
  });

  it('reports the source error as unreadable for a job and preserves it for bench builds', async () => {
    const error = new BadRequestException('Book Knowledge cannot read the source file');
    knowledge.context.mockRejectedValue(error);
    const jobComplete = vi.fn<XrayCompleter>();
    const xray = service();
    await expect(xray.buildForStoryGuide(jobInput(jobComplete))).rejects.toMatchObject({ reason: 'unreadable', message: error.message });
    expect(jobComplete).not.toHaveBeenCalled();
    await expect(xray.start(7, user)).rejects.toBe(error);
  });

  it('buildForStoryGuide lowers the payload coverage to the answered share of a counted step', async () => {
    const xray = service();
    const real = (xray as never as { steps: (...args: unknown[]) => Promise<unknown> }).steps.bind(xray);
    vi.spyOn(xray as never as { steps: (...args: unknown[]) => Promise<unknown> }, 'steps').mockImplementation(async (...args) => {
      const payload = await real(...args);
      (args[0] as { run: BookKnowledgeXrayRun }).run.steps.push(step('describe', 20, 6));
      return payload;
    });
    const payload = await xray.buildForStoryGuide(jobInput(vi.fn<XrayCompleter>().mockImplementation(answerAll)));
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

  it(`counts a step under ${BK_COVERAGE_MIN_UNITS} units when most of it was skipped`, () => {
    expect(storyGuideCoverage([step('notes', 8, 8)])).toBe(0);
    expect(storyGuideCoverage([step('notes', 8, 5)])).toBe(3 / 8);
    expect(storyGuideCoverage([step('notes', 8, 4)])).toBe(1);
  });

  it('keeps optional role batches out of kind coverage', () => {
    const kinds = { ...step('kinds', 13, 4), counts: { roleReviewUnits: 3 }, skippedUnits: ['k1', 'r1', 'r2', 'r3'] };
    expect(storyGuideCoverage([kinds])).toBe(0.9);
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
