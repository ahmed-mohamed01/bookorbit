import { Logger } from '@nestjs/common';
import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import type { Sentence } from '../core/model';
import { describeEntities, describeOutputTokens } from './dense/dense-describe';
import { PassCast } from './pass/pass-cast';
import { writeAbout, type Ask } from './pass/pass-run';
import { PassState } from './pass/pass-state';
import type { PassUnit } from './pass/pass-units';
import { entity } from './xray-fixtures.testing';
import { namesAt } from './xray-lines';
import { XrayPrivacy, XrayStepRun } from './xray-runner';
import { descriptionTier, MAIN_TIER, MINOR_TIER, SUPPORTING_TIER, type DescriptionTier } from './xray-tiers';

const sentences: Sentence[] = [
  {
    ordinal: 1,
    spineIndex: 0,
    paragraphIndex: 0,
    href: 'x.xhtml',
    text: 'Piper was a scout of the northern watch.',
    structure: 'body',
    heading: false,
    emphasis: [],
  },
];
const unit: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1], sectionEnd: true };
const lineOf = (words: number) => ['A', 'scout', ...Array<string>(words - 2).fill('brave')].join(' ') + '.';

function setup(importance: 1 | 2 | 3, replies: unknown[]) {
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  const piper = entity('e1', 'character', [1], { name: 'Piper', names: [{ text: 'Piper', ordinal: 1 }], importance });
  const [slot] = new PassCast([piper]).slots(unit);
  const step = (id: 'about' | 'describe') => new XrayStepRun(id, 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
  const ask = vi.fn<Ask>(
    () => () => Promise.resolve({ text: JSON.stringify(replies.shift() ?? {}), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }),
  );
  return { slot, names: namesAt([piper], 1), ask, step };
}

describe('description tiers', () => {
  it('maps importance to a tier, nonfiction terms outside the main ones getting the supporting length', () => {
    expect(descriptionTier(1, 'fiction')).toBe(MAIN_TIER);
    expect(descriptionTier(2, 'fiction')).toBe(SUPPORTING_TIER);
    expect(descriptionTier(3, 'fiction')).toBe(MINOR_TIER);
    expect(descriptionTier(1, 'nonfiction')).toBe(MAIN_TIER);
    expect(descriptionTier(3, 'nonfiction')).toBe(SUPPORTING_TIER);
    expect([MAIN_TIER.aim, SUPPORTING_TIER.aim, MINOR_TIER.aim]).toEqual([50, 30, 20]);
    expect([MAIN_TIER.limit, SUPPORTING_TIER.limit, MINOR_TIER.limit]).toEqual([100, 100, 100]);
  });

  const cases: [string, 1 | 2 | 3, BookKnowledgeXrayMode, DescriptionTier][] = [
    ['fiction main', 1, 'fiction', MAIN_TIER],
    ['fiction supporting', 2, 'fiction', SUPPORTING_TIER],
    ['fiction minor', 3, 'fiction', MINOR_TIER],
    ['nonfiction main', 1, 'nonfiction', MAIN_TIER],
    ['nonfiction other', 3, 'nonfiction', SUPPORTING_TIER],
  ];

  describe.each(cases)('describe, %s', (_, importance, mode, tier) => {
    const run = async (words: number) => {
      const { slot, names, ask, step } = setup(importance, [{ e1: { about: lineOf(words), n: [1] } }]);
      const describe = step('describe');
      const lines = await describeEntities([{ slot, mentions: [1] }], 'u1', names, sentences, mode, ask, describe);
      return { lines, describe, request: ask.mock.calls[0][0] };
    };

    it('accepts a line within the limit and states the limit in the prompt', async () => {
      const { lines, request } = await run(100);
      expect(lines.get('e1')).toBe(lineOf(100));
      expect(request.system).toContain(`about ${tier.aim} words`);
      expect(request.system).toContain('never more than 100');
      expect(request.maxOutputTokens).toBe(describeOutputTokens(1, tier));
    });

    it('drops a line over the limit', async () => {
      const { lines, describe } = await run(101);
      expect(lines.has('e1')).toBe(false);
      expect(describe.record.rejected).toEqual({ 'describe:too-long': 1 });
    });
  });

  describe.each(cases)('about, %s', (_, importance, mode, tier) => {
    const reply = (words: number) => (mode === 'fiction' ? { e1: { about: lineOf(words), n: [] } } : { lines: { Piper: lineOf(words) } });
    const run = async (words: number) => {
      const { slot, names, ask, step } = setup(importance, [reply(words), reply(words)]);
      const state = new PassState();
      const about = step('about');
      await writeAbout([slot], unit, state, names, mode, ask, about);
      return { state, about, ask };
    };

    it('accepts a line within the limit and states the limit in the prompt', async () => {
      const { state, ask } = await run(100);
      expect(state.currentAbout('e1')).toBe(lineOf(100));
      expect(ask.mock.calls[0][0].system).toContain(`about ${tier.aim} words`);
      expect(ask.mock.calls[0][0].system).toContain('never more than 100');
    });

    it('rejects a line over the limit', async () => {
      const { state, about, ask } = await run(101);
      expect(ask.mock.calls[1][0].user).toContain('is longer than 100 words');
      expect(state.currentAbout('e1')).toBeNull();
      expect(about.record.rejected).toEqual({ 'about:rewrite-failed': 1 });
    });
  });

  it.each([1, 2] as const)('keeps three early identity facts alongside newer facts for importance %i', async (importance) => {
    const { slot, names, ask, step } = setup(importance, [{ e1: 'unchanged' }]);
    const state = new PassState();
    const core = ['Worked as a cook on the coast.', 'Woke in the body of a dead queen.', 'Shares an oath with the stone guardian.'];
    const newer = [
      'Inherited a ruined tower.',
      'Learned to mend a hull.',
      'Leads the river clans.',
      'Keeps the ferry crews on watch.',
      'Won the loyalty of the lockkeepers.',
      'Practises weather magic.',
      'Runs the island granary.',
      'Carries the royal seal.',
      'Knows the old river channels.',
      'Keeps a fleet of rescue boats.',
    ];
    const facts = ['Is staying at the inn.', ...core, ...newer];
    const units = facts.map((_, index) => ({ ...unit, id: `u${index + 1}`, index, ordinals: [index + 1] }));
    state.facts.set(
      slot.id,
      facts.map((text, index) => ({ unit: units[index], value: { slot, text, cite: index + 1, status: index === 0 } })),
    );
    const currentUnit = units.at(-1)!;
    state.setAbout(slot.id, unit, 'A cook from the coast.');
    await writeAbout([slot], currentUnit, state, names, 'fiction', ask, step('about'), undefined, undefined, () => ({
      outgrown: true,
      notes: ['The lockkeepers visited the tower.'],
    }));
    expect(ask.mock.calls[0][0].user.split(' | facts: ')[1].split('; ')).toEqual([
      ...core.map((fact) => `core: ${fact}`),
      ...newer.slice(2, -1),
      `new: ${newer.at(-1)}`,
    ]);
  });

  it.each([
    ['A cook, a queen, a mage, a scout, and a sailor.', 'is a comma list; write prose'],
    ['A cook who keeps the ferry running at level 5.', 'carries stat numbers'],
  ])('rewrites malformed About prose once (%s)', async (line, detail) => {
    const rewritten = 'A cook from the coast who woke in a dead queen’s body and now leads the river clans.';
    const { slot, names, ask, step } = setup(1, [{ e1: line }, { e1: rewritten }]);
    const state = new PassState();
    await writeAbout([slot], unit, state, names, 'fiction', ask, step('about'));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].user).toContain(detail);
    expect(state.currentAbout(slot.id)).toBe(rewritten);
  });

  it.each([
    ['A cook, a queen, a mage, a scout, and a sailor.', 'list'],
    ['A lockkeeper whose weather magic is Expert 4.', 'stat-numbers'],
  ])('drops malformed About prose from the describe step (%s)', async (line, reason) => {
    const { slot, names, ask, step } = setup(1, [{ e1: { about: line, n: [1] } }]);
    const describe = step('describe');
    const lines = await describeEntities([{ slot, mentions: [1] }], 'u1', names, sentences, 'fiction', ask, describe);
    expect(lines.has(slot.id)).toBe(false);
    expect(describe.record.rejected).toEqual({ [`describe:${reason}`]: 1 });
  });

  it('batches about rows by tier, each call naming its own aim', async () => {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const cast = [1, 2, 3].map((importance) =>
      entity(`e${importance}`, 'character', [1], {
        name: `Name${importance}`,
        names: [{ text: `Name${importance}`, ordinal: 1 }],
        importance: importance as 1 | 2 | 3,
      }),
    );
    const slots = new PassCast(cast).slots(unit);
    const ask = vi.fn<Ask>(() => () => Promise.resolve({ text: '{}', usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }));
    await writeAbout(
      slots,
      unit,
      new PassState(),
      namesAt(cast, 1),
      'fiction',
      ask,
      new XrayStepRun('about', 'fast', new XrayPrivacy(sentences), logger, 'runId=r'),
    );
    expect(ask.mock.calls.map(([request]) => [request.user.slice(0, 2), request.system.match(/\d+ words/)?.[0], request.effort])).toEqual([
      ['e1', '50 words', 'medium'],
      ['e2', '30 words', 'low'],
      ['e3', '20 words', 'low'],
    ]);
  });
});
