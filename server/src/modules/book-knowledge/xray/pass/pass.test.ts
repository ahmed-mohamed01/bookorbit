import { DESCRIPTION_TIERS, MAIN_TIER } from '../xray-tiers';
import { Logger } from '@nestjs/common';
import type { Sentence } from '../../core/model';
import { entity } from '../xray-fixtures.testing';
import { namesAt } from '../xray-lines';
import { DESCRIPTION_PROSE, KIND_CONTENT, LASTING_ONLY } from '../xray-description-context';
import { xrayPayload } from '../xray-payload';
import { XrayPrivacy, XrayStepRun } from '../xray-runner';
import { PassCast, type PassSlot, patternMerges } from './pass-cast';
import { passPayload } from './pass-payload';
import { fictionAboutSystem } from './pass-about-prompt';
import { changesIdentity, outgrown, writeAbout, type Ask } from './pass-run';
import { aboutText, factsAbout, PassState, spoilerSweep } from './pass-state';
import { passUnits, quoteOrdinal, type PassUnit } from './pass-units';

function book(texts: string[], paragraphOf: (index: number) => number = (index) => index, spineOf: (index: number) => number = () => 0): Sentence[] {
  return texts.map((text, index) => ({
    ordinal: index + 1,
    spineIndex: spineOf(index),
    paragraphIndex: paragraphOf(index),
    href: 'x.xhtml',
    text,
    structure: 'body' as const,
    heading: false,
    emphasis: [],
  }));
}

describe('about refresh from mentions', () => {
  const entities = [entity('e1', 'idea', [1, 2], { name: 'Deepward' })];
  const names = namesAt(entities, 2);
  const previous: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1], sectionEnd: true };
  const unit: PassUnit = { id: 'u2', index: 1, s: 1, ordinals: [2], sectionEnd: true };
  const [slot] = new PassCast(entities).slots(unit);

  function setup(...replies: Record<string, unknown>[]) {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('about', 'fast', new XrayPrivacy([]), logger, 'runId=r');
    const ask = vi.fn<Ask>(
      () => () => Promise.resolve({ text: JSON.stringify(replies.shift()), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }),
    );
    const state = new PassState();
    state.setAbout(slot.id, previous, 'A skill newly found.');
    return { ask, state, step };
  }

  it.each([
    [3, 5, true],
    [3, 4, false],
    [8, 6, false],
    [0, 5, true],
  ])('checks growth from %i old and %i new mentions', (before, after, result) => {
    expect(outgrown(before, after)).toBe(result);
  });

  it.each([true, false])('uses growth without identity facts to decide whether to send a row (%s)', async (growth) => {
    const { ask, state, step } = setup({ e1: 'A spell that warms the gate.' });
    const grown = vi.fn(() => ({ outgrown: growth, notes: ['The spell warmed the gate.'] }));
    await writeAbout([slot], unit, state, names, 'fiction', ask, step, undefined, undefined, grown);
    expect(grown).toHaveBeenCalledWith(slot, 1);
    if (growth) {
      expect(ask.mock.calls[0][0].user).toContain('new: The spell warmed the gate.');
      expect(state.about.get(slot.id)?.at(-1)).toEqual({ unit, value: 'A spell that warms the gate.' });
    } else {
      expect(ask).not.toHaveBeenCalled();
      expect(step.record.counts).toEqual({ 'about:frozen': 1 });
    }
  });

  it('rewrites a line that starts with its own name after an article', async () => {
    const { ask, state, step } = setup({ e1: 'A Deepward who guards the gate.' }, { e1: 'A spirit that guards the gate.' });
    await writeAbout([slot], unit, state, names, 'fiction', ask, step, undefined, undefined, () => ({ outgrown: true, notes: [] }));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].user).toContain('starts with its own name');
    expect(state.currentAbout(slot.id)).toBe('A spirit that guards the gate.');
  });

  it('keeps growth notes off defined concept rows', async () => {
    const { ask, state, step } = setup({ e1: 'unchanged' });
    const evidence = () => [{ ordinal: 2, text: '[Deepward: A skill that warms the gate.]', definition: true as const }];
    const grown = () => ({ outgrown: true, notes: ['The spell warmed the gate.'] });
    await writeAbout([slot], unit, state, names, 'fiction', ask, step, evidence, undefined, grown);
    expect(ask.mock.calls[0][0].user).toContain('facts: none');
    expect(ask.mock.calls[0][0].user).toContain('definition [2]');
  });

  it('drops a garbled term without a rewrite', async () => {
    const { ask, state, step } = setup({ e1: { about: 'A skill merging her studies into one scholarship.', n: [2] } });
    const evidence = () => [{ ordinal: 2, text: "Merged into the full skill: 'Deepward scholar'!" }];
    await writeAbout([slot], unit, state, names, 'fiction', ask, step, evidence, undefined, () => ({ outgrown: true, notes: [] }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(step.record.counts).toEqual({ 'about:garbled-term': 1 });
    expect(state.currentAbout(slot.id)).toBe('A skill newly found.');
  });

  it.each(DESCRIPTION_TIERS)('asks for first-appearance refreshes and exact terms ($name)', (tier) => {
    const system = fictionAboutSystem(tier);
    expect(system).toContain('A current line that only tells how the entry first appeared is replaced once the sentences show what it is or does.');
    expect(system).toContain(
      'Write the name of a skill, class, spell or item exactly as the sentences write it, in full; never reword or shorten it.',
    );
  });

  it.each(DESCRIPTION_TIERS)('asks for lasting details appropriate to the kind ($name)', (tier) => {
    const system = fictionAboutSystem(tier);
    expect(system).toContain(LASTING_ONLY);
    expect(system).toContain(KIND_CONTENT);
    expect(system).toContain(DESCRIPTION_PROSE);
  });

  it('tells the main cast writer to preserve their core facts', () => {
    expect(fictionAboutSystem(MAIN_TIER)).toContain(
      'Lines marked core say who they are in the story (where they come from, how they came to be here, their central bonds); never drop them to make room.',
    );
  });
});

describe('about rewrites', () => {
  const names = ['Solfis', 'Piper', 'Fern'];
  const entities = names.map((name, index) =>
    entity(`e${index + 1}`, 'character', [index + 1], { name, names: [{ text: name, ordinal: index + 1 }] }),
  );
  const previous: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1], sectionEnd: true };
  const unit: PassUnit = { id: 'u2', index: 1, s: 1, ordinals: [1, 2], sectionEnd: true };
  const [solfis, piper] = new PassCast(entities).slots(unit);

  function setup(...replies: Record<string, unknown>[]) {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('about', 'fast', new XrayPrivacy([]), logger, 'runId=r');
    const ask = vi.fn<Ask>(
      () => () => Promise.resolve({ text: JSON.stringify(replies.shift()), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }),
    );
    const state = new PassState();
    state.setAbout(solfis.id, previous, 'A war golem.');
    state.facts.set(solfis.id, [
      { unit: previous, value: { slot: solfis, text: 'A war golem.', cite: 1 } },
      { unit, value: { slot: solfis, text: 'Sworn to Piper.', cite: 2 } },
    ]);
    return { ask, state, step };
  }

  it('freezes a line after a scene fact and sends a new identity fact at the default temperature', async () => {
    const { ask, state, step } = setup({ e1: 'A corporal.' });
    state.facts.set(solfis.id, [{ unit, value: { slot: solfis, text: 'Walked across a road.', cite: 1 } }]);
    await writeAbout([solfis], unit, state, namesAt(entities, 2), 'fiction', ask, step);
    expect(ask).not.toHaveBeenCalled();
    expect(step.record.counts).toEqual({ 'about:frozen': 1 });
    state.facts.set(solfis.id, [{ unit, value: { slot: solfis, text: 'Promoted to corporal.', cite: 2 } }]);
    await writeAbout([solfis], unit, state, namesAt(entities, 2), 'fiction', ask, step);
    expect(ask.mock.calls[0][0].temperature).toBeUndefined();
    expect(state.currentAbout(solfis.id)).toBe('A corporal.');
  });

  it('sends id-keyed fiction rows and keeps the current line for unchanged', async () => {
    const { ask, state, step } = setup({ e1: ' unchanged ', e2: 'A captain.' });
    await writeAbout([solfis, piper], unit, state, namesAt(entities, 2), 'fiction', ask, step);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({
      system: expect.stringContaining('Answer with JSON only: {"e1": {"about": "...", "n": [1234]}, "e2": "unchanged"}.'),
      user: 'e1 | Solfis | character | current: A war golem. | facts: core: A war golem.; core: new: Sworn to Piper.\n\ne2 | Piper | character | current: none | facts: none',
    });
    expect(state.about.get(solfis.id)).toEqual([{ unit: previous, value: 'A war golem.' }]);
    expect(state.currentAbout(piper.id)).toBe('A captain.');
    expect(step.record.counts).toEqual({ 'about:unchanged': 1 });
  });

  it.each([
    ['Solfis is a war golem.', 'starts with its own name'],
    ['Possibly a war golem.', 'hedges'],
    ['An idea describing a war golem.', 'opens with a label'],
    ['A character named Golem who guards the gate.', 'opens with a label'],
    ['A war golem sworn to Fern.', 'names Fern'],
    [
      Array<string>(MAIN_TIER.limit + 1)
        .fill('word')
        .join(' '),
      `is longer than ${MAIN_TIER.limit} words`,
    ],
    ['A war golem who is bound to serve in the royal guard or army.', 'hedges with "or"'],
    ['A war golem who is bound to serve in the royal guard of the narrator.', 'says "the narrator"'],
    ['The unnamed protagonist, a war golem who wakes in a vault.', 'says "the protagonist" instead'],
  ])('retries a fiction line that fails a reader check (%s)', async (line, problem) => {
    const repaired = 'A war golem who has sworn to serve Piper as a member of the royal guard.';
    const { ask, state, step } = setup({ e1: line, e2: 'A captain.' }, { e1: repaired });
    await writeAbout([solfis, piper], unit, state, namesAt(entities, 2), 'fiction', ask, step);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].user).toContain(`- e1: "${line}" (${problem}`);
    expect(ask.mock.calls[1][0].user).not.toContain('e2 |');
    expect(state.currentAbout(solfis.id)).toBe(repaired);
    expect(step.record.rejected).toEqual({});
  });

  it('keeps the previous line when a retry returns unchanged or fails again', async () => {
    const { ask, state, step } = setup({ e1: 'Solfis is a war golem.', e2: 'Piper is a captain.' }, { e1: 'unchanged', e2: 'Piper is a medic.' });
    await writeAbout([solfis, piper], unit, state, namesAt(entities, 2), 'fiction', ask, step);
    expect(state.currentAbout(solfis.id)).toBe('A war golem.');
    expect(state.currentAbout(piper.id)).toBeNull();
    expect(step.record.counts).toEqual({ 'about:unchanged': 1 });
    expect(step.record.rejected).toEqual({ 'about:rewrite-failed': 1 });
  });

  it('shows numbered sentences and retries a line that cites none of them', async () => {
    const evidence = (slot: PassSlot) => (slot.id === solfis.id ? [{ ordinal: 1, text: 'Solfis was a war golem.' }] : []);
    const { ask, state, step } = setup(
      { e1: { about: 'A war golem sworn to Piper.', n: [7] }, e2: 'A captain.' },
      { e1: { about: 'A war golem sworn to Piper.', n: [1] } },
    );
    await writeAbout([solfis, piper], unit, state, namesAt(entities, 2), 'fiction', ask, step, evidence);
    expect(ask.mock.calls[0][0].user).toContain(
      'e1 | Solfis | character | current: A war golem. | facts: core: A war golem.; core: new: Sworn to Piper.\n  [1] Solfis was a war golem.',
    );
    expect(ask.mock.calls[1][0].user).toContain('(n must list the numbers of the given sentences the line rests on)');
    expect(state.currentAbout(solfis.id)).toBe('A war golem sworn to Piper.');
    expect(state.currentAbout(piper.id)).toBe('A captain.');
  });

  describe('concept lines', () => {
    const skill = entity('e9', 'idea', [1], { name: 'Mana Sight', names: [{ text: 'Mana Sight', ordinal: 1 }] });
    const [concept] = new PassCast([skill]).slots(unit);
    const defined = [
      { ordinal: 1, text: 'Mana Sight is a skill that shows mana.', definition: true as const },
      { ordinal: 2, text: 'Viv used Mana Sight on Solfis.' },
    ];

    it('labels the defining sentence and shows a defined concept no facts', async () => {
      const { ask, state, step } = setup({ [concept.id]: { about: 'A skill that shows mana.', n: [1] } });
      state.facts.set(concept.id, [{ unit, value: { slot: concept, text: 'Used on Solfis.', cite: 2 } }]);
      await writeAbout([concept], unit, state, namesAt([skill, ...entities], 2), 'fiction', ask, step, () => defined);
      expect(ask.mock.calls[0][0].system).toContain('When a sentence is labelled definition, the line must agree with it.');
      expect(ask.mock.calls[0][0].user).toBe(
        `${concept.id} | Mana Sight | idea | current: none | facts: none\n  definition [1] Mana Sight is a skill that shows mana.\n  [2] Viv used Mana Sight on Solfis.`,
      );
      expect(state.currentAbout(concept.id)).toBe('A skill that shows mana.');
    });

    it('keeps the facts of a concept with no defining sentence and of a character', async () => {
      const { ask, state, step } = setup({ [concept.id]: 'unchanged', e1: 'unchanged' });
      state.facts.set(concept.id, [{ unit, value: { slot: concept, text: 'Used on Solfis.', cite: 2 } }]);
      const evidence = (slot: PassSlot) => (slot.id === concept.id ? [{ ...defined[1], ordinal: 2 }] : defined);
      await writeAbout([concept, solfis], unit, state, namesAt([skill, ...entities], 2), 'fiction', ask, step, evidence);
      expect(ask.mock.calls[0][0].user).toContain(`${concept.id} | Mana Sight | idea | current: none | facts: core: new: Used on Solfis.`);
      expect(ask.mock.calls[0][0].user).toContain(
        'e1 | Solfis | character | current: A war golem. | facts: core: A war golem.; core: new: Sworn to Piper.',
      );
    });
  });

  describe('grounding', () => {
    const evidence = (slot: PassSlot) => (slot.id === solfis.id ? [{ ordinal: 1, text: 'Solfis was a war golem.' }] : []);

    it('drops a line naming someone it was not shown, without a rewrite, and tallies it', async () => {
      const { ask, state, step } = setup({ e1: { about: 'A war golem who guards Cassian.', n: [1] }, e2: 'A captain.' });
      await writeAbout([solfis, piper], unit, state, namesAt(entities, 2), 'fiction', ask, step, evidence);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(state.currentAbout(solfis.id)).toBe('A war golem.');
      expect(state.currentAbout(piper.id)).toBe('A captain.');
      expect(step.record.counts).toEqual({ 'about:ungrounded': 1 });
      expect(step.record.rejected).toEqual({});
    });

    it('checks names only and takes the shown facts and names as support', async () => {
      const { ask, state, step } = setup({ e1: { about: 'A war golem fond of millipedes, sworn to Piper.', n: [1] } });
      await writeAbout([solfis], unit, state, namesAt(entities, 2), 'fiction', ask, step, evidence);
      expect(state.currentAbout(solfis.id)).toBe('A war golem fond of millipedes, sworn to Piper.');
      expect(step.record.counts).toBeUndefined();
    });

    it('does not count the hidden facts of a defined concept as support', async () => {
      const skill = entity('e9', 'idea', [1], { name: 'Mana Sight', names: [{ text: 'Mana Sight', ordinal: 1 }] });
      const [concept] = new PassCast([skill]).slots(unit);
      const { ask, state, step } = setup({ [concept.id]: { about: 'A skill that shows mana to Cassian.', n: [1] } });
      state.facts.set(concept.id, [{ unit, value: { slot: concept, text: 'Taught by Cassian.', cite: 1 } }]);
      const shown = () => [{ ordinal: 1, text: 'Mana Sight is a skill that shows mana.', definition: true as const }];
      await writeAbout([concept], unit, state, namesAt([skill, ...entities], 2), 'fiction', ask, step, shown);
      expect(state.currentAbout(concept.id)).toBeNull();
      expect(step.record.counts).toEqual({ 'about:ungrounded': 1 });
    });

    it('gives a line that also breaks another rule its rewrite', async () => {
      const { ask, state, step } = setup({ e1: { about: 'Solfis is a war golem.', n: [1] } }, { e1: { about: 'A war golem.', n: [1] } });
      await writeAbout([solfis], unit, state, namesAt(entities, 2), 'fiction', ask, step, evidence);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(state.currentAbout(solfis.id)).toBe('A war golem.');
    });
  });

  it('asks for the main cast four at a time', async () => {
    const many = names
      .concat(['Viv', 'Arthur'])
      .map((name, index) => entity(`e${index + 1}`, 'character', [1], { name, names: [{ text: name, ordinal: 1 }] }));
    const slots = new PassCast(many).slots(unit);
    const { ask, state, step } = setup({ e1: 'A golem.', e2: 'A captain.', e3: 'A witch.', e4: 'A medic.' }, { e5: 'A dragonette.' });
    await writeAbout(slots, unit, state, namesAt(many, 2), 'fiction', ask, step);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].user.startsWith('e5 | Arthur')).toBe(true);
    expect(state.currentAbout(slots[4].id)).toBe('A dragonette.');
  });

  it('asks for the leads together at medium effort and the rest at low', async () => {
    const many = names
      .concat(['Viv', 'Arthur'])
      .map((name, index) =>
        entity(`e${index + 1}`, 'character', [1], { name, names: [{ text: name, ordinal: 1 }], importance: index === 4 ? 1 : 2 }),
      );
    const slots = new PassCast(many).slots(unit);
    const { ask, step, state } = setup({ e5: 'A dragonette.' }, { e1: 'A golem.' });
    await writeAbout(slots, unit, state, namesAt(many, 2), 'fiction', ask, step);
    expect(ask.mock.calls.map(([request]) => [request.user.slice(0, 2), request.effort])).toEqual([
      ['e5', 'medium'],
      ['e1', 'low'],
    ]);
  });

  it('continues to use name-keyed descriptions for nonfiction', async () => {
    const { ask, state, step } = setup({ lines: { Solfis: 'A fictional golem cited as an example.' } });
    await writeAbout([solfis], unit, state, namesAt(entities, 2), 'nonfiction', ask, step);
    expect(ask.mock.calls[0][0].user).toBe('- Solfis | current: A war golem. | notes: A war golem.; new: Sworn to Piper.');
    expect(state.currentAbout(solfis.id)).toBe('A fictional golem cited as an example.');
  });
});

describe('about text', () => {
  it('strips a copied item label and refuses shouted system text', () => {
    expect(aboutText('Concept: enchanted): this heirloom answers only to its family.')).toBe('This heirloom answers only to its family.');
    expect(aboutText('Concept: your coordination and speed.')).toBe('Your coordination and speed.');
    expect(aboutText('THE CITIZEN WILL BIND WITH THE CORE.')).toBeNull();
    expect(aboutText('A golem bound to Viv (her guardian): it obeys her.')).toBe('A golem bound to Viv (her guardian): it obeys her.');
  });
});

describe('identity-changing facts', () => {
  it('counts a role, kin or rank cue, a contradiction, and a relation to someone the line does not name', () => {
    const line = 'A medic who travels with Fern.';
    expect(changesIdentity('Becomes a lieutenant.', line, ['Fern', 'Pell'])).toBe(true);
    expect(changesIdentity('Is no longer a medic.', line, ['Fern'])).toBe(true);
    expect(changesIdentity('An enemy of Pell.', line, ['Fern', 'Pell'])).toBe(true);
    expect(changesIdentity('A friend of Fern.', line, ['Fern', 'Pell'])).toBe(false);
    expect(changesIdentity('Walks into the tavern with Pell.', line, ['Fern', 'Pell'])).toBe(false);
  });

  it('skips a cue word the line already says, in any case or number', () => {
    expect(changesIdentity('She is a medic.', 'A Medic who travels with Fern.', ['Fern'])).toBe(false);
    expect(changesIdentity('One of the sisters of the order.', 'A sister of the order.', [])).toBe(false);
    expect(changesIdentity('Crowned as princess.', 'One of three princesses.', [])).toBe(false);
    expect(changesIdentity('A medic and a sister.', 'A medic.', [])).toBe(true);
  });

  it('counts a denial only of a cue word or cast name the line says', () => {
    const line = 'A medic who travels with Fern across the desert.';
    expect(changesIdentity('Never travels across the desert.', line, ['Fern'])).toBe(false);
    expect(changesIdentity('Does not travel with Fern anymore.', line, ['Fern'])).toBe(true);
    expect(changesIdentity('Is not a medic.', 'A medic.', [])).toBe(true);
  });
});

describe('pass units', () => {
  const sentences = book(
    Array.from({ length: 12 }, (_, index) => `Sentence ${index + 1} is about the long road.`),
    (index) => Math.floor(index / 2),
    (index) => (index < 8 ? 0 : 1),
  );
  const sections = [
    { s: 0, ordinals: [1, 2, 3, 4, 5, 6, 7, 8] },
    { s: 1, ordinals: [9, 10, 11, 12] },
  ];

  it('reads a section whole, or in parts cut at paragraph ends when it is long', () => {
    expect(passUnits(sentences, sections).map((unit) => unit.ordinals.length)).toEqual([8, 4]);
    const parts = passUnits(sentences, sections, 150);
    expect(parts.filter((unit) => unit.s === 0).length).toBeGreaterThan(1);
    expect(parts.every((unit) => sentences[unit.ordinals[0] - 1].paragraphIndex !== sentences[unit.ordinals[0] - 2]?.paragraphIndex)).toBe(true);
    expect(parts.filter((unit) => unit.sectionEnd).map((unit) => unit.s)).toEqual([0, 1]);
  });

  it('finds a quote in its sentence', () => {
    const [unit] = passUnits(sentences, sections);
    expect(quoteOrdinal(sentences, unit, 'sentence 3 is about')).toBe(3);
    expect(quoteOrdinal(sentences, unit, 'never written')).toBeNull();
  });
});

describe('pattern merges', () => {
  const sentences = book([
    'Viviane woke early.',
    'Viv, as Viviane liked to be called, smiled.',
    'Eliezer Yudkowsky wrote it.',
    'Yudkowsky argued again.',
    'Lieutenant Cernit saluted.',
    'Cernit nodded.',
    'Arthur, the dragonette, slept.',
    'The dragonette ate.',
  ]);
  const people = [
    entity('viviane', 'character', [1, 2], { name: 'Viviane', count: 2 }),
    entity('viv', 'character', [2], { name: 'Viv', count: 5 }),
    entity('eliezer', 'character', [3], { name: 'Eliezer Yudkowsky', count: 1 }),
    entity('yud', 'character', [3, 4], { name: 'Yudkowsky', count: 4 }),
    entity('lc', 'character', [5], { name: 'Lieutenant Cernit', count: 1 }),
    entity('cernit', 'character', [5, 6], { name: 'Cernit', count: 3 }),
    entity('arthur', 'character', [7], { name: 'Arthur', count: 3 }),
    entity('dragonette', 'character', [7, 8], { name: 'dragonette', names: [{ text: 'dragonette', ordinal: 7 }] }),
  ];

  it('joins full and short names, titles and a descriptor set beside one name, where the text shows it', () => {
    const merges = patternMerges(people, sentences).map((merge) => [merge.member.name, merge.head.name, merge.ordinal, merge.rule]);
    expect(merges).toEqual(
      expect.arrayContaining([
        ['Eliezer Yudkowsky', 'Yudkowsky', 3, 'full-name'],
        ['Lieutenant Cernit', 'Cernit', 5, 'title'],
        ['Viviane', 'Viv', 2, 'short-name'],
        ['dragonette', 'Arthur', 7, 'descriptor'],
      ]),
    );
  });

  it('joins a titled name the kinds step typed apart to the one person it names, when a paragraph holds both', () => {
    const text = book(['Princess Pella waved.', 'Pella smiled at the Princess Pella.', 'The Queen Mara sailed.', 'Mara slept.']);
    const cast = [
      entity('pella', 'character', [2], { name: 'Pella', count: 9 }),
      entity('princess', 'idea', [1, 2], { name: 'Princess Pella', count: 2 }),
      entity('mara', 'character', [4], { name: 'Mara', count: 5 }),
      entity('ship', 'object', [3], { name: 'Queen Mara', count: 1 }),
    ];
    const merges = patternMerges(cast, text).map((merge) => [merge.member.name, merge.head.name, merge.rule]);
    expect(merges).toEqual([['Princess Pella', 'Pella', 'title']]);
  });

  it('lists a member on its own until its join, then under its head', () => {
    const viv = entity('viv', 'character', [3], { name: 'Viv', names: [{ text: 'Viv', ordinal: 3 }] });
    const viviane = entity('viviane', 'character', [1, 3], { name: 'Viviane', names: [{ text: 'Viviane', ordinal: 1 }] });
    const cast = new PassCast([viv, viviane]);
    cast.merge({ member: viviane, head: viv, ordinal: 3, rule: 'short-name' });
    const unit = (ordinals: number[]): PassUnit => ({ id: 'u', index: 0, s: 0, ordinals, sectionEnd: true });
    expect(cast.slots(unit([1, 2])).map((slot) => [slot.id, slot.member?.name ?? null])).toEqual([['viviane', 'Viviane']]);
    expect(cast.slots(unit([3])).map((slot) => [slot.id, slot.aliases])).toEqual([['viv', ['Viviane']]]);
  });
});

describe('stamped reads', () => {
  it('reads about, abilities and the summary as they stood by a sentence, not as they are now', () => {
    const slot = new PassCast([entity('e1', 'character', [1, 3])]).slots({ id: 'u', index: 0, s: 0, ordinals: [1, 3], sectionEnd: true })[0];
    const first: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1, 2], sectionEnd: true };
    const second: PassUnit = { id: 'u2', index: 1, s: 1, ordinals: [3, 4], sectionEnd: true };
    const state = new PassState();
    const empty = { notes: [], facts: [], ties: [], merges: [], summary: null, failed: [] };
    state.setAbout('e1', first, 'A medic.');
    state.setAbout('e1', second, 'A captain.');
    state.summaries.push({ unit: first, value: 'Viv heals.' }, { unit: second, value: 'Viv leads.' });
    state.apply(first, [slot], { ...empty, abilities: [{ slot, change: 'gained', group: 'skill', name: 'Mend', detail: null, cite: 1 }] });
    state.apply(second, [slot], { ...empty, abilities: [{ slot, change: 'gained', group: 'skill', name: 'Rally', detail: null, cite: 3 }] });
    expect([state.aboutAt('e1', 0), state.aboutAt('e1', 2), state.aboutAt('e1', 3), state.aboutAt('e1', 4)]).toEqual([
      null,
      'A medic.',
      'A medic.',
      'A captain.',
    ]);
    expect([state.summaryAt(0), state.summaryAt(2), state.summaryAt(4)]).toEqual([null, 'Viv heals.', 'Viv leads.']);
    expect(state.abilitiesText('e1', 2)).toBe('Mend (skill)');
    expect(state.abilitiesText('e1')).toBe('Mend (skill); Rally (skill)');
  });
});

describe('importance with members', () => {
  it("counts a merged member's dialogue under its name toward its head's importance", () => {
    const sentences = book(['Viv walked.', '"Come, Bob," said Ash.', '"Go, Bob," said Ash.'], undefined, (index) => index);
    const anchor = (ordinal: number) => ({ s: 0, o: ordinal, q: '', n: ordinal });
    const result = (join: boolean) => {
      const viv = entity('viv', 'character', join ? [1] : [1, 2, 3], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }], importance: 3 });
      const bob = entity('bob', 'character', [2, 3], { name: 'Bob', names: [{ text: 'Bob', ordinal: 2 }], importance: 3 });
      const cast = new PassCast(join ? [viv, bob] : [viv]);
      if (join) cast.merge({ member: bob, head: viv, ordinal: 1, rule: 'alias' });
      return passPayload({ cast, state: new PassState(), merged: { pattern: 0, model: 0 }, rewrites: 0 }, 'fiction', anchor, sentences).entities[0];
    };
    expect(result(true).importance).toBe(1);
    expect(result(false).importance).toBe(2);
  });
});

describe('pass state and chronicle', () => {
  const viv = entity('e1', 'character', [1, 2, 3], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
  const solfis = entity('e2', 'character', [3], { name: 'Solfis', names: [{ text: 'Solfis', ordinal: 3 }] });
  const units: PassUnit[] = [
    { id: 'u1', index: 0, s: 0, ordinals: [1], sectionEnd: true },
    { id: 'u2', index: 1, s: 1, ordinals: [2, 3], sectionEnd: true },
  ];
  const cast = new PassCast([viv, solfis]);
  const empty = { notes: [], facts: [], abilities: [], ties: [], merges: [], summary: null, failed: [] };
  const state = new PassState();
  const [v1] = cast.slots(units[0]);
  state.apply(units[0], [v1], {
    ...empty,
    notes: [{ slot: v1, note: 'Viv learns Yoink.', at: 1 }],
    abilities: [{ slot: v1, change: 'gained', group: 'skill', name: 'Yoink', detail: 'Beginner 1', cite: 1 }],
    facts: [{ slot: v1, text: 'Viv is a medic.', cite: 1 }],
  });
  const [v2, s2] = cast.slots(units[1]);
  state.apply(units[1], [v2, s2], {
    ...empty,
    abilities: [{ slot: v2, change: 'changed', group: 'skill', name: 'Yoink', detail: 'Beginner 2', cite: 2 }],
    ties: [{ a: v2, b: s2, type: 'friend_of', sentence: 'Viv and Solfis are friends.', cite: 3 }],
  });

  it('keeps one timeline entry per unit, full ability snapshots with the first `since`, and one description per pair', () => {
    expect(state.timeline.get('e1')!.map((entry) => entry.value.note)).toEqual(['Viv learns Yoink.', null]);
    expect(state.abilities.get('e1')!.map((snapshot) => snapshot.value.map((item) => [item.detail, item.since]))).toEqual([
      [['Beginner 1', 1]],
      [['Beginner 2', 1]],
    ]);
    expect([...state.pairs.keys()]).toEqual(['e1|e2']);
    expect(factsAbout(state.factsOf('e1'))).toBe('Viv is a medic.');
  });

  it('keeps an everyday noun with notes at the lowest importance and out of the cast ranking', () => {
    const tent = entity(
      't',
      'object',
      Array.from({ length: 14 }, (_, index) => index + 1),
      { name: 'tent', names: [{ text: 'tent', ordinal: 1 }] },
    );
    const piper = entity(
      'p',
      'character',
      Array.from({ length: 12 }, (_, index) => index + 1),
      { name: 'Piper', names: [{ text: 'Piper', ordinal: 2 }] },
    );
    const tentCast = new PassCast([tent, piper]);
    const tentState = new PassState();
    const [t1] = tentCast.slots(units[0]);
    tentState.apply(units[0], [t1], { ...empty, notes: [{ slot: t1, note: 'The tent is pitched.', at: 1 }] });
    const anchor = (ordinal: number) => ({ s: 0, o: ordinal, q: '', n: ordinal });
    const parts = passPayload(
      { cast: tentCast, state: tentState, merged: { pattern: 0, model: 0 }, rewrites: 0 },
      'fiction',
      anchor,
      book(Array(14).fill('Piper sees a tent.')).map((sentence, spineIndex) => ({ ...sentence, spineIndex })),
    );
    expect(parts.entities.map((entry) => [entry.name, entry.importance])).toEqual([
      ['tent', 3],
      ['Piper', 1],
    ]);
  });

  it('puts a named mom on the parent side and drops a skill as an owned thing and a one-way tie given both ways, whichever step found the tie', () => {
    const v = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const mom = entity('m', 'character', [1], { name: 'Mom', names: [{ text: 'Mom', ordinal: 1 }] });
    const skill = entity('s', 'idea', [1], { name: 'Ward Craft', names: [{ text: 'Ward Craft', ordinal: 1 }] });
    const kinCast = new PassCast([v, mom, skill]);
    const kinState = new PassState();
    const [vs, ms, ss] = kinCast.slots(units[0]);
    kinState.apply(units[0], [vs, ms, ss], {
      ...empty,
      ties: [
        { a: vs, b: ms, type: 'parent_of', sentence: 'Viv calls Mom.', cite: 1 },
        { a: vs, b: ss, type: 'owns', sentence: 'Viv has Ward Craft.', cite: 1 },
        { a: vs, b: ms, type: 'owns', sentence: 'Viv has Mom.', cite: 1 },
        { a: vs, b: ms, type: 'friend_of', sentence: 'Viv and Mom are friends.', cite: 1 },
        { a: ms, b: vs, type: 'friend_of', sentence: 'Mom and Viv are friends.', cite: 1 },
        { a: vs, b: ms, type: 'teaches', sentence: 'Viv teaches Mom.', cite: 1 },
        { a: ms, b: vs, type: 'teaches', sentence: 'Mom teaches Viv.', cite: 1 },
      ],
    });
    const anchor = (ordinal: number) => ({ s: 0, o: ordinal, q: '', n: ordinal });
    const parts = passPayload({ cast: kinCast, state: kinState, merged: { pattern: 0, model: 0 }, rewrites: 0 }, 'fiction', anchor);
    expect(parts.ties.map((tie) => [tie.a.name, tie.type, tie.b.name])).toEqual([
      ['Mom', 'parent_of', 'Viv'],
      ['Viv', 'friend_of', 'Mom'],
      ['Mom', 'friend_of', 'Viv'],
    ]);
  });

  it('emits the contract under payload keys, with unit ends as `through`', () => {
    const anchor = (ordinal: number) => ({ s: 0, o: ordinal, q: '', n: ordinal });
    const parts = passPayload({ cast, state, merged: { pattern: 0, model: 0 }, rewrites: 0 }, 'fiction', anchor);
    const payload = xrayPayload(
      {
        fingerprint: 'f',
        builtAt: 'now',
        language: 'en',
        models: {},
        coverage: 1,
        sections: [],
        entities: parts.entities,
        ties: parts.ties,
        lines: parts.lines,
        facts: parts.facts,
        summaries: parts.summaries,
        links: [],
        chronicle: parts.chronicle,
        covers: { s: 1, end: true, n: 3 },
      },
      anchor,
    );
    expect(payload.chronicle?.basis).toBe('now');
    expect(payload.chronicle?.covers).toEqual({ s: 1, end: true, n: 3 });
    expect(payload.chronicle?.entities.viv.timeline.map((entry) => entry.through)).toEqual([
      { s: 0, end: true, n: 1 },
      { s: 1, end: true, n: 3 },
    ]);
    expect(payload.chronicle?.entities.viv.abilities).toHaveLength(2);
    expect(Object.keys(payload.chronicle?.pairs ?? {})).toEqual(['solfis|viv']);
    expect(payload.ties.map((tie) => tie.key)).toEqual(['viv|friend_of|solfis']);
  });

  it('finds a text naming someone met later', () => {
    const late = new PassState();
    const [v] = cast.slots(units[0]);
    late.apply(units[0], [v], { ...empty, notes: [{ slot: v, note: 'Viv thinks of Solfis.', at: null }] });
    expect(spoilerSweep(late, (unit) => namesAt([viv, solfis], unit.ordinals.at(-1)!))).toEqual([{ field: 'note', id: 'e1', names: ['Solfis'] }]);
  });
});
