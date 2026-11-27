import type { XrayEntity } from '../xray-entities';
import { Logger } from '@nestjs/common';
import { AiError } from '../../../ai/ai-client.types';
import type { BookKnowledgeXrayStepId } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import { limiter, XrayPrivacy, XrayStepRun } from '../xray-runner';
import { stitchNotes, introducing as introducingWith, readNow, runDense } from './dense-run';
import type { Rejections } from '../xray-checks';
import { entity } from '../xray-fixtures.testing';
import { namesAt } from '../xray-lines';
import { DESCRIPTION_PROSE, KIND_CONTENT, LASTING_ONLY } from '../xray-description-context';
import { NARRATOR_ID, namedFirst, PassCast, patternMerges, type PassSlot } from '../pass/pass-cast';
import type { Ask } from '../pass/pass-run';
import type { PassUnit } from '../pass/pass-units';
import { citesIn, denseChunks, numberedText } from './dense-chunks';
import { factsOutputTokens, FACTS_MAX_OUTPUT_TOKENS, notesUser, requiredIds, retryUser } from './dense-prompt';
import { ALIAS_GROUPS_PER_CALL, aliasCandidates, aliasMerges, doubledLetter, joinAlias, editDistance, epithetFolds } from './dense-alias';
import { clean, contextNamesOthers, describeSystem, descriptionEvidence, descriptionProblem, sharedLines, startsWithOwnName } from './dense-describe';
import { DESCRIPTION_TIERS } from '../xray-tiers';
import { cardLine, headingPairs, LINK_CAP, SINGLE_LINK_CAP, statLine, systemLine, windowLinks } from './dense-links';
import { factsReader, NO_ACTOR, notesReader, sceneReader } from './dense-read';
import { sceneRoster, SceneSame } from './dense-scene';
import { mapTieType } from './dense-tie-map';
import { NarrationDetector, NARRATOR_SETTLED_VOTES } from './dense-narration';
import { passPayload } from '../pass/pass-payload';

function book(texts: string[], paragraphOf: (index: number) => number = (index) => index): Sentence[] {
  return texts.map((text, index) => ({
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: paragraphOf(index),
    href: 'x.xhtml',
    text,
    structure: 'body' as const,
    heading: false,
    emphasis: [],
  }));
}

const unitOf = (ordinals: number[], sectionEnd = true): PassUnit => ({ id: 'u1', index: 0, s: 0, ordinals, sectionEnd });

describe('about evidence', () => {
  const slotOf = (entity: ReturnType<typeof entityOf>) =>
    ({ id: 'e1', head: entity, member: null, name: entity.name, aliases: [], kind: entity.kind }) as unknown as PassSlot;
  const entityOf = (ordinals: number[], defining: number[] = [], kind: 'character' | 'idea' = 'character', name = 'Solfis') => {
    const made = entity('solfis', kind, ordinals, { name });
    made.defining = new Set(defining);
    return made;
  };

  const texts = (found: { text: string }[]) => found.map((sentence) => sentence.text);
  const introducing = (slot: PassSlot, unit: PassUnit, sentences: Sentence[]) => introducingWith(slot, unit, sentences, new PassCast([slot.head]));

  it('shows a head only its own sentences and those of members joined by the unit, never a member line before the join', () => {
    const sentences = book(['The hooded man watched.', 'Kaladin ran.', 'Kaladin is a soldier.', 'Later.', 'The hooded man was Kaladin.']);
    const kaladin = entity('kaladin', 'character', [2, 3, 5], { name: 'Kaladin' });
    const hooded = entity('hooded', 'character', [1, 5], { name: 'hooded man' });
    const cast = new PassCast([kaladin, hooded]);
    cast.merge({ member: hooded, head: kaladin, ordinal: 5, rule: 'alias' });
    const unit = unitOf([1, 2, 3]);
    const slot = cast.slots(unit).find((candidate) => candidate.head === kaladin && candidate.member === null)!;
    expect(introducingWith(slot, unit, sentences, cast).map((sentence) => sentence.ordinal)).toEqual([2, 3]);
  });

  it('shows where an entry is defined, first met and last seen, numbered and never past the unit', () => {
    const sentences = book(['Solfis walked.', 'Solfis is a war golem.', 'Solfis waited.', 'Solfis left.']);
    expect(introducing(slotOf(entityOf([1, 2, 3, 4], [2])), unitOf([1, 2, 3]), sentences)).toEqual([
      { ordinal: 1, text: 'Solfis walked.' },
      { ordinal: 2, text: 'Solfis is a war golem.' },
      { ordinal: 3, text: 'Solfis waited.' },
    ]);
    expect(texts(introducing(slotOf(entityOf([1, 2, 3, 4])), unitOf([1]), sentences))).toEqual(['Solfis walked.']);
  });

  it("leaves an inset letter out of the narrator's evidence and keeps it for anyone else", () => {
    const sentences = book(['I unpacked the crate.', 'I am Mira, and I found the reef.', 'I kept the lamp lit.']);
    sentences[1].inset = true;
    const narrator = entity(NARRATOR_ID, 'character', [1, 2, 3], { name: 'Narrator' });
    const slot = { id: NARRATOR_ID, head: narrator, member: null, name: 'Narrator', aliases: [], kind: 'character' } as unknown as PassSlot;
    expect(texts(introducing(slot, unitOf([1, 2, 3]), sentences))).toEqual(['I unpacked the crate.', 'I kept the lamp lit.']);
    expect(texts(introducing(slotOf(entityOf([1, 2, 3])), unitOf([1, 2, 3]), sentences))).toContain('I am Mira, and I found the reef.');
    expect(descriptionEvidence([1, 2, 3], sentences, [], true).mentions).toEqual([1, 3]);
    expect(descriptionEvidence([3], sentences, [], true).context).toEqual([]);
    expect(descriptionEvidence([3], sentences).context).toEqual([2]);
  });

  it('puts plain prose before shouted system text', () => {
    const sentences = book(['//SOLFIS STATUS REPORT, CITIZEN.', 'Solfis was a war golem.', '//SOLFIS AWAITS ORDERS.']);
    expect(texts(introducing(slotOf(entityOf([1, 2, 3])), unitOf([1, 2, 3]), sentences))).toEqual(['Solfis was a war golem.']);
  });

  it('leaves front matter out and spreads identity sentences across a long run', () => {
    const sentences = book([
      'Solfis is the hero of this serial, now on sale.',
      ...Array.from({ length: 30 }, (_, index) => {
        const mark = `${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`;
        return index % 3 ? `Solfis walked to ${mark}.` : `Solfis was a war golem ${mark}.`;
      }),
    ]);
    sentences[0].structure = 'front';
    const found = introducing(
      slotOf(entityOf(sentences.map((sentence) => sentence.ordinal))),
      unitOf(sentences.map((sentence) => sentence.ordinal)),
      sentences,
    );
    expect(found.map((sentence) => sentence.ordinal)).not.toContain(1);
    expect(found).toHaveLength(8);
    expect(found.filter((sentence) => sentence.text.includes('war golem')).length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...found.map((sentence) => sentence.ordinal)) - Math.min(...found.map((sentence) => sentence.ordinal))).toBeGreaterThan(20);
  });

  it('drops bare labels and repeated lines without putting anything in their place', () => {
    const sentences = book(['Solfis 7/8', 'Solfis walked 3 miles.', 'Solfis walked 4 miles.', 'Solfis:', 'Solfis waited.']);
    expect(texts(introducing(slotOf(entityOf([1, 2, 3, 4, 5])), unitOf([1, 2, 3, 4, 5]), sentences))).toEqual([
      'Solfis walked 3 miles.',
      'Solfis waited.',
    ]);
  });

  it('leads a concept with its defining sentence, labelled', () => {
    const sentences = book(['Viv used Mana Sight.', 'She frowned.', 'Mana Sight is a skill that shows mana.', 'Viv used Mana Sight again.']);
    const found = introducing(slotOf(entityOf([1, 3, 4], [], 'idea', 'Mana Sight')), unitOf([1, 2, 3, 4]), sentences);
    expect(found[0]).toEqual({ ordinal: 3, text: 'Mana Sight is a skill that shows mana.', definition: true });
    expect(found.slice(1).map((sentence) => sentence.ordinal)).toEqual([1, 4]);
    expect(found.slice(1).some((sentence) => sentence.definition)).toBe(false);
  });

  it('never labels a definition for a character', () => {
    const sentences = book(['Solfis is a war golem.', 'Solfis waited.']);
    expect(introducing(slotOf(entityOf([1, 2])), unitOf([1, 2]), sentences).some((sentence) => sentence.definition)).toBe(false);
  });

  it('labels a sentence from a quoted letter as written', () => {
    const sentences = book(['Solfis is a war golem.', 'I sent Solfis north myself.']).map((sentence) =>
      sentence.ordinal === 2 ? { ...sentence, inset: true } : sentence,
    );
    const found = introducing(slotOf(entityOf([1, 2])), unitOf([1, 2]), sentences);
    expect(found.find((sentence) => sentence.ordinal === 2)?.written).toBe(true);
    expect(found.find((sentence) => sentence.ordinal === 1)?.written).toBeUndefined();
  });

  it('samples a concept from prose identity, not from every system line', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `[Mana Sight used on ${String.fromCharCode(97 + index)}]`);
    const sentences = book([...lines, 'Mana Sight was the gift of her teacher.', 'Viv used Mana Sight.']);
    const ordinals = sentences.map((sentence) => sentence.ordinal);
    const concept = introducing(slotOf(entityOf(ordinals, [], 'idea', 'Mana Sight')), unitOf(ordinals), sentences);
    const character = introducing(slotOf(entityOf(ordinals, [], 'character', 'Mana Sight')), unitOf(ordinals), sentences);
    expect(concept.filter((sentence) => sentence.text.startsWith('[')).length).toBeLessThan(
      character.filter((sentence) => sentence.text.startsWith('[')).length,
    );
  });
});

describe('dense chunks', () => {
  const sentences = book(
    Array.from({ length: 250 }, (_, index) => `Sentence ${index + 1}.`),
    (index) => Math.floor(index / 7),
  );
  const unit = unitOf(sentences.map((sentence) => sentence.ordinal));

  it('cuts a unit into chunks of about a hundred sentences at paragraph ends; only the last ends the section', () => {
    const chunks = denseChunks(sentences, unit);
    expect(chunks.map((chunk) => chunk.ordinals.length).reduce((a, b) => a + b)).toBe(250);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks.slice(1))
      expect(sentences[chunk.ordinals[0] - 1].paragraphIndex).not.toBe(sentences[chunk.ordinals[0] - 2].paragraphIndex);
    expect(chunks.map((chunk) => chunk.sectionEnd)).toEqual([false, false, true]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(['u1c1', 'u1c2', 'u1c3']);
  });

  it('numbers each sentence and keeps a paragraph on one line', () => {
    const text = numberedText(sentences, [1, 2, 8]);
    expect(text).toBe('[1] Sentence 1. [2] Sentence 2.\n[8] Sentence 8.');
  });

  it('sets a run of inset sentences between written tags', () => {
    const marked = sentences.map((sentence) => (sentence.ordinal === 3 || sentence.ordinal === 4 ? { ...sentence, inset: true } : sentence));
    const text = numberedText(marked, [2, 3, 4, 5]);
    expect(text.split('\n')).toEqual(['[2] Sentence 2.', '<written>', '[3] Sentence 3. [4] Sentence 4.', '</written>', '[5] Sentence 5.']);
    expect(numberedText(marked, [3])).toBe('<written>\n[3] Sentence 3.\n</written>');
    const user = notesUser(text, [], { about: new Map(), abilities: new Map(), previous: null }, 'fiction');
    expect(user).toContain("Their 'I' and 'we' are its writer, never the narrator");
    expect(notesUser('[1] text', [], { about: new Map(), abilities: new Map(), previous: null }, 'fiction')).not.toContain('<written>');
  });

  it('keeps cited numbers inside the chunk and counts the rest', () => {
    const inside = new Set([10, 11, 12]);
    expect(citesIn([12, '[10]', 99], inside)).toEqual({ cites: [10, 12], outside: 1 });
    expect(citesIn(11, inside)).toEqual({ cites: [11], outside: 0 });
    expect(citesIn([10, 11, 12, 10], inside, 2).cites).toEqual([10, 11]);
  });
});

describe('lenient tie types', () => {
  it('maps case, spacing, plurals, ally and synonyms to the allowed set, and swaps sides for a reversed one', () => {
    expect(mapTieType('friend_of', 'fiction')).toMatchObject({ info: { type: 'friend_of' }, mapped: null });
    expect(mapTieType('Friend Of', 'fiction')?.info.type).toBe('friend_of');
    expect(mapTieType('friends', 'fiction')?.info.type).toBe('friend_of');
    expect(mapTieType('allies', 'fiction')).toMatchObject({ info: { type: 'friend_of' }, reversed: false, mapped: 'allies->friend_of' });
    expect(mapTieType('enemies', 'fiction')?.info.type).toBe('enemy_of');
    expect(mapTieType('daughter_of', 'fiction')).toMatchObject({ info: { type: 'parent_of' }, reversed: true });
    expect(mapTieType('causes', 'nonfiction')?.info.type).toBe('leads_to');
    expect(mapTieType('admires', 'fiction')).toBeUndefined();
    expect(mapTieType('friend_of', 'nonfiction')).toBeUndefined();
  });
});

describe('merge guard', () => {
  const sentences = book(['The Kark woman spoke.', 'Kark answered.', 'Lieutenant Cernit saluted.', 'Cernit nodded.']);
  const people = () => [
    entity('kw', 'character', [1], { name: 'Kark woman', count: 1 }),
    entity('kark', 'character', [2], { name: 'Kark', count: 4 }),
    entity('lc', 'character', [3], { name: 'Lieutenant Cernit', count: 1 }),
    entity('cernit', 'character', [3, 4], { name: 'Cernit', count: 3 }),
  ];

  it('keeps a descriptor apart from a name, but still joins a rank before the same name', () => {
    const open = patternMerges(people(), sentences).map((merge) => merge.member.name);
    expect(open).toContain('Kark woman');
    const guarded = patternMerges(people(), sentences, { guard: true }).map((merge) => [merge.member.name, merge.rule]);
    expect(guarded).toEqual([['Lieutenant Cernit', 'title']]);
  });
});

describe('dense readers', () => {
  const sentences = book([
    'Viv met Solfis on the deck.',
    'Solfis is the ship, and Viv is its captain and lives aboard.',
    'Viv gained Fire Bolt at Beginner 2.',
    'Viv and Solfis argued.',
    'Viv, called the Red, laughed.',
  ]);
  const viv = entity('e1', 'character', [1, 2, 3, 4, 5], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
  const solfis = entity('e2', 'character', [1, 2, 4], { name: 'Solfis', names: [{ text: 'Solfis', ordinal: 1 }] });
  const red = entity('e3', 'character', [5], { name: 'the Red', names: [{ text: 'the Red', ordinal: 5 }] });
  const fern = entity('e4', 'character', [6], { name: 'Fern', names: [{ text: 'Fern', ordinal: 6 }] });
  const unit = unitOf([1, 2, 3, 4, 5]);
  const cast = new PassCast([viv, solfis, red, fern]);
  const slots = cast.slots(unit);
  const input = { chunk: unit, slots, sentences, mode: 'fiction' as const, names: namesAt([viv, solfis, red, fern], 5) };

  it('lists the ids named three or more times as required, and names them in the prompt and the retry', () => {
    expect(requiredIds(slots, 'fiction')).toEqual(['e1', 'e2']);
    const user = notesUser('[1] text', slots, { about: new Map(), abilities: new Map(), previous: null }, 'fiction');
    expect(user).toContain('Required: e1, e2');
    expect(retryUser(user, ['e2'], [])).toContain('left out these Required ids: e2');
  });

  it.each([
    'Viv is named once, but no action occurs.',
    'Viv is mentioned only in passing.',
    'Viv is not described.',
    'Viv does not appear in this stretch.',
    'Viv, a name, is not present in this stretch.',
  ])('treats a note about nothing happening as null: %s', (note) => {
    const read = notesReader(input, {});
    expect(read({ notes: { e1: note, e2: 'Solfis stops the attack before it happens.' } })?.items).toMatchObject({
      nulls: [{ id: 'e1' }],
      notes: [{ slot: { id: 'e2' }, note: 'Solfis stops the attack before it happens.' }],
      failed: [],
    });
  });

  it.each([' and [12] more', ' then n: 12 again'])('routes citation residue inside a note through note failure: %s', (suffix) => {
    const note = `Viv opens the door${suffix}.`;
    expect(notesReader(input, {})({ notes: { e1: { note, n: [1] } } })?.items).toMatchObject({
      notes: [],
      failed: [{ field: 'notes', id: 'e1', text: note, detail: 'contains inline citation markers' }],
    });
  });

  describe('notes on places, objects and ideas', () => {
    const tavia = entity('t1', 'character', [1, 2], { name: 'Tavia Marsh' });
    const wardens = entity('t2', 'group', [2], { name: 'the Ash Wardens' });
    const mill = entity('t3', 'place', [1, 2], { name: 'Greywater Mill' });
    const key = entity('t4', 'object', [1, 2], { name: 'ember key' });
    const place = { chunk: unit, sentences, mode: 'fiction' as const, names: namesAt([tavia, wardens, mill, key], 5) };
    const read = (notes: Record<string, string>, extra: Partial<Parameters<typeof notesReader>[0]> = {}) =>
      notesReader(
        { ...place, slots: new PassCast([tavia, wardens, mill, key]).slots(unit), ...extra },
        {},
      )({ notes: Object.fromEntries(Object.entries(notes).map(([id, note]) => [id, { note, n: [1] }])) })?.items;

    it('keeps a place or object note led by a character or group, by a word of a full name too', () => {
      expect(
        read({ t3: 'Tavia hides the ember key under the floor of Greywater Mill.', t4: 'The Ash Wardens melt the ember key down.' }),
      ).toMatchObject({ notes: [{ slot: { id: 't3' } }, { slot: { id: 't4' } }], failed: [] });
    });

    it('sends a note on a thing that names no one acting back for a rewrite, and leaves character notes alone', () => {
      expect(read({ t1: 'The storm keeps her awake all night.', t4: 'The ember key glows faintly in the dark.' })).toMatchObject({
        notes: [{ slot: { id: 't1' } }],
        failed: [{ field: 'notes', id: 't4', detail: NO_ACTOR }],
      });
    });

    it('takes the actor from the whole cast when a re-ask narrows the slots', () => {
      const cast = new PassCast([tavia, wardens, mill, key]).slots(unit);
      const items = read({ t4: 'Tavia turns the ember key twice.' }, { slots: cast.filter((slot) => slot.id === 't4'), cast });
      expect(items).toMatchObject({ notes: [{ slot: { id: 't4' } }], failed: [] });
    });

    it('counts the unnamed narrator called the narrator as the one acting', () => {
      const narrator = entity(NARRATOR_ID, 'character', [1], { name: 'Narrator' });
      const items = notesReader(
        { ...place, slots: new PassCast([narrator, key]).slots(unit), narratorId: NARRATOR_ID },
        {},
      )({ notes: { t4: { note: 'The narrator pockets the ember key.', n: [1] } } })?.items;
      expect(items).toMatchObject({ notes: [{ slot: { id: 't4' } }], failed: [] });
    });

    it('leaves a nonfiction note on a term alone', () => {
      expect(read({ t4: 'The ember key is a test of the theory of heat.' }, { mode: 'nonfiction' })).toMatchObject({
        notes: [{ slot: { id: 't4' } }],
        failed: [],
      });
    });
  });

  it('sends a first-person note back for a rewrite, but lets quoted speech say I', () => {
    const note = 'I climb the ladder and Viv follows.';
    expect(
      notesReader(input, {})({ notes: { e1: { note, n: [1] }, e2: { note: 'Solfis says “I will hold the gate.”', n: [1] } } })?.items,
    ).toMatchObject({
      notes: [{ slot: { id: 'e2' } }],
      failed: [{ field: 'notes', id: 'e1', detail: 'is written in the first person; name the narrator instead of "I"' }],
    });
  });

  it('lets the unnamed narrator and a summary of their chunk be called the narrator, and no one else', () => {
    const narrator = entity(NARRATOR_ID, 'character', [1], { name: 'Narrator' });
    const told = new PassCast([narrator, solfis]);
    const read = notesReader({ ...input, slots: told.slots(unit), narratorId: NARRATOR_ID }, {});
    const answer = read({
      notes: {
        [NARRATOR_ID]: { note: 'The narrator wakes strapped to a bed and cannot recall his own name.', n: [1] },
        e2: { note: 'Solfis guards the narrator.', n: [2] },
      },
      summary: 'The narrator wakes in a strange room with tubes in his arm.',
    })?.items;
    expect(answer).toMatchObject({
      notes: [{ slot: { id: NARRATOR_ID } }],
      failed: [{ field: 'notes', id: 'e2', detail: 'says "the narrator" instead of a name' }],
      summary: 'The narrator wakes in a strange room with tubes in his arm.',
    });
    expect(notesReader(input, {})({ notes: {}, summary: 'The narrator wakes.' })?.items.failed).toMatchObject([{ field: 'summary' }]);
  });

  it.each([
    ['Viv opens the door. | n: [1,2]', 'Viv opens the door.'],
    ['Viv opens the door. n: [2]', 'Viv opens the door.'],
    ['Viv opens the door. (n1, n2)', 'Viv opens the door.'],
  ])('keeps a trailing reference list as the cites when n is empty: %s', (written, note) => {
    expect(notesReader(input, {})({ notes: { e1: { note: written, n: [] } } })?.items).toMatchObject({
      notes: [{ slot: { id: 'e1' }, note, cites: [1, 2].filter((cite) => written.includes(String(cite))) }],
      failed: [],
    });
  });

  it('strips a trailing reference list but keeps the n field when both are given', () => {
    expect(notesReader(input, {})({ notes: { e1: { note: 'Viv opens the door. | n: [2]', n: [1] } } })?.items).toMatchObject({
      notes: [{ slot: { id: 'e1' }, note: 'Viv opens the door.', cites: [1] }],
    });
  });

  it('reads notes keyed by id, nulls and cites, and counts a cite outside the chunk', () => {
    const rejected: Rejections = {};
    const read = notesReader(
      input,
      rejected,
    )({
      notes: { e1: { note: 'Viv meets Solfis.', n: [1, 40] }, e2: null, e9: { note: 'x', n: [1] } },
      summary: 'Viv meets Solfis.',
    });
    expect(read?.items.notes.map((note) => [note.slot.id, note.cites])).toEqual([['e1', [1]]]);
    expect(read?.items.nulls.map((slot) => slot.id)).toEqual(['e2']);
    expect([...read!.items.answered]).toEqual(['e1', 'e2']);
    expect(rejected).toMatchObject({ 'notes:cite-outside': 1, 'notes:unknown-id': 1 });
  });

  it('accepts a forty-word note and sends a forty-one-word note back', () => {
    const note = (count: number) => ['Viv', ...Array.from({ length: count - 1 }, () => 'walks')].join(' ');
    const read = notesReader(input, {})({ notes: { e1: { note: note(100), n: [1] }, e2: { note: note(101), n: [1] } }, summary: '' });
    expect(read?.items.notes.map((item) => item.slot.id)).toEqual(['e1']);
    expect(read?.items.failed).toEqual([expect.objectContaining({ field: 'notes', id: 'e2', detail: 'is longer than 100 words' })]);
  });

  it('keeps an ability only when its own name is in the cited sentence, and a merge only on a sentence saying so', () => {
    const rejected: Rejections = {};
    const read = factsReader(
      input,
      rejected,
    )({
      identity: [{ id: 'e1', fact: 'Viv is the captain of the ship Solfis.', n: [2] }],
      abilities: [
        { id: 'e1', change: 'gained', group: 'spell', name: 'Fire Bolt', detail: 'Beginner 2', n: [3] },
        { id: 'e1', change: 'gained', group: 'skill', name: 'skill', n: [3] },
        { id: 'e1', change: 'gained', group: 'spell', name: 'Ice Lance', n: [3] },
      ],
      merges: [
        { a: 'e1', b: 'e3', n: [5] },
        { a: 'e1', b: 'e2', n: [4] },
      ],
    });
    expect(read?.items.facts.map((fact) => [fact.slot.id, fact.cite])).toEqual([['e1', 2]]);
    expect(read?.items.abilities.map((ability) => ability.name)).toEqual(['Fire Bolt']);
    expect(read?.items.merges.map((merge) => [merge.a.id, merge.b.id])).toEqual([['e1', 'e3']]);
    expect(rejected).toMatchObject({
      'abilities:generic-name': 1,
      'abilities:name-not-in-sentence': 1,
      'merges:not-stated': 1,
    });
  });

  it("checks an unnamed narrator's gender against the fact's own cited sentences", () => {
    const narrator = entity(NARRATOR_ID, 'character', [1, 2], { name: 'Narrator' });
    const told = book(['I hung my fins by the door.', 'I am a man who spent thirty years under the reef.']);
    const chunk = unitOf([1, 2]);
    const narrated = {
      chunk,
      slots: new PassCast([narrator]).slots(chunk),
      sentences: told,
      mode: 'fiction' as const,
      names: namesAt([narrator], 2),
    };
    const rejected: Rejections = {};
    const read = factsReader(narrated, rejected)({ identity: [{ id: NARRATOR_ID, fact: 'He is a retired diver.', n: [2] }] });
    expect(read?.items.facts.map((fact) => fact.text)).toEqual(['He is a retired diver.']);
    const guessed = factsReader(narrated, {})({ identity: [{ id: NARRATOR_ID, fact: 'He is a retired diver.', n: [1] }] });
    expect(guessed?.items.facts).toEqual([]);
  });

  it('drops a fact with no cite inside the chunk', () => {
    const rejected: Rejections = {};
    const read = factsReader(input, rejected)({ identity: [{ id: 'e1', fact: 'Viv is a captain.', n: [77] }] });
    expect(read?.items.facts).toEqual([]);
    expect(rejected).toMatchObject({ 'identity:cite-outside': 1, 'identity:no-cite': 1 });
  });

  it('reads scene ids and names, swaps a directional relation to fit, and keeps related and unknown types as links', () => {
    const port = entity('e5', 'place', [2], { name: 'Port', names: [{ text: 'Harbour', ordinal: 2 }] });
    const rejected: Rejections = {};
    const read = sceneReader(
      { ...input, slots: new PassCast([viv, solfis, red, port]).slots(unit) },
      rejected,
    )({
      pov: '*e1',
      same: [
        { id: 'e1', same_as: 'e3', n: 5 },
        { id: 'e1', same_as: 'e90', n: 4 },
        { id: 'e1', same_as: 'e1', n: 4 },
        { id: 'e1', same_as: 'e3', n: 99 },
        { id: 'e1', same_as: 'Red', n: 5 },
      ],
      relations: [
        { a: 'the HARBOUR', type: 'lives_at', b: 'e1', sentence: 'Viv lives at Port.', n: [2] },
        { a: 'e2', type: 'Allies', b: 'the viv', sentence: 'Viv and Solfis are allies.', n: [2] },
        { a: 'e1', type: 'related', b: 'Red', sentence: 'Viv and the Red are connected.', n: [5] },
        { a: 'e1', type: 'admires', b: 'e3', sentence: 'Viv admires the Red.', n: [5] },
        { a: 'e1', type: 'friend_of', b: 'e4', sentence: 'Viv and Fern are friends.', n: [4] },
        { a: 'Viv', type: 'friend_of', b: 'e1', sentence: 'Viv is her own friend.', n: [4] },
        { a: 'e5', type: 'loves', b: 'e1', sentence: 'Viv loves Port.', n: [2] },
      ],
    });
    expect(read?.items.pov).toBe('e1');
    expect(read?.items.same.map(({ a, b, cite }) => [a.id, b.id, cite])).toEqual([
      ['e1', 'e3', 5],
      ['e1', 'e3', null],
      ['e1', 'e3', 5],
    ]);
    expect(read?.items.ties.map((tie) => [tie.a.id, tie.type, tie.b.id])).toEqual([
      ['e1', 'lives_at', 'e5'],
      ['e1', 'friend_of', 'e2'],
    ]);
    expect(read?.items.linkPairs.map(({ a, b, cite }) => [a.id, b.id, cite])).toEqual([
      ['e1', 'e5', 2],
      ['e1', 'e2', 2],
      ['e1', 'e3', 5],
      ['e1', 'e3', 5],
      ['e5', 'e1', 2],
    ]);
    expect(read?.items.relations).toBe(7);
    expect(read?.items.mapped).toEqual({ 'Allies->friend_of': 1 });
    expect(rejected).toEqual({
      'scene:same-unknown': 1,
      'scene:same-self': 1,
      'ties:related': 1,
      'ties:unknown-type': 1,
      'ties:not-the-pair': 2,
      'ties:kinds-link': 1,
    });
  });

  describe('borrowed scene ids', () => {
    const scene = (lines: string[], entities: XrayEntity[]) => {
      const sentences = book(lines);
      const chunk = unitOf(sentences.slice(1).map(({ ordinal }) => ordinal));
      const cast = new PassCast(entities);
      const slots = cast.slots(
        chunk,
        sentences.map(({ ordinal }) => ordinal),
      );
      const mentions = new Map(slots.map((slot) => [slot.id, new Set(cast.mentionsOf(slot, chunk, chunk.ordinals))]));
      return { chunk, slots, sentences, mode: 'fiction' as const, names: namesAt(entities, sentences.length), mentions };
    };

    const emericScene = () =>
      scene(
        ['Emeric left the city.', 'Viv spoke with Damien.', 'Fraise arrived.', 'The gate closed.'],
        [
          entity('viv', 'character', [2], { name: 'Viv' }),
          entity('emeric', 'character', [1], { name: 'Emeric' }),
          entity('damien', 'character', [2], { name: 'Damien' }),
          entity('fraise', 'character', [3], { name: 'Fraise' }),
        ],
      );
    const emericAnswer = {
      pov: 'emeric',
      same: [{ id: 'viv', same_as: 'emeric', n: [2] }],
      relations: [
        { a: 'emeric', type: 'related', b: 'damien', sentence: 'Emeric knows Damien.', n: [2] },
        { a: 'emeric', type: 'parent_of', b: 'damien', sentence: 'Emeric is the parent of Damien.', n: [2] },
        { a: 'emeric', type: 'related', b: 'fraise', sentence: 'Emeric knows Fraise.', n: [3] },
      ],
    };

    it.each(['fiction', 'nonfiction'] as const)('rejects an unnamed point of view and its claims in %s', (mode) => {
      const rejected: Rejections = {};
      const read = sceneReader({ ...emericScene(), mode }, rejected)(emericAnswer);
      expect(read?.items).toMatchObject({ pov: null, same: [], linkPairs: [], ties: [] });
      expect(rejected).toEqual({ 'scene:pov-not-in-scene': 1, 'scene:same-borrowed': 1, 'ties:borrowed-id': 3 });
    });

    it('keeps relations to characters referred to by epithets and moves their citations to the chunk end', () => {
      const input = scene(
        ['Solfis and Arthur waited.', 'Viv felt her bond with the golem.', 'Viv picked up her dragonette.', 'The gate closed.'],
        [
          entity('viv', 'character', [2, 3], { name: 'Viv' }),
          entity('solfis', 'character', [1], { name: 'Solfis' }),
          entity('arthur', 'character', [1], { name: 'Arthur' }),
        ],
      );
      const rejected: Rejections = {};
      const read = sceneReader(
        input,
        rejected,
      )({
        pov: 'viv',
        relations: [
          { a: 'viv', type: 'bonded_to', b: 'solfis', sentence: 'Viv is bonded to Solfis.', n: [2] },
          { a: 'viv', type: 'owns', b: 'arthur', sentence: 'Viv owns Arthur.', n: [3] },
        ],
      });
      expect(read?.items.linkPairs.map(({ a, b, cite }) => [a.id, b.id, cite])).toEqual([
        ['solfis', 'viv', 4],
        ['viv', 'arthur', 4],
      ]);
      expect(rejected['ties:cite-moved']).toBe(2);
      expect(rejected['ties:borrowed-id']).toBeUndefined();
    });

    it('rejects a relation to an unnamed id claimed to be the same as a different head', () => {
      const input = scene(
        ['The Sergeant left.', 'Viv met her friend Mouq.', 'The gate closed.'],
        [
          entity('viv', 'character', [2], { name: 'Viv' }),
          entity('mouq', 'character', [2], { name: 'Mouq' }),
          entity('sergeant', 'character', [1], { name: 'Sergeant' }),
        ],
      );
      input.mentions.delete('sergeant');
      const rejected: Rejections = {};
      const read = sceneReader(
        input,
        rejected,
      )({
        pov: 'viv',
        same: [{ id: 'mouq', same_as: 'sergeant', n: [2] }],
        relations: [
          { a: 'viv', type: 'works_for', b: 'sergeant', sentence: 'Viv works for the Sergeant.', n: [2] },
          { a: 'viv', type: 'friend_of', b: 'mouq', sentence: 'Viv and Mouq are friends.', n: [2] },
        ],
      });
      expect(read?.items).toMatchObject({
        pov: 'viv',
        same: [{ a: { id: 'mouq' }, b: { id: 'sergeant' } }],
        linkPairs: [{ a: { id: 'mouq' }, b: { id: 'viv' }, cite: 2 }],
        ties: [{ type: 'friend_of' }],
      });
      expect(rejected).toEqual({ 'ties:borrowed-id': 1 });
    });

    it('keeps a first-person point of view and its relation when the narrator has no mentions', () => {
      const input = scene(
        ['My name is Viv.', 'I walked with my friend Damien.', 'The gate closed.'],
        [entity(NARRATOR_ID, 'character', [1], { name: 'Viv' }), entity('damien', 'character', [2], { name: 'Damien' })],
      );
      const rejected: Rejections = {};
      const read = sceneReader(
        { ...input, firstPerson: true },
        rejected,
      )({
        pov: NARRATOR_ID,
        relations: [{ a: NARRATOR_ID, type: 'friend_of', b: 'damien', sentence: 'Viv and Damien are friends.', n: [2] }],
      });
      expect(read?.items).toMatchObject({
        pov: NARRATOR_ID,
        linkPairs: [{ a: { id: 'damien' }, b: { id: NARRATOR_ID }, cite: 3 }],
        ties: [{ type: 'friend_of', cite: 3 }],
      });
      expect(rejected).toEqual({ 'ties:cite-moved': 1 });
    });

    it('keeps the point of view, same claim and cited relations when no mention map was provided', () => {
      const rejected: Rejections = {};
      const read = sceneReader({ ...emericScene(), mentions: undefined }, rejected)(emericAnswer);
      expect(read?.items.pov).toBe('emeric');
      expect(read?.items.same).toHaveLength(1);
      expect(read?.items.linkPairs.map(({ cite }) => cite)).toEqual([2, 2, 3]);
      expect(read?.items.ties.map(({ cite }) => cite)).toEqual([2]);
      expect(rejected).toEqual({ 'ties:related': 2 });
    });
  });

  it('counts an entry paired with itself apart from a pair the cast already joined', () => {
    const [own] = new PassCast([viv]).slots(unit);
    const member: PassSlot = { ...own, id: 'e9', member: entity('e9', 'character', [5], { name: 'the Captain' }), name: 'the Captain', aliases: [] };
    const rejected: Rejections = {};
    sceneReader(
      { ...input, slots: [own, member] },
      rejected,
    )({
      pov: null,
      same: [
        { id: 'e1', same_as: 'e1' },
        { id: 'e9', same_as: 'e1' },
      ],
      relations: [],
    });
    expect(rejected).toEqual({ 'scene:same-self': 1, 'scene:same-already': 1 });
  });

  it('links a relation given without a number at the first sentence naming both, shows its label at the stretch end, and drops it when none does', () => {
    const rejected: Rejections = {};
    const read = sceneReader(
      input,
      rejected,
    )({
      pov: null,
      same: [],
      relations: [
        { a: 'e2', type: 'friend_of', b: 'e1', sentence: 'Viv and Solfis are friends.' },
        { a: 'e2', type: 'friend_of', b: 'e3', sentence: 'Solfis and the Red are friends.' },
      ],
    });
    expect(read?.items.ties.map((tie) => [tie.a.id, tie.b.id, tie.cite])).toEqual([['e1', 'e2', 5]]);
    expect(read?.items.linkPairs.map((pair) => pair.cite)).toEqual([1]);
    expect(rejected['ties:cite-found']).toBe(1);
    expect(rejected['ties:no-cite']).toBe(1);
  });

  it("moves a tie cited on a sentence that does not name both sides to the chunk's last sentence", () => {
    const rejected: Rejections = {};
    const mentions = new Map(slots.map((slot) => [slot.id, new Set(cast.mentionsOf(slot, unit, unit.ordinals))]));
    const read = sceneReader(
      { ...input, mentions },
      rejected,
    )({
      pov: null,
      relations: [
        { a: 'e1', type: 'friend_of', b: 'e2', sentence: 'Viv and Solfis are friends.', n: [3] },
        { a: 'e1', type: 'friend_of', b: 'e2', sentence: 'Viv and Solfis are friends.', n: [4] },
      ],
    });
    expect(read?.items.ties.map((tie) => tie.cite)).toEqual([5, 4]);
    expect(read?.items.linkPairs.map((pair) => pair.cite)).toEqual([5, 4]);
    expect(rejected['ties:cite-moved']).toBe(1);
  });

  it('requires causal wording for a typed leads_to and retains incompatible kinds as a link', () => {
    const idea = entity('e5', 'idea', [1, 4], { name: 'deck', names: [{ text: 'deck', ordinal: 1 }] });
    const plan = entity('e6', 'idea', [4], { name: 'argument', names: [{ text: 'argument', ordinal: 4 }] });
    const ideas = new PassCast([idea, plan, viv]).slots(unit);
    const rejected: Rejections = {};
    const read = sceneReader(
      { ...input, slots: ideas, mode: 'nonfiction' },
      rejected,
    )({
      pov: 'e5',
      relations: [
        { a: 'e5', type: 'causes', b: 'e6', sentence: 'The deck leads to the argument.', n: [4] },
        { a: 'e1', type: 'causes', b: 'e6', sentence: 'Viv starts the argument.', n: [4] },
      ],
    });
    expect(read?.items.pov).toBeNull();
    expect(read?.items.linkPairs).toEqual([{ a: viv, b: plan, cite: 4 }]);
    expect(read?.items.ties).toEqual([]);
    expect(rejected).toEqual({ 'ties:leads-to-not-stated': 1, 'ties:kinds-link': 1 });
  });
});

it('stitches distinct notes in citation order', () => {
  expect(
    stitchNotes([
      { note: 'Viv stops.', cites: [5] },
      { note: 'VIV WALKS!', cites: [3] },
      { note: 'Viv walks.', cites: [2] },
    ]),
  ).toBe('Viv walks. Viv stops.');
});

it('keeps whole notes in citation order up to sixty words when they do not all fit', () => {
  const note = (name: string, count: number) => [name, ...Array.from({ length: count - 1 }, () => 'walks')].join(' ');
  expect(
    stitchNotes([
      { note: note('Viv', 45), cites: [1] },
      { note: note('Ana', 50), cites: [2] },
      { note: note('Bel', 10), cites: [3] },
    ]),
  ).toBe(`${note('Viv', 45)} ${note('Ana', 50)}`);
  expect(
    stitchNotes([
      { note: note('Viv', 60), cites: [1] },
      { note: note('Ana', 50), cites: [2] },
    ]),
  ).toBe(note('Viv', 60));
});

describe('dense run', () => {
  it("retries a reply that skips a required id, deduplicates a unit's chunk notes, and keeps the earliest cite", async () => {
    const texts = Array.from({ length: 200 }, (_, index) => (index % 2 ? 'Viv walked on.' : 'The road was long.'));
    const sentences = book(texts, (index) => Math.floor(index / 10));
    const viv = entity(
      'e1',
      'character',
      sentences.filter((sentence) => sentence.text.startsWith('Viv')).map((sentence) => sentence.ordinal),
      {
        name: 'Viv',
        names: [{ text: 'Viv', ordinal: 2 }],
        importance: 3,
      },
    );
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const privacy = new XrayPrivacy(sentences);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
    const steps = {
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),

      now: step('now'),
      about: step('about'),
    };
    let notesCalls = 0;
    const order: string[] = [];
    const reply = (value: unknown) => () =>
      Promise.resolve({
        text: JSON.stringify(value),
        usage: { input: 10, output: 5, cost: 0.001 },
        finish: 'stop' as const,
        model: 'm',
      });
    const ask = vi.fn((request: { system: string; user: string }) => {
      const first = Number(/\[(\d+)\]/.exec(request.user)?.[1]);
      if (`${request.system}${request.user}`.includes('notes: an object keyed by id')) {
        if (request.user.includes('Answer only')) {
          expect(request.user).toContain('[2] Viv walked on.');
          expect(request.user).not.toContain('The road was long.');
        } else order.push(`notes:${first}`);
        notesCalls++;
        if (notesCalls === 1) return reply({ notes: {}, summary: 'Viv walks.' });
        return reply({
          notes: { e1: { note: 'Viv walks on.', n: [request.user.includes('Answer only') ? first : first + 1] } },
          summary: 'Viv walks.',
        });
      }
      if (request.user.includes(`"identity":`)) order.push(`facts:${first}`);
      return reply({ identity: [], abilities: [], ties: [], merges: [] });
    });
    const result = await runDense({
      entities: [viv],
      sentences,
      units: [unitOf(sentences.map((sentence) => sentence.ordinal))],
      mode: 'fiction',
      ask,
      askWrite: ask,
      askAbout: ask,
      ...steps,
      writesAbout: () => false,
    });
    expect(order).toEqual(['notes:1', 'notes:101', 'facts:1', 'facts:101']);
    expect(result.required).toEqual({ keys: 2, first: 1, retry: 2 });
    const [entry] = result.state.timeline.get('e1')!;
    expect(entry.value).toEqual({ note: 'Viv walks on.', at: 2 });
    expect(steps.notes.record.firstTry).toEqual({ 'notes:missing-required': 1 });
    expect(steps.notes.record.usage).toMatchObject({ input: 30, output: 15 });
    expect(result.state.summaries).toHaveLength(2);
  });

  it('gives a cut notes reply up for the missing names in one re-ask, and gives the unit two on its last chunk summary', async () => {
    const sentences = book(Array.from({ length: 9 }, () => 'Viv walked on.'));
    const viv = entity('e1', 'character', [1, 2, 3, 4, 5, 6, 7, 8, 9], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }], importance: 3 });
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const privacy = new XrayPrivacy(sentences);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
    const steps = {
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),

      now: step('now'),
      about: step('about'),
    };
    const users: string[] = [];
    let first = true;
    const ask = (request: { system: string; user: string; capped?: boolean }) => () => {
      if (`${request.system}${request.user}`.includes('notes: an object keyed by id')) {
        users.push(request.user);
        expect(request.capped).toBe(true);
        if (first && request.user.includes('[1] ')) {
          first = false;
          return Promise.reject(new AiError('too-long', 'cut'));
        }
        return Promise.resolve({
          text: JSON.stringify({ notes: { e1: null }, summary: 'Viv stops.' }),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        });
      }
      return Promise.resolve({ text: '{"identity": []}', usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' });
    };
    const result = await runDense({
      entities: [viv],
      sentences,
      units: [
        { id: 'u1', index: 0, s: 0, ordinals: [1, 2, 3], sectionEnd: true },
        { id: 'u2', index: 1, s: 1, ordinals: [4, 5, 6], sectionEnd: true },
        { id: 'u3', index: 2, s: 2, ordinals: [7, 8, 9], sectionEnd: true },
      ],
      mode: 'fiction',
      ask,
      askWrite: ask,
      askAbout: ask,
      ...steps,
      writesAbout: () => false,
    });
    expect(steps.notes.record.cut).toBe(1);
    const retry = users.find((user) => user.includes('Answer only for these ids: e1'));
    expect(retry).toContain('Give the summary too.');
    expect(retry).toContain('[1] ');
    expect(users.find((user) => user.includes('[4] '))).not.toContain('<before>\n');
    expect(users.find((user) => user.includes('[7] '))).toContain('<before>\nViv stops.\n</before>');
    expect(result.required).toEqual({ keys: 3, first: 2, retry: 3 });
  });
});

describe('limiter', () => {
  it('runs at most the limit at once', async () => {
    const gate = limiter(2);
    let running = 0;
    let most = 0;
    const task = () =>
      gate(async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      });
    await Promise.all(Array.from({ length: 7 }, task));
    expect(most).toBe(2);
  });
});

describe('facts merges', () => {
  const runWith = (sentences: Sentence[], cast: XrayEntity[], units: PassUnit[], merges: (user: string) => unknown[]) => {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const privacy = new XrayPrivacy(sentences);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
    const ask: Ask =
      ({ system, user }) =>
      () =>
        Promise.resolve({
          text: JSON.stringify(`${system}${user}`.includes('merges: {"a"') ? { merges: merges(user) } : { pov: null, notes: {}, summary: null }),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        });
    return runDense({
      entities: cast,
      sentences,
      units,
      mode: 'fiction',
      ask,
      askWrite: ask,
      askAbout: () => () => Promise.reject(new Error('unexpected about rewrite')),
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),
      now: step('now'),
      about: step('about'),
      writesAbout: () => false,
    });
  };
  const twoUnits = (split: number, total: number): PassUnit[] => [
    { ...unitOf(Array.from({ length: split }, (_, index) => index + 1)), sectionEnd: false },
    { ...unitOf(Array.from({ length: total - split }, (_, index) => split + index + 1)), id: 'u2', index: 1 },
  ];

  it('skips a merge across kinds and joins a same-kind pair on its second chunk', async () => {
    const sentences = book(['Piper is the Cloak.', 'Piper is called Raven.', 'Piper is the Cloak again.', 'Raven is Piper.']);
    const cast = [
      entity('e1', 'character', [1, 2, 3, 4], { name: 'Piper' }),
      entity('e2', 'object', [1, 3], { name: 'Cloak' }),
      entity('e3', 'character', [2, 4], { name: 'Raven' }),
    ];
    const result = await runWith(sentences, cast, twoUnits(2, 4), () => [
      { a: 'e2', b: 'e1', n: [1, 3] },
      { a: 'e3', b: 'e1', n: [2, 4] },
    ]);
    expect(result.cast.merges.map(({ member, head, ordinal }) => [member.id, head.id, ordinal])).toEqual([['e3', 'e1', 4]]);
    expect(result.cast.heads.map(({ id }) => id)).toEqual(['e1', 'e2']);
  });

  it('never joins two names on one chunk of evidence', async () => {
    const sentences = book(['Tavia ran.', 'Tavia was Orrin’s sister, and the clan knew it.']);
    const cast = [entity('e1', 'character', [1, 2], { name: 'Tavia' }), entity('e2', 'character', [2], { name: 'Orrin' })];
    const result = await runWith(sentences, cast, [unitOf([1, 2])], () => [{ a: 'e1', b: 'e2', n: [2] }]);
    expect(result.cast.merges).toEqual([]);
  });

  it('heads a model merge with the more-mentioned name, whichever order the model gave', async () => {
    const sentences = book(['Tavia ran.', 'Tavia hid.', 'Tavia, called Princess Pip, laughed.', 'Pip is Tavia.']);
    const cast = [entity('e1', 'character', [1, 2, 3, 4], { name: 'Tavia' }), entity('e2', 'character', [3, 4], { name: 'Pip' })];
    const result = await runWith(sentences, cast, twoUnits(3, 4), () => [{ a: 'e1', b: 'e2', n: [3, 4] }]);
    expect(result.cast.merges.map(({ member, head }) => [member.id, head.id])).toEqual([['e2', 'e1']]);
  });
});

describe('dense now', () => {
  it.each([
    { raw: { now: { e1: 'Serves the city.' } }, ids: ['e1', 'e2'] },
    { raw: { e1: 'Serves the city.', e90: 'Unknown.' }, ids: ['e1', 'e2'] },
    { raw: { now: 'Serves the city.' }, ids: ['e1'] },
    { raw: 'Serves the city.', ids: ['e1'] },
    { raw: { now: [{ id: 'e1', now: 'Serves the city.' }] }, ids: ['e1', 'e2'] },
    { raw: [{ id: 'e1', line: 'Serves the city.' }], ids: ['e1', 'e2'] },
  ])('reads $raw for $ids', ({ raw, ids }) => {
    expect(readNow(raw, ids)).toEqual(new Map([['e1', 'Serves the city.']]));
  });

  it('skips unknown ids and values without a non-empty line', () => {
    expect(readNow({ e1: '  ', e2: 7, e90: 'Unknown.' }, ['e1', 'e2'])).toBeNull();
    expect(readNow({ now: 5 }, ['e1'])).toBeNull();
    expect(readNow('Serves the city.', ['e1', 'e2'])).toBeNull();
    expect(
      readNow(
        [
          { id: 'e90', line: 'Unknown.' },
          { id: 'e1', now: ' ' },
          { id: 'e2', now: false },
        ],
        ['e1', 'e2'],
      ),
    ).toBeNull();
  });

  it('feeds status facts to `now`, not `about`, and drops a now line that starts with the name', async () => {
    const sentences = book(['Zevrin moved into the watchroom.', 'Zevrin now serves the city.', 'Zevrin is a witch.']);
    const zevrin = entity('e1', 'character', [1, 2, 3], { name: 'Zevrin', names: [{ text: 'Zevrin', ordinal: 1 }] });
    const logger = new Logger('test');
    const log = vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const privacy = new XrayPrivacy(sentences);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
    const steps = {
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),

      now: step('now'),
      about: step('about'),
    };
    const reply = (value: unknown) => () =>
      Promise.resolve({ text: JSON.stringify(value), usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' });
    const prompts: string[] = [];
    const run = (...answers: unknown[]) => {
      const ask: Ask = (request) => {
        if (request.system.includes('now line'))
          return () => {
            prompts.push(request.user);
            return reply(answers.shift())();
          };
        if (`${request.system}${request.user}`.includes('notes: an object keyed by id')) return reply({ notes: { e1: null }, summary: '' });
        return reply({
          identity: [
            { id: 'e1', fact: 'Zevrin is a witch.', kind: 'identity', n: [3] },
            { id: 'e1', fact: 'Zevrin serves the city.', kind: 'status', n: [2] },
          ],
        });
      };
      return runDense({
        entities: [zevrin],
        sentences,
        units: [unitOf([1, 2, 3])],
        mode: 'fiction',
        ask,
        askWrite: ask,
        askAbout: () => reply({ lines: { zevrin: 'A witch.' } }),
        ...steps,
        writesAbout: () => true,
      });
    };
    const good = await run({ now: 'Serves the city from the watchroom.' });
    expect(good.state.currentNow('e1')).toBe('Serves the city from the watchroom.');
    expect(good.state.factsOf('e1').map((fact) => fact.value.text)).toEqual(['Zevrin is a witch.']);
    expect(good.state.statusOf('e1').map((fact) => fact.value.text)).toEqual(['Zevrin serves the city.']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('step=now unit=nu1 attempt=1 sentences=0 characters=0 sections=0 - sending rows'));

    prompts.length = 0;
    const recovered = await run({ now: 5 }, { now: { e1: 'Serves the city.' } });
    expect(recovered.state.currentNow('e1')).toBe('Serves the city.');
    expect(prompts).toEqual([prompts[0], `${prompts[0]}\nAnswer with JSON only, exactly {"now": {"<id>": "<line>"}} with these ids: e1.`]);

    warn.mockClear();
    const unreadable = await run({ now: 5 }, { e96: 'Zevrin moved.', Molvessa: 'Molvessa waited.', now: [false] });
    expect(unreadable.state.currentNow('e1')).toBeNull();
    expect(warn.mock.calls.filter(([message]) => typeof message === 'string' && message.includes('step=now'))).toEqual([
      [expect.stringContaining('errorClass=InvalidReply error="unreadable after retry rows=1 replyType=object keys=id,other,now nowType=array"')],
    ]);

    const bad = await run({ now: { e1: 'Zevrin, a witch, serves the city.' } });
    expect(bad.state.currentNow('e1')).toBeNull();
    expect(steps.now.record.rejected).toEqual({ 'now:starts-with-name': 1 });
    const ungrounded = await run({ now: { e1: 'Serves the city beside Molvessa.' } });
    expect(ungrounded.state.currentNow('e1')).toBeNull();
    expect(steps.now.record.rejected).toEqual({ 'now:starts-with-name': 1, 'now:ungrounded': 1 });
  });

  it('keeps the current situation when a later Now is a stat change or a list', async () => {
    const sentences = book(['Tavia guards the ferry during the flood.', 'Tavia moves to the sluice house.', 'Tavia patrols the river locks.']);
    const tavia = entity('e1', 'character', [1, 2, 3], { name: 'Tavia', names: [{ text: 'Tavia', ordinal: 1 }] });
    const units = sentences.map(({ ordinal }) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index: ordinal - 1 }));
    const { run, steps } = denseHarness(sentences);
    const current = 'She guards the ferry during the flood.';
    const nowReplies = [current, 'Endurance +1.', 'At the locks, tired, cold, hungry, and alone.'];
    const { state } = await run(
      [tavia],
      units,
      (kind, user) => {
        if (kind === 'facts') {
          const cite = Number(user.match(/\[(\d+)\] Tavia/)?.[1]);
          return { identity: [{ id: 'e1', fact: sentences[cite - 1].text, kind: 'status', n: [cite] }] };
        }
        if (user.includes('\nnow:')) return { now: { e1: nowReplies.shift() } };
        return {};
      },
      undefined,
      undefined,
      undefined,
      { writesAbout: () => true },
    );
    expect(state.now.get('e1')).toEqual([{ unit: units[0], value: current }]);
    expect(steps.now.record.rejected).toEqual({ 'now:stat-numbers': 1, 'now:list': 1 });
  });
});

describe('alias step', () => {
  const sentences = book([
    'Viv walked into Niyl.',
    '"Bob, come here," Solfis said.',
    'Nyil was cold.',
    'The golem watched Solfis work.',
    'Solfis, the golem, hummed.',
    '"Bob, eat," said Solfis to Viv.',
    'The Old Empire fell long ago.',
    'Viv read about the Empire.',
  ]);
  const people = () => [
    entity('viv', 'character', [1, 6, 8], { name: 'Viv', count: 9, importance: 1 }),
    entity('niyl', 'place', [1], { name: 'Niyl', count: 5 }),
    entity('nyil', 'place', [3], { name: 'Nyil', count: 1 }),
    entity('bob', 'character', [2, 6], { name: 'Bob', count: 2, importance: 3 }),
    entity('solfis', 'character', [2, 4, 5, 6], { name: 'Solfis', count: 6, importance: 1 }),
    entity('golem', 'object', [4, 5], { name: 'golem', count: 2 }),
    entity('old', 'place', [7], { name: 'Old Empire', count: 3 }),
    entity('empire', 'place', [8], { name: 'Empire', count: 1 }),
  ];

  it('counts a swap of two neighbours as one edit', () => {
    expect(editDistance('niyl', 'nyil')).toBe(1);
    expect(editDistance('mopti', 'mopti')).toBe(0);
  });

  it('offers shared words, near spellings, epithets and dialogue nicknames, the more named one as head', () => {
    const entities = people();
    const cast = new PassCast(entities);
    const found = aliasCandidates(cast, sentences).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['Nyil', 'Niyl', 'spelling'],
        ['Empire', 'Old Empire', 'token'],
        ['golem', 'Solfis', 'epithet'],
        ['Bob', 'Viv', 'dialogue'],
      ]),
    );
  });

  it('keeps a place at a name, a possession and a cross-kind pair out, and heads a shared word with its capitalised name', () => {
    const text = book(['Viv wore her cloak.', 'Her cloak was torn.', 'Mopti Airport was busy.', 'Mopti was hot.', 'The Necrarch millipede came.']);
    const cast = new PassCast([
      entity('viv', 'character', [1, 2, 4], { name: 'Viv', count: 9, importance: 1 }),
      entity('cloak', 'object', [1, 2], { name: 'cloak', count: 2 }),
      entity('mopti', 'place', [4], { name: 'Mopti', count: 4 }),
      entity('airport', 'place', [3], { name: 'Mopti Airport', count: 1 }),
      entity('necrarch', 'character', [5], { name: 'Necrarch millipede', count: 1 }),
      entity('millipede', 'character', [5], { name: 'millipede', count: 6 }),
      entity('cassian', 'character', [4], { name: 'Cassian', count: 3 }),
      entity('springs', 'place', [4], { name: 'Cassian Lake', count: 1 }),
    ]);
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toContainEqual(['millipede', 'Necrarch millipede', 'token']);
    expect(found.some(([member]) => member === 'cloak' || member === 'Mopti Airport' || member === 'Cassian Lake')).toBe(false);
  });

  it('checks a name against the names already joined to a head, and a long name against a first-letter slip', () => {
    const text = book(['Tavia ran.', 'Princess Pip waved.', 'Pip laughed.', 'Mirabel hid.', 'Tirabel sang.']);
    const tavia = entity('tavia', 'character', [1], { name: 'Tavia', count: 300, importance: 1 });
    const princess = entity('princess-pip', 'character', [2], { name: 'Princess Pip', count: 4 });
    const mirabel = entity('mirabel', 'character', [4], { name: 'Mirabel', count: 3 });
    const pip = entity('pip', 'character', [3], { name: 'Pip', count: 12 });
    const tirabel = entity('tirabel', 'character', [5], { name: 'Tirabel', count: 5 });
    const cast = new PassCast([tavia, princess, mirabel, pip, tirabel]);
    cast.merge({ member: princess, head: tavia, ordinal: 2, rule: 'alias' });
    cast.merge({ member: mirabel, head: tavia, ordinal: 4, rule: 'alias' });
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toContainEqual(['Pip', 'Tavia', 'token']);
    expect(found).toContainEqual(['Tirabel', 'Tavia', 'spelling']);
  });

  it('never offers a name the book gives in full as a dialogue nickname', () => {
    const text = book(['“Rowan Hale?” Marta asked.', '“Hale, sit,” Marta said.', '“Hale, look,” Marta said.', 'Marta left.']);
    const marta = entity('marta', 'character', [1, 2, 3, 4], { name: 'Marta', count: 40, importance: 1 });
    const hale = entity('hale', 'character', [1, 2, 3], { name: 'Hale', count: 3 });
    const full = entity('rowan-hale', 'character', [1], { name: 'Rowan Hale', count: 1 });
    const cast = new PassCast([marta, hale, full]);
    cast.merge({ member: full, head: hale, ordinal: 1, rule: 'full-name' });
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found.some(([, , reason]) => reason === 'dialogue')).toBe(false);
  });

  it('heads a merge with the name a reader looks up, not the busier spelling', () => {
    const byCount = (a: XrayEntity, b: XrayEntity): [XrayEntity, XrayEntity] => (a.count > b.count ? [b, a] : [a, b]);
    const fort = entity('fort', 'idea', [2], { name: 'fort', count: 44 });
    const stone = entity('stone', 'place', [1], { name: 'Fort Weiss', count: 12 });
    expect(namedFirst(fort, stone, byCount)[1]).toBe(stone);
    const lead = entity('tavia', 'character', [1], { name: 'Tavia', count: 30, importance: 1 });
    const nickname = entity('pip', 'character', [2], { name: 'Pip', count: 60, importance: 2 });
    expect(namedFirst(nickname, lead, byCount)[1]).toBe(lead);
    const stand = entity(NARRATOR_ID, 'character', [1], { name: 'Narrator', count: 90, importance: 1 });
    const named = entity('rowan', 'character', [5], { name: 'Rowan', count: 3, importance: 3 });
    expect(namedFirst(stand, named, byCount)[1]).toBe(named);
    const golem = entity('golem', 'character', [1], { name: 'the golem', count: 80 });
    const solfis = entity('solfis', 'character', [2], { name: 'Solfis', count: 20, importance: 1 });
    expect(namedFirst(golem, solfis, byCount)[1]).toBe(solfis);
  });

  it('offers a bare lowercase word to the one name it sits in, whatever kind the review gave it', () => {
    const text = book(['They reached Fort Weiss.', 'The fort was cold.', 'The fort gate shut.']);
    const cast = new PassCast([
      entity('weiss', 'place', [1], { name: 'Fort Weiss', count: 4 }),
      entity('fort', 'idea', [2, 3], { name: 'fort', count: 9 }),
    ]);
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toContainEqual(['fort', 'Fort Weiss', 'token']);
  });

  it('keeps two names a letter or two apart and used alike, and an idea, out of the candidates', () => {
    const text = book(['Maranor met Maradoc.', 'Maradoc and Maranor argued.', 'Viv checked the harness.', 'Viv tightened the harness.']);
    const cast = new PassCast([
      entity('viv', 'character', [3, 4], { name: 'Viv', count: 9, importance: 1 }),
      entity('maranor', 'character', [1, 2], { name: 'Maranor', count: 4 }),
      entity('maradoc', 'character', [1, 2], { name: 'Maradoc', count: 10 }),
      entity('harness', 'idea', [3, 4], { name: 'harness', count: 6 }),
    ]);
    expect(aliasCandidates(cast, text)).toEqual([]);
  });

  it('offers a name spelt with and without a doubled letter even when both are used alike', () => {
    const text = book(['Tavia served Corran.', 'Corran paid well.', 'Coran lay east.', 'Tavia rode to Coran.']);
    const cast = new PassCast([
      entity('tavia', 'character', [1, 4], { name: 'Tavia', count: 9, importance: 1 }),
      entity('corran', 'character', [1, 2], { name: 'Corran', count: 9 }),
      entity('coran', 'place', [3, 4], { name: 'Coran', count: 11 }),
    ]);
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toContainEqual(['Corran', 'Coran', 'spelling']);
    expect(doubledLetter('corran', 'coran')).toBe(true);
    expect(doubledLetter('maranor', 'maradoc')).toBe(false);
    expect(doubledLetter('anna', 'anne')).toBe(false);
  });

  it('offers a rare misspelling across kinds, and keeps a lead in every paragraph from drawing a lowercase word', () => {
    const text = book(['Viv saw the trio.', 'Viv and the trio ran.', 'Viv slept.', 'Viv woke in Nyil.', 'Niyl was cold.', 'Viv left Nyil.']);
    const cast = new PassCast([
      entity('viv', 'character', [1, 2, 3, 4, 6], { name: 'Viv', count: 40, importance: 1 }),
      entity('trio', 'group', [1, 2], { name: 'trio', count: 2 }),
      entity('nyil', 'character', [4, 6], { name: 'Nyil', count: 8 }),
      entity('niyl', 'place', [5], { name: 'Niyl', count: 3 }),
    ]);
    const found = aliasCandidates(cast, text).map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toContainEqual(['Niyl', 'Nyil', 'spelling']);
    expect(found.some(([member]) => member === 'trio')).toBe(false);
  });

  it('keeps survivors and typed groups apart from a person in either alias direction', () => {
    const text = book(['Cernit helped the survivors.', 'Cernit helped the survivors again.', 'Elsewhere.', 'A bell rang.', 'A door opened.']);
    const cernit = entity('c', 'character', [1, 2], { name: 'Cernit' });
    const survivors = entity('s', 'character', [1, 2], { name: 'survivors' });
    const guild = entity('g', 'group', [1], { name: 'Guild' });
    const cast = new PassCast([cernit, survivors, guild, entity('bell', 'object', [3, 4, 5])]);
    const evidence = [
      { a: cernit, b: survivors, ordinal: 1, rule: 'apposition' as const },
      { a: guild, b: cernit, ordinal: 1, rule: 'apposition' as const },
    ];
    expect(aliasCandidates(cast, text, 'fiction', evidence)).toEqual([]);
    expect(epithetFolds(cast, text)).toEqual([]);
    joinAlias(cast, { member: cernit, head: survivors, ordinal: 1, reason: 'epithet' });
    joinAlias(cast, { member: guild, head: cernit, ordinal: 1, reason: 'evidence' });
    expect(cast.merges).toEqual([]);
  });

  it('keeps the busier name as head when a merge reaches a name already joined to it', () => {
    const entities = [
      entity('viv', 'character', [1, 2], { name: 'Viv', count: 239, importance: 1 }),
      entity('witch', 'character', [2], { name: 'Witch', count: 12 }),
      entity('title', 'character', [3], { name: 'Black Hedge Witch', count: 7 }),
    ];
    const [viv, witch, title] = entities;
    const cast = new PassCast(entities);
    joinAlias(cast, { member: witch, head: viv, ordinal: 2, reason: 'dialogue' });
    joinAlias(cast, { member: witch, head: title, ordinal: 3, reason: 'token' });
    expect(cast.heads.map((head) => head.name)).toEqual(['Viv']);
    expect(cast.headOf(title)).toBe(viv);
  });

  it('offers a nonfiction book only names of people, places and groups that share words', () => {
    const text = book(['AI can play chess.', 'AI and chess again.', 'The Industrial Revolution came.', 'Revolution followed.', 'Yudkowsky wrote.']);
    const cast = new PassCast([
      entity('ai', 'idea', [1, 2], { name: 'AI', count: 50, importance: 1 }),
      entity('chess', 'idea', [1, 2], { name: 'chess', count: 2 }),
      entity('industrial', 'idea', [3], { name: 'Industrial Revolution', count: 2 }),
      entity('revolution', 'idea', [3, 4], { name: 'Revolution', count: 3 }),
      entity('eliezer', 'character', [5], { name: 'Eliezer Yudkowsky', count: 1 }),
      entity('yudkowsky', 'character', [5], { name: 'Yudkowsky', count: 4 }),
    ]);
    const found = aliasCandidates(cast, text, 'nonfiction').map((candidate) => [candidate.member.name, candidate.head.name, candidate.reason]);
    expect(found).toEqual([['Eliezer Yudkowsky', 'Yudkowsky', 'token']]);
  });

  it('merges a pair answered "same" with a sentence it was shown, from the later of that sentence and the first mention', async () => {
    const entities = people();
    const cast = new PassCast(entities);
    const [niyl, nyil, viv, bob] = ['niyl', 'nyil', 'viv', 'bob'].map((key) => entities.find((entity) => entity.key === key)!);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const reply = { g1: { nyil: { same: true, n: [3] } }, g2: { bob: { same: true, n: [99] } } };
    const merges = await aliasMerges(
      [
        { head: niyl, member: nyil, reason: 'spelling' },
        { head: viv, member: bob, reason: 'dialogue' },
      ],
      sentences,
      'fiction',
      () => () => Promise.resolve({ text: JSON.stringify(reply), usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' }),
      step,
    );
    expect(merges.map((merge) => [merge.member.name, merge.head.name, merge.ordinal])).toEqual([['Nyil', 'Niyl', 3]]);
    expect(step.record.rejected).toEqual({ 'alias:no-cite': 1 });
    expect(cast.heads).toHaveLength(8);
  });
});

describe('alias merge order', () => {
  it('returns merges in batch order whichever call answers first', async () => {
    const count = ALIAS_GROUPS_PER_CALL + 1;
    const sentences = book(Array.from({ length: count * 2 }, (_, index) => `Line ${index + 1}.`));
    const candidates = Array.from({ length: count }, (_, index) => ({
      head: entity(`h${index}`, 'character', [index * 2 + 1], { name: `Head${index}` }),
      member: entity(`m${index}`, 'character', [index * 2 + 2], { name: `Member${index}` }),
      reason: 'token' as const,
    }));
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const ask: Ask = ({ user }) => {
      const groups = [...user.matchAll(/^g(\d+): h(\d+) /gm)].map((found) => [found[1], found[2]]);
      const answer = Object.fromEntries(groups.map(([group, index]) => [`g${group}`, { [`m${index}`]: { same: true, n: [Number(index) * 2 + 2] } }]));
      const first = groups[0][1] === '0';
      return () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: JSON.stringify(answer), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }), first ? 20 : 0),
        );
    };
    const merges = await aliasMerges(
      candidates,
      sentences,
      'fiction',
      ask,
      new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r'),
    );
    expect(merges.map((merge) => merge.member.id)).toEqual(candidates.map((candidate) => candidate.member.id));
  });
});

describe('alias second round', () => {
  it('sends nothing when no pair is left, and names its units apart from the first round', async () => {
    const sentences = book(['Tavia ran.', 'Pip laughed.']);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const ask = vi.fn<Ask>(
      () => () =>
        Promise.resolve({
          text: JSON.stringify({ g1: { pip: { same: true, n: [2] } } }),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        }),
    );
    expect(await aliasMerges([], sentences, 'fiction', ask, step, 'alias-joined')).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    const unit = vi.spyOn(step, 'unit');
    const tavia = entity('tavia', 'character', [1], { name: 'Tavia', count: 300 });
    const pip = entity('pip', 'character', [2], { name: 'Pip', count: 12 });
    await aliasMerges([{ head: tavia, member: pip, reason: 'token' }], sentences, 'fiction', ask, step, 'alias-joined');
    expect(unit.mock.calls.map(([call]) => call.id)).toEqual(['alias-joined1']);
  });
});

describe('alias ask with joined names', () => {
  it("shows a head's joined names and the sentence each first appears in", async () => {
    const sentences = book(['Tavia ran.', 'They crowned her Princess Pip.', 'Pip laughed.']);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const tavia = entity('tavia', 'character', [1], { name: 'Tavia', count: 300 });
    const princess = entity('princess-pip', 'character', [2], { name: 'Princess Pip', count: 1, names: [{ text: 'Princess Pip', ordinal: 2 }] });
    const pip = entity('pip', 'character', [3], { name: 'Pip', count: 12 });
    const cast = new PassCast([tavia, princess, pip]);
    cast.merge({ member: princess, head: tavia, ordinal: 2, rule: 'alias' });
    let user = '';
    const ask: Ask = (request) => {
      user = request.user;
      return () =>
        Promise.resolve({
          text: JSON.stringify({ g1: { pip: { same: false } } }),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        });
    };
    await aliasMerges([{ head: tavia, member: pip, reason: 'token' }], sentences, 'fiction', ask, step);
    expect(user).toContain('Tavia (also called Princess Pip)');
    expect(user).toContain('[2] They crowned her Princess Pip.');
  });

  it('shows the fullest sentences for a name, not its first bare mentions', async () => {
    const lines = ['Tavia ran.', ...Array.from({ length: 8 }, () => '“Pip.”'), '“Just call me Pip, everyone does,” Tavia said.'];
    const sentences = book(lines);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const tavia = entity('tavia', 'character', [1], { name: 'Tavia', count: 300 });
    const pip = entity('pip', 'character', [2, 3, 4, 5, 6, 7, 8, 9, 10], { name: 'Pip', count: 9 });
    let user = '';
    const ask: Ask = (request) => {
      user = request.user;
      return () =>
        Promise.resolve({
          text: JSON.stringify({ g1: { pip: { same: false } } }),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        });
    };
    await aliasMerges([{ head: tavia, member: pip, reason: 'token' }], sentences, 'fiction', ask, step);
    expect(user).toContain('Just call me Pip');
  });
});

describe('alias join anchor', () => {
  it('joins at a cited sentence naming both, and at the last shown sentence when the cite names only one', async () => {
    const sentences = book(['The hooded man watched.', 'Kaladin ran.', 'Kaladin fought.', 'Rain fell.', 'The hooded man was Kaladin.']);
    const merge = async (cite: number) => {
      const kaladin = entity('kaladin', 'character', [2, 3, 5], { name: 'Kaladin', count: 3 });
      const hooded = entity('hooded', 'character', [1, 5], { name: 'hooded man', count: 2 });
      const logger = new Logger('test');
      vi.spyOn(logger, 'log').mockImplementation(() => undefined);
      const reply = { g1: { hooded: { same: true, n: [cite] } } };
      const [found] = await aliasMerges(
        [{ head: kaladin, member: hooded, reason: 'epithet' }],
        sentences,
        'fiction',
        () => () => Promise.resolve({ text: JSON.stringify(reply), usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' }),
        new XrayStepRun('alias', 'fast', new XrayPrivacy(sentences), logger, 'runId=r'),
      );
      return found.ordinal;
    };
    expect(await merge(1)).toBe(5);
    expect(await merge(5)).toBe(5);
  });
});

describe('facts descriptions and scene cards', () => {
  it('uses a cited is phrase and a label gloss, asks a scene card on a chunk with only the lead, and reads its POV', async () => {
    const sentences = book(['Piper and Fern examine Mana Sight with Rowan.', '[Mana Sight: Reveals nearby sources of magic.]', 'Piper walked.']);
    const units = [unitOf([1, 2]), { ...unitOf([3]), index: 1, id: 'later' }];
    const entities = [
      entity('e1', 'character', [1, 3], { name: 'Piper', importance: 3 }),
      entity('e2', 'character', [1], { name: 'Fern', importance: 3 }),
      entity('e3', 'idea', [1, 2], { name: 'Mana Sight', importance: 2 }),
      entity('e4', 'character', [1], { name: 'Rowan', importance: 3 }),
    ];
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const scenes: string[] = [];
    const facts: string[] = [];
    const ask: Ask =
      ({ user }) =>
      () => {
        let answer: unknown = {};
        if (user.includes('notes: an object keyed by id')) answer = { notes: {}, summary: 'Piper walks.' };
        else if (user.includes('1. pov:')) {
          scenes.push(user);
          answer = { pov: user.includes('[3] ') ? null : 'e1', same: [], relations: [] };
        } else if (user.includes('"identity":')) {
          facts.push(user);
          answer = {
            identity: [
              { id: 'e1', is: { text: 'A pathfinder', n: [1] } },
              { id: 'e2', is: { text: 'Possibly a merchant', n: [1] } },
            ],
          };
        }
        return Promise.resolve({ text: JSON.stringify(answer), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' });
      };
    const result = await runDense({
      entities,
      units,
      sentences,
      mode: 'fiction',
      ask,
      askWrite: ask,
      askAbout: ask,
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),
      now: step('now'),
      about: step('about'),
      writesAbout: () => false,
    });
    expect(scenes).toHaveLength(2);
    expect(facts[0]).toMatch(/e1 [^\n]*needs is/);
    expect(facts[0]).not.toMatch(/e3 [^\n]*needs is/);
    expect(result.state.currentAbout('e1')).toBe('A pathfinder.');
    expect(result.state.currentAbout('e2')).toBeNull();
    expect(result.state.currentAbout('e3')).toBe('Reveals nearby sources of magic.');
    expect([...result.pov.values()]).toEqual(['e1', null]);
  });
});

describe('describe step for entries left without a line', () => {
  const DESCRIBE_KEY = 'one key for every name';
  /** A run whose facts and describe answers come from the callbacks; everything else answers empty. */
  const gapRun = async (
    sentences: Sentence[],
    units: PassUnit[],
    entities: ReturnType<typeof entity>[],
    options: {
      mode?: 'fiction' | 'nonfiction';
      facts?: (user: string) => unknown;
      notes?: (user: string) => unknown;
      describe?: (user: string) => unknown;
      about?: (user: string) => unknown;
      writesAbout?: (slot: PassSlot) => boolean;
    },
  ) => {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const describe = step('describe');
    const facts = step('facts');
    const asked: string[] = [];
    const aboutAsked: string[] = [];
    const ask: Ask =
      ({ system, user }) =>
      () => {
        let answer: unknown = {};
        if (system.includes(DESCRIBE_KEY)) {
          asked.push(user);
          answer = options.describe?.(user) ?? {};
        } else if (system.includes('keep short descriptions')) {
          aboutAsked.push(user);
          answer = options.about?.(user) ?? {};
        } else if (user.includes('notes: an object keyed by id')) answer = options.notes?.(user) ?? { notes: {}, summary: 'The gate opened.' };
        else if (user.includes('"identity":')) answer = options.facts?.(user) ?? {};
        return Promise.resolve({ text: JSON.stringify(answer), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' });
      };
    const result = await runDense({
      entities,
      units,
      sentences,
      mode: options.mode ?? 'fiction',
      ask,
      askWrite: ask,
      askAbout: ask,
      notes: step('notes'),
      facts,
      ties: step('ties'),
      alias: step('alias'),
      describe,
      now: step('now'),
      about: step('about'),
      writesAbout: options.writesAbout ?? (() => false),
    });
    return { result, asked, describe, facts, aboutAsked };
  };

  it('returns neighbouring context separately and excludes neighbours that are themselves mentions', () => {
    const sentences = book(['The gate opened.', 'Tavia stepped in.', 'Tavia waved.', 'The gate shut.', 'Tavia left.']);
    expect(descriptionEvidence([2, 3, 5], sentences)).toEqual({ mentions: [2, 3, 5], context: [1] });
    expect(descriptionEvidence([2, 5], sentences)).toEqual({ mentions: [2, 5], context: [1, 4] });
  });

  it('drops a bare label only when another mention remains', () => {
    const sentences = book(['[Ember ward]', 'The ember ward warms the gate.']);
    expect(descriptionEvidence([1, 2], sentences, ['Ember ward'])).toEqual({ mentions: [2], context: [] });
    expect(descriptionEvidence([1], sentences, ['Ember ward'])).toEqual({ mentions: [1], context: [] });
  });

  it('filters context with uncommon capitalised words outside the mention and own names', () => {
    const mention = 'Tavia and Orrin would never find out.';
    expect(contextNamesOthers('Mavro and Pell would feel guilty.', mention, ['Tavia'])).toBe(true);
    expect(contextNamesOthers('They waited for Mavro.', mention, ['Tavia'])).toBe(true);
    expect(contextNamesOthers('Engineering. What is that thing?', mention, ['Tavia'])).toBe(false);
    expect(contextNamesOthers('Orrin and Tavia left.', mention, [])).toBe(false);
    expect(contextNamesOthers('Mavro left.', mention, ['Mavro'])).toBe(false);
  });

  it.each([
    ['A guard who met Fern.', 2, 'describe:ungrounded'],
    ['A guard at the gate.', 1, 'describe:no-cite'],
  ])('shows labelled context without accepting its names or citations (%s)', async (about, cite, reason) => {
    const sentences = book(['Fern opened the gate.', 'Tavia raised a shield.', 'Mavro walked home.', 'Tavia put the shield down.']);
    const { result, asked, describe } = await gapRun(sentences, [unitOf([1, 2, 3, 4])], [entity('e1', 'character', [2, 4], { name: 'Tavia' })], {
      describe: () => ({ e1: { about, n: [cite] } }),
    });
    expect(asked[0]).toContain('  context [1] Fern opened the gate.\n  [2] Tavia raised a shield.');
    expect(asked[0]).toContain('  [4] Tavia put the shield down.');
    expect(asked[0]).not.toContain('Mavro');
    expect(describe.record.rejected).toMatchObject({ [reason]: 1 });
    expect(result.state.currentAbout('e1')).toBeNull();
  });

  it('finds shared lines after folding case and punctuation', () => {
    expect(
      sharedLines(
        new Map([
          ['e1', 'A gate guard.'],
          ['e2', 'a GATE-guard!'],
          ['e3', 'A trader.'],
        ]),
      ),
    ).toEqual(new Set(['e1', 'e2']));
  });

  it.each([false, true])('keeps shared lines and retries them once on new mentions (shared retry: %s)', async (repeated) => {
    const sentences = book([
      'Tavia and Orrin guard the gate.',
      'Tavia collects the toll while Orrin checks the carts.',
      'The bell rang.',
      'Tavia and Orrin went home.',
    ]);
    const units = sentences.map(({ ordinal }) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index: ordinal - 1 }));
    const entities = ['Tavia', 'Orrin'].map((name, index) => entity(`e${index + 1}`, 'character', [1, 2, 4], { name, importance: 3 }));
    const initial = { about: 'A sentry at the gate.', n: [1] };
    const { result, asked, describe } = await gapRun(sentences, units, entities, {
      describe: (user) =>
        user.includes('[2]') && !repeated
          ? { e1: { about: 'A sentry who collects the toll.', n: [2] }, e2: { about: 'A sentry who checks carts.', n: [2] } }
          : { e1: initial, e2: initial },
    });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('[2] Tavia collects');
    expect(describe.record.counts['describe:shared']).toBe(repeated ? 4 : 2);
    expect(describe.record.rejected['describe:deferred']).toBeUndefined();
    for (const id of ['e1', 'e2']) {
      expect(result.state.aboutAt(id, 1)).toBe(initial.about);
      expect(result.state.about.get(id)?.map(({ unit }) => unit.id)).toEqual(repeated ? ['u1'] : ['u1', 'u2']);
    }
    expect(result.state.currentAbout('e1')).toBe(repeated ? initial.about : 'A sentry who collects the toll.');
    expect(result.state.currentAbout('e2')).toBe(repeated ? initial.about : 'A sentry who checks carts.');
  });

  it('matches an own-name lead with or without an article and respects the word boundary', () => {
    const own = ['ember ward'];
    for (const line of ['Ember ward that warms the gate.', 'The ember ward warms the gate.', 'An ember ward, not a lamp.'])
      expect(startsWithOwnName(line, own)).toBe(true);
    for (const line of ['Ward of embers at the gate.', 'Ember warden at the gate.']) expect(startsWithOwnName(line, own)).toBe(false);
  });

  it('rejects an article followed by the own name in the facts and description passes', async () => {
    const sentences = book(['Tavia lifted the Vellin flask.']);
    const about = 'A Vellin flask, not made from glass.';
    const { result, describe, facts } = await gapRun(sentences, [unitOf([1])], [entity('e1', 'item', [1], { name: 'Vellin flask' })], {
      facts: () => ({ identity: [{ id: 'e1', is: { text: about, n: [1] } }] }),
      describe: () => ({ e1: { about, n: [1] } }),
    });
    expect(facts.record.rejected).toMatchObject({ 'is:starts-with-name': 1 });
    expect(describe.record.rejected).toMatchObject({ 'describe:starts-with-name': 1 });
    expect(result.state.currentAbout('e1')).toBeNull();
  });

  it('drops a garbled quoted term from a fiction description', async () => {
    const sentences = book(["Merged into the full skill: 'Deepward scholar'!"]);
    const { result, describe } = await gapRun(sentences, [unitOf([1])], [entity('e1', 'idea', [1], { name: 'Deepward' })], {
      describe: () => ({ e1: { about: 'A skill merging her studies into one scholarship.', n: [1] } }),
    });
    expect(describe.record.rejected).toMatchObject({ 'describe:garbled-term': 1 });
    expect(result.state.currentAbout('e1')).toBeNull();
  });

  it.each(DESCRIPTION_TIERS)('labels context in both modes and asks for exact terms in fiction ($name)', (tier) => {
    for (const mode of ['fiction', 'nonfiction'] as const) {
      expect(describeSystem(mode, tier)).toContain('A line marked context only helps you read the line after it: never take a claim from it.');
      expect(describeSystem(mode, tier)).toContain('When one sentence names several entries, give each only what is said of it.');
    }
    expect(describeSystem('fiction', tier)).toContain(
      'Write the name of a skill, class, spell or item exactly as the sentences write it, in full; never reword or shorten it.',
    );
  });

  it.each(DESCRIPTION_TIERS)('asks for lasting details appropriate to the kind ($name)', (tier) => {
    const system = describeSystem('fiction', tier);
    expect(system).toContain(LASTING_ONLY);
    expect(system).toContain(KIND_CONTENT);
    expect(system).toContain(DESCRIPTION_PROSE);
  });

  it('labels a stat in about and describe headers only once the unit confirms it', async () => {
    const sentences = book([
      'Mivren checked her Gleamforce.',
      'Gleamforce +1',
      'Gleamforce: 12',
      'Gleamforce measures how much light Mivren can hold.',
    ]);
    const units = [unitOf([1]), { ...unitOf([2, 3, 4]), id: 'u2', index: 1 }];
    const stat = entity('e1', 'idea', [1, 2, 3, 4], { name: 'Gleamforce', names: [{ text: 'Gleamforce', ordinal: 1 }] });
    const { asked, aboutAsked } = await gapRun(sentences, units, [stat], {
      writesAbout: () => true,
      facts: (user) =>
        user.includes('[4]') ? { identity: [{ id: 'e1', fact: 'Measures how much light Mivren can hold.', kind: 'identity', n: [4] }] } : {},
    });
    expect(asked[0]).toContain('e1 | Gleamforce | idea\n');
    expect(asked[1]).toContain('e1 | Gleamforce | idea | stat\n');
    expect(aboutAsked[0]).toContain('e1 | Gleamforce | idea | stat | current:');
  });

  it.each([
    [6, 1],
    [2, 1],
    [6, 2],
    [2, 2],
  ])('refreshes a concept on sufficient new mentions without new facts (%i mentions, importance %i)', async (added, importance) => {
    const sentences = book([
      'Tavia found a Vellin weave.',
      'Tavia carried the Vellin weave.',
      'Tavia stored the Vellin weave.',
      'Tavia used the Vellin weave to keep frost off the gate.',
      ...Array<string>(added - 1).fill('Tavia kept the Vellin weave in place.'),
    ]);
    const mentions = sentences.map(({ ordinal }) => ordinal);
    const units = [unitOf([1, 2, 3]), { ...unitOf(mentions.slice(3)), id: 'u2', index: 1 }];
    const { result, aboutAsked } = await gapRun(
      sentences,
      units,
      [entity('e1', 'idea', mentions, { name: 'Vellin weave', importance }), entity('e2', 'character', mentions, { name: 'Tavia', importance: 3 })],
      {
        writesAbout: (slot) => slot.member === null && slot.head.importance <= 2,
        notes: (user) => ({
          notes: user.includes('keep frost off') ? { e1: { note: 'Tavia uses the weave to keep frost off the gate.', n: [4] } } : { e1: null },
          summary: 'Tavia worked by the gate.',
        }),
        describe: () => ({ e1: { about: 'A weave that Tavia found.', n: [1] } }),
        about: () => ({ e1: { about: 'A weave that keeps frost off the gate.', n: [4] } }),
      },
    );
    expect(result.state.aboutAt('e1', 3)).toBe('A weave that Tavia found.');
    expect(result.state.factsOf('e1')).toEqual([]);
    expect(result.state.timeline.get('e1')?.at(-1)?.value.note).toBe('Tavia uses the weave to keep frost off the gate.');
    expect(aboutAsked).toHaveLength(added === 6 ? 1 : 0);
    if (added === 6) {
      expect(aboutAsked[0]).toContain('new: Tavia uses the weave to keep frost off the gate.');
      expect(result.state.about.get('e1')?.at(-1)).toEqual({ unit: units[1], value: 'A weave that keeps frost off the gate.' });
    }
  });

  it('describes only the entries with no accepted is, gloss or line, a rejected is included', async () => {
    const sentences = book(['Piper and Fern examine Mana Sight.', '[Mana Sight: Reveals nearby sources of magic.]', 'Fern is a merchant of Hollow.']);
    const entities = [
      entity('e1', 'character', [1], { name: 'Piper', importance: 3 }),
      entity('e2', 'character', [1, 3], { name: 'Fern', importance: 3 }),
      entity('e3', 'idea', [1, 2], { name: 'Mana Sight', importance: 3 }),
    ];
    const { result, asked, describe } = await gapRun(sentences, [unitOf([1, 2, 3])], entities, {
      facts: () => ({
        identity: [
          { id: 'e1', is: { text: 'A pathfinder', n: [1] } },
          { id: 'e2', is: { text: 'Possibly a merchant', n: [3] } },
        ],
      }),
      describe: () => ({ e2: { about: 'A merchant of Hollow.', n: [3] } }),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^e2 \| Fern /m);
    expect(asked[0]).toContain('[3] Fern is a merchant of Hollow.');
    expect(asked[0]).not.toMatch(/^e1 /m);
    expect(asked[0]).not.toMatch(/^e3 /m);
    expect(result.state.currentAbout('e1')).toBe('A pathfinder.');
    expect(result.state.currentAbout('e2')).toBe('A merchant of Hollow.');
    expect(result.state.currentAbout('e3')).toBe('Reveals nearby sources of magic.');
    expect(describe.record.counts).toEqual({ 'describe:gap': 1 });
  });

  it('drops a line naming someone its sentences never name', async () => {
    const sentences = book(['Fern met Piper.', 'Fern is a merchant.']);
    const entities = [
      entity('e2', 'character', [1, 2], { name: 'Fern', importance: 3 }),
      entity('e1', 'character', [1], { name: 'Piper', importance: 3 }),
    ];
    const { result, describe } = await gapRun(sentences, [unitOf([1, 2])], entities, {
      describe: () => ({ e2: { about: 'A merchant, half-brother of Shallan.', n: [2] }, e1: { about: 'A traveller who meets Fern.', n: [1] } }),
    });
    expect(result.state.currentAbout('e2')).toBeNull();
    expect(result.state.currentAbout('e1')).toBe('A traveller who meets Fern.');
    expect(describe.record.rejected).toMatchObject({ 'describe:ungrounded': 1 });
  });

  it('asks nothing when every entry has a line', async () => {
    const sentences = book(['Piper walks.']);
    const { asked, describe } = await gapRun(sentences, [unitOf([1])], [entity('e1', 'character', [1], { name: 'Piper', importance: 3 })], {
      facts: () => ({ identity: [{ id: 'e1', is: { text: 'A pathfinder', n: [1] } }] }),
    });
    expect(asked).toEqual([]);
    expect(describe.record.calls).toBe(0);
  });

  it('puts accepted minor-character timeline notes first and excludes later notes', async () => {
    const sentences = book(['Piper spotted Corven by the door.', 'The guard raised his spear.', 'Corven fled the city.']);
    const units = [unitOf([1, 2]), { ...unitOf([3]), id: 'u2', index: 1 }];
    const entities = [entity('e1', 'character', [1, 3], { name: 'Corven', importance: 3 })];
    const { result, asked } = await gapRun(sentences, units, entities, {
      facts: () => ({ identity: [{ id: 'e1', is: { text: 'A blond man', n: [1] } }] }),
      notes: (user) => ({
        notes: {
          e1: user.includes('Piper spotted')
            ? { note: 'Corven picked the lock and slipped inside.', n: [2] }
            : { note: 'Corven fled the city.', n: [3] },
        },
        summary: 'The guard raised his spear.',
      }),
      describe: () => ({ e1: { about: 'A trespasser who picked the lock and slipped inside.', n: [2] } }),
    });
    expect(result.state.timeline.get('e1')?.map(({ value }) => value.at)).toEqual([2, 3]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Timeline note [2] Corven picked the lock and slipped inside.\n  [1] Piper spotted Corven');
    expect(asked[0]).not.toContain('fled the city');
    expect(result.state.aboutAt('e1', 2)).toBe('A trespasser who picked the lock and slipped inside.');
  });

  it('rejects an unattributed hypothetical and accepts a relation followed by the named thought', async () => {
    const sentences = book(['Mirelle remembered Sorren, her brother.', 'Mirelle thought Sorren would be beside himself if she left.']);
    const units = [unitOf([1]), { ...unitOf([2]), id: 'u2', index: 1 }];
    const entities = [entity('e1', 'character', [1, 2], { name: 'Sorren', importance: 3 })];
    const { result, describe } = await gapRun(sentences, units, entities, {
      describe: (user) => ({
        e1: user.includes('[2]')
          ? { about: "Mirelle's brother. Mirelle thinks he would be beside himself if she left.", n: [2] }
          : { about: "Mirelle's brother. He would be beside himself if she left.", n: [1] },
      }),
    });
    expect(describe.record.rejected).toMatchObject({ 'describe:unattributed-modal': 1 });
    expect(result.state.aboutAt('e1', 1)).toBeNull();
    expect(result.state.aboutAt('e1', 2)).toBe("Mirelle's brother. Mirelle thinks he would be beside himself if she left.");
  });

  it('checks attribution for each modal clause in fiction only', () => {
    const names = { later: [], visible: [] };
    const line = 'Mirelle remembers him, and he could leave town.';
    expect(descriptionProblem(line, names, ['Sorren'], 100)).toBe('unattributed-modal');
    expect(descriptionProblem(line, names, ['Sorren'], 100, false, false)).toBeNull();
    expect(descriptionProblem('A brother who could leave, Mirelle thought.', names, ['Sorren'], 100)).toBeNull();
  });

  it('keeps the old rules: a line that breaks one is dropped, and an entry is tried in at most four units', async () => {
    const sentences = book(['Piper walks.', 'Piper runs.', 'Piper sits.', 'Piper sleeps.', 'Piper wakes.']);
    const units = [1, 2, 3, 4, 5].map((ordinal, index) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index }));
    const { result, asked, describe } = await gapRun(sentences, units, [entity('e1', 'character', [1, 2, 3, 4, 5], { name: 'Piper' })], {
      describe: () => ({ e1: { about: 'Piper is possibly a scout.', n: [1] } }),
    });
    expect(asked).toHaveLength(4);
    expect(result.state.currentAbout('e1')).toBeNull();
    expect(describe.record.counts).toEqual({ 'describe:gap': 4 });
    expect(describe.record.rejected).toEqual({ 'describe:hedge': 4, 'describe:deferred': 3, 'describe:never': 1 });
  });

  it('gives a nonfiction concept and a main-cast entry with no new facts their line', async () => {
    const sentences = book(['Orthogonality matters for Bostrom.', 'The thesis returns.']);
    const entities = [
      entity('e1', 'idea', [1, 2], { name: 'Orthogonality', importance: 2 }),
      entity('e2', 'character', [1], { name: 'Bostrom', importance: 3 }),
    ];
    const { result, asked } = await gapRun(sentences, [unitOf([1, 2])], entities, {
      mode: 'nonfiction',
      writesAbout: (slot) => slot.id === 'e1',
      describe: () => ({
        e1: { about: 'The claim that intelligence and goals vary independently.', n: [1] },
        e2: { about: 'A philosopher the book cites on goals.', n: [1] },
      }),
    });
    expect(asked).toHaveLength(1);
    expect(result.state.currentAbout('e1')).toBe('The claim that intelligence and goals vary independently.');
    expect(result.state.currentAbout('e2')).toBe('A philosopher the book cites on goals.');
  });
});

/** Steps and a run over `units`, every model call answered by `answer` (a null answer is a failed call). */
function denseHarness(sentences: Sentence[]) {
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const privacy = new XrayPrivacy(sentences);
  const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
  const steps = {
    notes: step('notes'),
    facts: step('facts'),
    ties: step('ties'),
    alias: step('alias'),
    describe: step('describe'),
    now: step('now'),
    about: step('about'),
  };
  const kindOf = (user: string) =>
    user.includes('notes: an object keyed by id') ? 'notes' : user.includes('1. pov:') ? 'scene' : user.includes('"identity":') ? 'facts' : 'other';
  const run = (
    entities: ReturnType<typeof entity>[],
    units: PassUnit[],
    answer: (kind: string, user: string) => unknown,
    delay: (kind: string, user: string) => number = () => 0,
    seen: { kind: string; user: string; maxOutputTokens: number }[] = [],
    events: string[] = [],
    options: { mode?: 'fiction' | 'nonfiction'; readDescription?: () => Promise<string | null>; writesAbout?: (slot: PassSlot) => boolean } = {},
  ) => {
    const ask: Ask =
      ({ user, maxOutputTokens }) =>
      () => {
        const kind = kindOf(user);
        seen.push({ kind, user, maxOutputTokens });
        events.push(`${kind}:call`);
        const reply = answer(kind, user);
        return new Promise((resolve, reject) =>
          setTimeout(
            () => {
              events.push(`${kind}:done`);
              if (reply === null) reject(new AiError('too-long', 'cut'));
              else resolve({ text: JSON.stringify(reply), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' });
            },
            delay(kind, user),
          ),
        );
      };
    return runDense({
      entities,
      units,
      sentences,
      mode: 'fiction',
      ask,
      askWrite: ask,
      askAbout: ask,
      ...steps,
      writesAbout: () => false,
      ...options,
    });
  };
  return { steps, run };
}

describe('repeated status facts', () => {
  it('asks for a now line once when later units repeat the same status fact', async () => {
    const sentences = book(['Viv lives at the old mill.', 'Viv lives at the old mill still.']);
    const viv = entity('v', 'character', [1, 2], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const units = [unitOf([1]), { ...unitOf([2]), id: 'u2', index: 1 }];
    await denseHarness(sentences).run(
      [viv],
      units,
      (kind, user) => {
        if (kind === 'facts')
          return { identity: [{ id: 'v', fact: 'Lives at the old mill.', kind: 'status', n: [Number(/\[(\d+)\]/.exec(user)?.[1])] }] };
        if (kind === 'notes') return { notes: {}, summary: 'Viv is at the mill.' };
        if (kind === 'scene') return { pov: null };
        return user.includes('\nnow: ') ? { now: { v: 'Based at the old mill.' } } : {};
      },
      undefined,
      seen,
      [],
      { writesAbout: (slot) => slot.id === 'v' },
    );
    expect(seen.filter(({ user }) => user.includes('\nnow: '))).toHaveLength(1);
  });
});

describe('notes on a thing in a run', () => {
  const sentences = book(['Tavia found the ember key.', 'The ember key was warm.', 'Tavia kept the ember key.', 'Tavia slept.']);
  const entities = () => [
    entity('e1', 'character', [1, 3, 4], { name: 'Tavia', importance: 3 }),
    entity('e2', 'object', [1, 2, 3], { name: 'ember key', importance: 3 }),
  ];
  const first = {
    notes: { e1: { note: 'Tavia finds a key.', n: [1] }, e2: { note: 'The ember key is warm.', n: [2] } },
    summary: 'Tavia finds a key.',
  };

  it.each([
    ['drops it when the rewrite still names no one', 'The ember key stays warm.', null],
    ['keeps the rewrite that names who acts', 'Tavia keeps the ember key.', 'Tavia keeps the ember key.'],
  ])('asks a note on an object naming no one once more and %s', async (_, rewrite, kept) => {
    const { run, steps } = denseHarness(sentences);
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const result = await run(
      entities(),
      [unitOf([1, 2, 3, 4])],
      (kind, user) => (kind !== 'notes' ? {} : user.includes('Answer only') ? { notes: { e2: { note: rewrite, n: [3] } } } : first),
      () => 0,
      seen,
    );
    const asks = seen.filter((call) => call.kind === 'notes');
    expect(asks).toHaveLength(2);
    expect(asks[0].user).toMatch(/Required: e1$/);
    expect(asks[1].user).toContain(`- e2: "The ember key is warm." (${NO_ACTOR})`);
    expect(result.state.timeline.get('e1')?.[0].value.note).toBe('Tavia finds a key.');
    expect(result.state.timeline.get('e2')?.[0]?.value.note ?? null).toBe(kept);
    expect(steps.notes.record.firstTry).toMatchObject({ 'notes:no-actor': 1 });
    if (!kept) expect(steps.notes.record.rejected).toMatchObject({ 'notes:rewrite-failed': 1 });
  });
});

describe('front matter and first-person narration', () => {
  const noFacts = { identity: [], abilities: [], merges: [] };

  it('makes no chunk asks for excluded structures and omits them from mixed chunks', async () => {
    const sentences = book(['Title page.', 'Table of contents.', 'Index entry.', 'Works cited.', 'The gate opened.']);
    (['front', 'contents', 'index', 'bibliography'] as const).forEach((structure, index) => (sentences[index].structure = structure));
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const { run } = denseHarness(sentences);
    await run([], [unitOf([1, 2, 3, 4])], () => {
      throw new Error('unexpected ask');
    });
    await run([], [unitOf([1, 2, 3, 4, 5])], () => ({ ...noFacts, notes: {}, summary: 'The gate opened.', pov: null }), undefined, seen);
    expect(seen.map(({ kind }) => kind)).toEqual(['notes', 'facts', 'scene']);
    for (const { user } of seen) {
      expect(user).toContain('[5] The gate opened.');
      expect(user).not.toMatch(/\[[1-4]\]/);
    }
  });

  it('uses 20 first-person pronouns per 1,000 narration words and excludes quoted speech across sentences', () => {
    const words = Array<string>(1000).fill('word');
    const atDensity = (pronouns: number) => book([`${'I '.repeat(pronouns)}${words.slice(pronouns).join(' ')}.`]);
    expect(new NarrationDetector().mentions(unitOf([1]), atDensity(19))).toEqual([]);
    expect(new NarrationDetector().mentions(unitOf([1]), atDensity(20))).toEqual([1]);
    const quoted = book(['“I keep my notes.', 'Me, myself, and mine.” She closed the book.', '"I won."', "'I did too.'"]);
    expect(new NarrationDetector().mentions(unitOf([1, 2, 3, 4]), quoted)).toEqual([]);
    const continued = book(['"I keep my notes.', '"I file them by date." She opened the book.']);
    const detector = new NarrationDetector();
    expect(detector.mentions(unitOf([1]), continued)).toEqual([]);
    expect(detector.mentions(unitOf([2]), continued)).toEqual([]);
    const first = book(['I opened my book.', 'The lock clicked.', '“I did too.”', 'I saw myself in the glass.']);
    expect(new NarrationDetector().mentions(unitOf([1, 2, 3, 4]), first)).toEqual([1, 2, 4]);
  });

  it('never counts the "I" of an inset letter as narration', () => {
    const letter = book(['I opened the envelope.', 'I write to you from the lighthouse.', 'I miss the harbour.', 'I folded it away.']);
    letter[1].inset = true;
    letter[2].inset = true;
    expect(new NarrationDetector().mentions(unitOf([1, 2, 3, 4]), letter)).toEqual([1, 4]);
    expect(new NarrationDetector().mentions(unitOf([2, 3]), letter)).toEqual([]);
  });

  it('credits the anonymous narrator in each first-person chunk and keeps that entry when nobody is named', async () => {
    const sentences = book(['I opened my book.', 'The lock clicked.', 'I turned back.', 'I put my book down.']);
    sentences[3].spineIndex = 1;
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const { run } = denseHarness(sentences);
    const result = await run(
      [],
      [unitOf([1, 2, 3]), { ...unitOf([4]), id: 'u2', index: 1, s: 1 }],
      (kind) => {
        if (kind === 'notes') return { notes: { narrator: { note: 'Opens the book.', n: [1] } }, summary: 'A lock clicks.' };
        return kind === 'scene' ? { pov: null } : noFacts;
      },
      undefined,
      seen,
    );
    expect(seen.find(({ kind }) => kind === 'notes')?.user).toContain('narrator | Narrator | - | character | 3');
    expect(seen.find(({ kind }) => kind === 'scene')?.user).not.toContain('narrator | Narrator');
    expect(result.state.timeline.get('narrator')?.[0].value).toEqual({ note: 'Opens the book.', at: 1 });
    const payload = passPayload(result, 'fiction', (n) => ({ s: 0, n, o: n, q: '' }), sentences);
    expect(payload.entities).toMatchObject([{ name: 'Narrator', kind: 'character', count: 4, ordinals: [1, 2, 3, 4], importance: 2 }]);
  });

  it('keeps a third-person fixture with dialogue and a viewpoint character unchanged', async () => {
    const sentences = book(['Viv waved. “I opened my book,” she said.', '"I knew it." Viv sat down.']);
    const viv = entity('v', 'character', [1, 2], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const readDescription = vi.fn(() => Promise.resolve('Viv'));
    const result = await denseHarness(sentences).run(
      [viv],
      [unitOf([1, 2])],
      (kind) => (kind === 'notes' ? { notes: { v: 'Viv sits down.' }, summary: 'Viv sits down.' } : kind === 'scene' ? { pov: 'v' } : noFacts),
      undefined,
      seen,
      [],
      { readDescription },
    );
    const notes = seen.find(({ kind }) => kind === 'notes')?.user;
    expect(notes).toContain('v | Viv | - | character | 2');
    expect(notes).not.toMatch(/narrator \||First-person narration/);
    expect(result.cast.heads).toMatchObject([{ name: 'Viv', count: 2 }]);
    expect(result.pov.get('u1c1')).toBe('v');
    expect(readDescription).not.toHaveBeenCalled();
  });

  const oneSentenceUnits = (sentences: Sentence[], section: (index: number) => number = () => 0) =>
    sentences.map(({ ordinal }, index) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index, s: section(index) }));
  const narratorLine = (user: string) => /quoted writing refers to (\S+)\./.exec(user)?.[1] ?? null;

  it('never names the narrator on a vote or two, even when the blurb names them', async () => {
    const sentences = book(['I, Viv, turned the key.', 'I waited by my window.', 'I waited again.']);
    const viv = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const result = await denseHarness(sentences).run(
      [viv],
      oneSentenceUnits(sentences),
      (kind) => (kind === 'scene' ? { pov: 'v' } : kind === 'notes' ? { notes: {}, summary: 'Someone waits.' } : noFacts),
      undefined,
      seen,
      [],
      { readDescription: () => Promise.resolve('<p>Viv faces the world.</p>') },
    );
    expect(result.cast.merges).toEqual([]);
    expect(result.cast.heads.map(({ name }) => name)).toEqual(['Viv', 'Narrator']);
    expect(seen.filter(({ kind }) => kind === 'notes').map(({ user }) => narratorLine(user))).toEqual(['narrator', 'narrator', 'narrator']);
  });

  it('joins the stand-in where six votes in short sections settle the narrator, and credits later chunks to them', async () => {
    const sentences = book(Array.from({ length: 9 }, (_, index) => (index ? 'I waited by my window.' : 'I, Viv, turned the key.')));
    const viv = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const result = await denseHarness(sentences).run(
      [viv],
      oneSentenceUnits(sentences, (index) => index),
      (kind) => (kind === 'scene' ? { pov: 'v' } : kind === 'notes' ? { notes: {}, summary: 'Someone waits.' } : noFacts),
      undefined,
      seen,
    );
    expect(result.cast.merges).toEqual([expect.objectContaining({ rule: 'narrator', ordinal: NARRATOR_SETTLED_VOTES })]);
    expect(result.cast.heads).toMatchObject([{ name: 'Viv', count: 9 }]);
    // A unit launches once the unit two before it is done, so the sixth vote first reaches the eighth unit's prompt.
    const owners = seen.filter(({ kind }) => kind === 'notes').map(({ user }) => narratorLine(user));
    expect(owners).toEqual([...Array<string>(NARRATOR_SETTLED_VOTES + 1).fill('narrator'), 'v', 'v']);
  });

  it('credits a long section to its own narrator when two narrators take turns', async () => {
    const sentences = book(Array.from({ length: 12 }, (_, index) => (index < 6 ? `I, Ana, kept watch ${index}.` : `I, Bo, kept watch ${index}.`)));
    const ana = entity('a', 'character', [1, 2, 3, 4, 5, 6], { name: 'Ana', names: [{ text: 'Ana', ordinal: 1 }] });
    const bo = entity('b', 'character', [7, 8, 9, 10, 11, 12], { name: 'Bo', names: [{ text: 'Bo', ordinal: 7 }] });
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    await denseHarness(sentences).run(
      [ana, bo],
      oneSentenceUnits(sentences, (index) => (index < 6 ? 0 : 1)),
      (kind, user) =>
        kind === 'scene' ? { pov: user.includes('I, Ana') ? 'a' : 'b' } : kind === 'notes' ? { notes: {}, summary: 'Someone keeps watch.' } : noFacts,
      undefined,
      seen,
    );
    const owners = seen.filter(({ kind }) => kind === 'notes').map(({ user }) => narratorLine(user));
    expect(owners.slice(4, 6)).toEqual(['a', 'a']);
    expect(owners.slice(10)).toEqual(['b', 'b']);
  });

  it('reads first-person chunks side by side before the narrator is settled', async () => {
    const sentences = book(Array.from({ length: 12 }, (_, index) => (index ? 'I waited by the window again.' : 'I am Viv and I wait.')));
    const viv = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const units = sentences.map(({ ordinal }, index) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index }));
    let open = 0;
    const overlap: number[] = [];
    await denseHarness(sentences).run(
      [viv],
      units,
      (kind, user) => {
        const start = Number(user.match(/\[(\d+)\]/)?.[1]);
        if (kind === 'notes') {
          overlap[start] = ++open;
          setTimeout(() => open--, 5);
          return { notes: {}, summary: 'Viv waits.' };
        }
        return kind === 'scene' ? { pov: 'v' } : noFacts;
      },
      (kind) => (kind === 'notes' ? 5 : 1),
    );
    expect(Math.max(...overlap.slice(1, NARRATOR_SETTLED_VOTES + 1).filter(Boolean))).toBeGreaterThan(1);
  });

  it('also credits narration and accepts a named point of view in nonfiction', async () => {
    const sentences = book(['I, Viv, wrote a diary.', 'I rewrote it.']);
    const viv = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const units = sentences.map(({ ordinal }) => ({ ...unitOf([ordinal]), id: `u${ordinal}` }));
    const result = await denseHarness(sentences).run(
      [viv],
      units,
      (kind, user) => {
        if (kind === 'scene') {
          expect(user).toContain('the roster id of the named person whose first-person narration');
          return { pov: 'v' };
        }
        if (kind === 'notes') return { notes: {}, summary: 'Viv writes.' };
        return noFacts;
      },
      undefined,
      [],
      [],
      { mode: 'nonfiction' },
    );
    expect([...result.pov.values()]).toEqual(['v', 'v']);
    expect(result.cast.heads.map(({ name }) => name)).toEqual(['Viv', 'Narrator']);
  });

  it('cannot name the narrator from a blurb or third-person POV alone', async () => {
    const sentences = book(['Viv waved.', 'I closed my book.', 'I opened it again.']);
    const viv = entity('v', 'character', [1], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
    const units = sentences.map(({ ordinal }) => ({ ...unitOf([ordinal]), id: `u${ordinal}` }));
    const result = await denseHarness(sentences).run(
      [viv],
      units,
      (kind, user) =>
        kind === 'notes' ? { notes: {}, summary: 'The book closes.' } : kind === 'scene' ? { pov: user.includes('[1]') ? 'v' : null } : noFacts,
      undefined,
      [],
      [],
      { readDescription: () => Promise.resolve('Viv tells this story.') },
    );
    expect(result.cast.heads.map(({ name }) => name)).toEqual(['Viv', 'Narrator']);
    expect(result.cast.merges).toEqual([]);
  });

  it('uses narration as evidence for a short anonymous description', async () => {
    const sentences = book(['I kept my diary by the window.']);
    const result = await denseHarness(sentences).run([], [unitOf([1])], (kind) => {
      if (kind === 'scene') return { pov: null };
      if (kind === 'notes') return { notes: {}, summary: 'A diary sits by the window.' };
      if (kind === 'facts') return { identity: [{ id: 'narrator', is: { text: 'The narrator keeps a diary.', n: [1] } }] };
      return {};
    });
    expect(result.state.currentAbout('narrator')).toBe('The narrator keeps a diary.');
  });

  it('allows the narrator phrase only in the anonymous entry description, about line and note', async () => {
    const names = { visible: [], later: [] };
    expect(descriptionProblem('The narrator keeps a diary.', names, ['Narrator'], 12, true)).toBeNull();
    expect(descriptionProblem('The narrator keeps a diary.', names, ['Viv'], 12)).toBe('narrator');

    const sentences = book(['I kept my diary by the window. Viv arrived.']);
    const viv = entity('v', 'character', [1], { name: 'Viv', importance: 2 });
    const result = await denseHarness(sentences).run(
      [viv],
      [unitOf([1])],
      (kind, user) => {
        if (kind === 'notes') return { notes: { narrator: 'The narrator writes.', v: null }, summary: 'Viv arrives.' };
        if (kind === 'scene') return { pov: null };
        if (kind === 'facts')
          return {
            identity: [
              { id: 'narrator', fact: 'Keeps a diary.', n: [1] },
              { id: 'v', fact: 'Arrives.', n: [1] },
            ],
          };
        if (user.includes(' | current:'))
          return { narrator: { about: 'The narrator keeps a diary.', n: [1] }, v: { about: 'The narrator arrives.', n: [1] } };
        return {};
      },
      undefined,
      [],
      [],
      { writesAbout: () => true },
    );
    expect(result.state.currentAbout('narrator')).toBe('The narrator keeps a diary.');
    expect(result.state.currentAbout('v')).toBeNull();
    expect(result.state.timeline.get('narrator')?.[0].value.note).toBe('The narrator writes.');
  });
});

describe('dense run order and context', () => {
  it('carries a POV through a unit past a failed scene call, and never into the next unit', async () => {
    const texts = Array.from({ length: 301 }, () => 'Piper walked.');
    texts[0] = texts[100] = 'Piper and Fern meet Rowan.';
    texts[200] = 'Piper and Fern walked.';
    const sentences = book(texts);
    const all = Array.from({ length: 301 }, (_, index) => index + 1);
    const entities = [
      entity('e1', 'character', all, { name: 'Piper', importance: 3 }),
      entity('e2', 'character', [1, 101, 201], { name: 'Fern', importance: 3 }),
      entity('e3', 'character', [1, 101], { name: 'Rowan', importance: 3 }),
    ];
    const units = [
      { ...unitOf(all.slice(0, 300)), id: 'u1' },
      { ...unitOf([301]), id: 'u2', index: 1 },
    ];
    const { run } = denseHarness(sentences);
    const result = await run(entities, units, (kind, user) =>
      kind === 'scene'
        ? user.includes('[101] ') || user.includes('[301] ')
          ? null
          : { pov: 'e2', same: [], relations: [] }
        : kind === 'notes'
          ? { notes: {} }
          : {},
    );
    expect([...result.pov]).toEqual([
      ['u1c1', 'e2'],
      ['u1c2', 'e2'],
      ['u1c3', 'e2'],
      ['u2c1', null],
    ]);
  });

  it('asks for a scene card on every chunk, even one that names only the lead', async () => {
    const sentences = book(['Piper walked.', 'Piper ran.', 'Piper slept.']);
    const entities = [entity('e1', 'character', [1, 2, 3], { name: 'Piper', importance: 1, count: 30 })];
    const { steps, run } = denseHarness(sentences);
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    await run(entities, [unitOf([1, 2, 3])], (kind) => (kind === 'scene' ? { pov: 'e1', same: [], relations: [] } : {}), undefined, seen);
    expect(seen.filter(({ kind }) => kind === 'scene')).toHaveLength(1);
    expect(steps.ties.record.counts?.['scene:skipped']).toBeUndefined();
  });

  it('sends an evidence-only notes re-ask after the chunk facts and scene are done, and a whole-chunk re-ask without waiting', async () => {
    const sentences = book(['Viv walked.', 'Viv ran.', 'Viv slept.', 'Fern woke.', 'Fern ate.', 'Fern sat.']);
    const entities = [
      entity('e1', 'character', [1, 2, 3], { name: 'Viv', importance: 3 }),
      entity('e2', 'character', [4, 5, 6], { name: 'Fern', importance: 3 }),
    ];
    const secondNotes = (events: string[]) => events.indexOf('notes:call', events.indexOf('notes:call') + 1);
    const slowOthers = (kind: string) => (kind === 'facts' || kind === 'scene' ? 30 : 0);

    const events: string[] = [];
    await denseHarness(sentences).run(
      entities,
      [unitOf([1, 2, 3, 4, 5, 6])],
      (kind, user) =>
        kind !== 'notes' ? {} : user.includes('Answer only') ? { notes: { e2: null } } : { notes: { e1: null }, summary: 'Viv walks.' },
      slowOthers,
      [],
      events,
    );
    const retry = secondNotes(events);
    const before = events.slice(0, retry);
    expect(retry).toBeGreaterThan(0);
    expect(before.filter((event) => event === 'facts:done')).toHaveLength(before.filter((event) => event === 'facts:call').length);
    expect(before.filter((event) => event === 'scene:done')).toHaveLength(before.filter((event) => event === 'scene:call').length);
    expect(before).toContain('facts:done');

    const cut: string[] = [];
    let cutFirst = true;
    await denseHarness(sentences).run(
      entities,
      [unitOf([1, 2, 3, 4, 5, 6])],
      (kind) => {
        if (kind !== 'notes') return {};
        if (!cutFirst) return { notes: { e1: null, e2: null }, summary: 'Viv walks.' };
        cutFirst = false;
        return null;
      },
      slowOthers,
      [],
      cut,
    );
    expect(secondNotes(cut)).toBeLessThan(cut.indexOf('facts:done'));
  });

  it('shows a unit what was stamped two units back, so two runs with different timings send the same prompts', async () => {
    const sentences = book(['Viv walked.', 'Viv ran.', 'Fern woke.', 'Viv and Fern ate.', 'Viv and Fern sat.', 'Viv left.']);
    const entities = [
      entity('e1', 'character', [1, 2, 4, 5, 6], { name: 'Viv', importance: 3 }),
      entity('e2', 'character', [3, 4, 5], { name: 'Fern', importance: 3 }),
    ];
    const units = [
      { ...unitOf([1, 2]), id: 'u1' },
      { ...unitOf([3, 4]), id: 'u2', index: 1 },
      { ...unitOf([5, 6]), id: 'u3', index: 2 },
    ];
    const answer = (kind: string, user: string) => {
      if (kind === 'notes') return { notes: {}, summary: user.includes('[1] ') ? 'Viv walks.' : user.includes('[3] ') ? 'Fern wakes.' : 'They sit.' };
      if (kind === 'facts')
        return {
          identity: [
            ...(user.includes('[1] ') ? [{ id: 'e1', is: { text: 'A pathfinder', n: [1] } }] : []),
            ...(user.includes('[3] ') ? [{ id: 'e2', is: { text: 'A cook', n: [3] } }] : []),
          ],
        };
      return {};
    };
    const prompts = async (delay: (kind: string, user: string) => number) => {
      const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
      await denseHarness(sentences).run(entities, units, answer, delay, seen);
      return seen.map(({ user }) => user).sort();
    };
    const slowFirst = await prompts((_, user) => (user.includes('[1] ') ? 30 : 0));
    const slowSecond = await prompts((_, user) => (user.includes('[3] ') ? 30 : 0));
    expect(slowFirst).toEqual(slowSecond);
    const third = slowFirst.filter((user) => user.includes('[5] ') && user.includes('"identity":'));
    expect(third).toHaveLength(1);
    expect(third[0]).toMatch(/e1 \| Viv[^\n]*about: A pathfinder\./);
    expect(third[0]).not.toMatch(/about: A cook/);
    expect(third[0]).toMatch(/e2 \| Fern[^\n]*needs is/);
    const notes = slowFirst.filter((user) => user.includes('notes: an object keyed by id'));
    expect(notes.find((user) => user.includes('[5] '))).toContain('<before>\nViv walks.\n</before>');
    expect(notes.find((user) => user.includes('[3] '))).not.toContain('<before>\n');
  });

  it('raises the facts cap by forty tokens for each name asked for an is phrase, up to a thousand', async () => {
    const sentences = book(['Viv and Fern walked.', 'Viv and Fern ran.']);
    const entities = [
      entity('e1', 'character', [1, 2], { name: 'Viv', importance: 3 }),
      entity('e2', 'character', [1, 2], { name: 'Fern', importance: 3 }),
    ];
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    await denseHarness(sentences).run(entities, [unitOf([1, 2])], () => ({}), undefined, seen);
    expect(seen.find(({ kind }) => kind === 'facts')?.maxOutputTokens).toBe(FACTS_MAX_OUTPUT_TOKENS + 80);
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `e${index}` }) as PassSlot);
    expect(factsOutputTokens(many, new Set(many.map(({ id }) => id)))).toBe(FACTS_MAX_OUTPUT_TOKENS + 1000);
    expect(factsOutputTokens(many)).toBe(FACTS_MAX_OUTPUT_TOKENS);
  });
});

describe('description step', () => {
  it('strips citation markers and a case-insensitive name or alias followed by a copula', () => {
    expect(clean('The RED was a fishmonger (n12, n40) [123].', ['Kark', 'the Red'])).toBe('A fishmonger.');
    expect(clean('A dragon (n1).', ['Arthur'])).toBe('A dragon.');
    expect(clean('Arthur, a dragon.', ['Arthur'])).toBe('A dragon.');
    expect(clean('Coherent extrapolated volition (CEV) is a proposal for what an AI should want.', ['coherent extrapolated volition'])).toBe(
      'A proposal for what an AI should want.',
    );
    expect(clean('Indirect normativity refers to the idea of delegating value choice.', ['indirect normativity'])).toBe('Delegating value choice.');
    expect(clean('Oracles are question-answering systems.', ['oracle'])).toBe('Question-answering systems.');
    expect(clean('An oracle is a question-answering system.', ['oracle'])).toBe('A question-answering system.');
    expect(clean('Boxing methods are ways to confine an AI.', ['boxing'])).toBe('Ways to confine an AI.');
    expect(clean('RED: a fishmonger.', ['Kark', 'Red'])).toBe('A fishmonger.');
    expect(clean('Viv - a princess.', ['Viv'])).toBe('A princess.');
    expect(clean('The Solfis is a golem.', ['Solfis'])).toBe('A golem.');
    expect(clean('Arthurian legends.', ['Arthur'])).toBe('Arthurian legends.');
  });

  it.each([
    ['An object, a faded enchanted skinsuit.', 'A faded enchanted skinsuit.'],
    ['An object: a faded enchanted skinsuit.', 'A faded enchanted skinsuit.'],
    ['An idea of a sled used to carry a core', 'A sled used to carry a core'],
    ['A concept of dark magical energy.', 'Dark magical energy.'],
    ['An item, a silver key.', 'A silver key.'],
    ['A term for dark magical energy.', 'Dark magical energy.'],
    ['Arthur is a character: a knight of the Round Table.', 'A knight of the Round Table.'],
  ])('cleans the kind lead from %s', (raw, expected) => {
    expect(clean(raw, ['Arthur'])).toBe(expected);
  });
});

describe('scene roster', () => {
  it.each([
    ['fiction', 30, 25],
    ['nonfiction', 40, 40],
  ] as const)('uses the %s cumulative and local limits at the chunk cutoff', (mode, cumulativeLimit, localLimit) => {
    const frequent = Array.from({ length: 42 }, (_, index) => entity(`past${index}`, 'place', [1, 2]));
    const local = Array.from({ length: 42 }, (_, index) => entity(`local${index}`, 'object', [3, 10, 11, 12]));
    const cast = new PassCast([...frequent, ...local]);
    const ids = sceneRoster(cast, unitOf([3]), mode).map(({ id }) => id);
    expect(ids).toEqual([...frequent.slice(0, cumulativeLimit), ...local.slice(0, localLimit)].map(({ id }) => id));
  });
});

describe('scene same votes', () => {
  it("counts unordered pairs once per chunk and merges into the head with more mentions so far, from the chunk's last sentence", () => {
    const arthur = entity('arthur', 'character', [1, 2, 3]);
    const golem = entity('golem', 'character', [1, 5, ...Array.from({ length: 40 }, (_, index) => index + 10)]);
    const cast = new PassCast([arthur, golem]);
    const [a, b] = cast.slots(unitOf([1, 2, 3, 4, 5]));
    const said = book(['Arthur is the golem.', 'Arthur ran.', 'Arthur hid.', 'Rain.', 'The golem was Arthur.']);
    const same = new SceneSame();
    expect(
      same.apply(
        cast,
        unitOf([1, 2, 3]),
        [
          { a, b, cite: 1 },
          { a: b, b: a, cite: 1 },
        ],
        said,
      ),
    ).toEqual({});
    expect(cast.merges).toEqual([]);
    expect(same.apply(cast, unitOf([4, 5]), [{ a: b, b: a, cite: 5 }], said)).toEqual({ 'scene:same-merge': 1 });
    expect(cast.merges).toEqual([{ head: arthur, member: golem, ordinal: 5, rule: 'alias', reason: 'scene-same' }]);
  });

  it('guards two characters at 20 mentions each, and keeps a character paired with a place apart in either order by kind', () => {
    const ordinals = Array.from({ length: 20 }, (_, index) => index + 1);
    const cast = new PassCast([
      entity('viv', 'character', ordinals),
      entity('arthur', 'character', ordinals),
      entity('apex', 'place', [1, 20]),
      entity('palace', 'place', [1, 20]),
    ]);
    const [viv, arthur, apex, palace] = cast.slots(unitOf(ordinals));
    const pairs = (cite: number) => [
      { a: viv, b: arthur, cite },
      { a: viv, b: apex, cite },
      { a: palace, b: arthur, cite },
    ];
    const said = book(ordinals.map(() => 'Viv is Arthur, the Apex and the Palace.'));
    const same = new SceneSame();
    same.apply(cast, unitOf(ordinals.slice(0, 19)), pairs(1), said);
    expect(same.apply(cast, unitOf([20]), [...pairs(20), ...pairs(20)], said)).toEqual({ 'scene:same-guard': 1, 'scene:same-kind': 2 });
    expect(cast.merges).toEqual([]);
  });

  it('allows two characters to merge while one is still under 20 mentions', () => {
    const ordinals = Array.from({ length: 30 }, (_, index) => index + 1);
    const arthur = entity('arthur', 'character', ordinals);
    const viv = entity(
      'viv',
      'character',
      ordinals.filter((ordinal) => ordinal !== 19),
    );
    const cast = new PassCast([arthur, viv]);
    const [a, b] = cast.slots(unitOf(ordinals));
    const said = book(ordinals.map(() => 'Arthur was Viv.'));
    const same = new SceneSame();
    same.apply(cast, unitOf(ordinals.slice(0, 18)), [{ a, b, cite: 1 }], said);
    expect(same.apply(cast, unitOf([19, 20]), [{ a, b, cite: 20 }], said)).toEqual({ 'scene:same-merge': 1 });
    expect(cast.merges[0]).toMatchObject({ member: viv, head: arthur, ordinal: 20 });
  });
});

describe('window links', () => {
  const ordinals = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const episodes = (first: number, count: number) => Array.from({ length: count }, (_, index) => first + index * 30);
  const background = entity('background', 'idea', episodes(101, 42));
  const throughBackground = background.ordinals.at(-1)!;

  it('counts a single shared sentence as one episode and admits a relation even with low lift', () => {
    const a = entity('a', 'character', [25]);
    const b = entity('b', 'character', [25]);
    const cast = new PassCast([a, b]);
    const units = [unitOf(ordinals(1, 30))];
    expect(windowLinks(cast, units)).toEqual([]);
    expect(windowLinks(cast, units, [{ a, b, cite: 25 }])).toMatchObject([{ count: 1 }]);
  });

  it('links entries named together once when later background episodes raise lift', () => {
    const cast = new PassCast([entity('a', 'character', [1]), entity('b', 'character', [1]), background]);
    const first = unitOf(ordinals(1, 100));
    const second = { ...unitOf(ordinals(101, 110)), id: 'u2', index: 1 };
    const third = { ...unitOf(ordinals(111, throughBackground)), id: 'u3', index: 2 };

    expect(windowLinks(cast, [first])).toEqual([]);
    expect(windowLinks(cast, [first, second])).toEqual([{ a: 'a', b: 'b', count: 1, score: 1, from: 110, until: null }]);
    expect(windowLinks(cast, [first, second, third])).toMatchObject([{ count: 1, from: 110 }]);
  });

  it('does not link rare entries named in adjacent sentences once', () => {
    const cast = new PassCast([entity('a', 'character', [1]), entity('b', 'character', [2]), background]);
    expect(windowLinks(cast, [unitOf(ordinals(1, throughBackground))])).toEqual([]);
  });

  it('requires lift for an item named once in the same sentence as a hub with 40 episodes', () => {
    const hub = entity('hub', 'character', episodes(1, 40));
    const item = entity('item', 'object', [1]);
    expect(windowLinks(new PassCast([hub, item]), [unitOf(ordinals(1, hub.ordinals.at(-1)!))])).toEqual([]);
  });

  it.each([
    {
      line: '[Mana manipulation: Beginner 8 improves focus',
      expected: [{ a: 'beginner', b: 'mana', count: 0, score: 0, from: throughBackground, until: null }],
    },
    { line: 'Mana manipulation has reached Beginner 8', expected: [] },
  ])('uses only same-line card evidence on quiet lines: $line', ({ line, expected }) => {
    const sentences = book([line, 'The sword was sharp.']);
    const cast = new PassCast([entity('mana', 'idea', [1, 20]), entity('beginner', 'idea', [1]), entity('sword', 'object', [2]), background]);
    const text = (ordinal: number) => sentences[ordinal - 1]?.text ?? 'They walked on.';

    expect(
      windowLinks(
        cast,
        [unitOf(ordinals(1, throughBackground))],
        [],
        (ordinal) => systemLine(text(ordinal)),
        (ordinal) => cardLine(text(ordinal)),
      ),
    ).toEqual(expected);
  });

  it('blocks a shared prose sentence when an entry is stat-heavy', () => {
    const cast = new PassCast([entity('a', 'character', [1]), entity('stat', 'idea', ordinals(1, 10)), background]);
    const units = [unitOf(ordinals(1, throughBackground))];
    expect(windowLinks(cast, units, [], (ordinal) => ordinal >= 8 && ordinal <= 10)).toEqual([]);
    expect(windowLinks(cast, units, [], (ordinal) => ordinal >= 9 && ordinal <= 10)).toMatchObject([{ a: 'a', b: 'stat', count: 1 }]);
  });

  it('caps single links by lift and breaks ties by earliest evidence', () => {
    const shared = [1, 6, 11, 16, 21];
    const hub = entity('hub', 'idea', shared);
    const partners = shared.map((ordinal, index) => entity(`partner${index}`, 'idea', index % 2 === 0 ? [ordinal, 40 + index * 5] : [ordinal]));
    const links = windowLinks(new PassCast([hub, ...partners, background]), [unitOf(ordinals(1, throughBackground))]);

    expect(links).toHaveLength(SINGLE_LINK_CAP);
    expect(links).toMatchObject([0, 1, 3].map((index) => ({ a: 'hub', b: `partner${index}`, count: 1 })));
  });

  it('fills the cap with repeated links before considering a higher-lift single link', () => {
    const partners = Array.from({ length: LINK_CAP }, (_, index) => entity(`partner${index}`, 'idea', episodes(1 + index * 90, 3)));
    const single = entity('single', 'idea', [1351]);
    const hub = entity('hub', 'idea', [...partners.flatMap((partner) => partner.ordinals.slice(0, 2)), ...single.ordinals]);
    const later = entity('later', 'idea', episodes(1500, 72));
    const units = [unitOf(ordinals(1, later.ordinals.at(-1)!))];

    expect(windowLinks(new PassCast([hub, single, ...partners.slice(1), later]), units)).toContainEqual(
      expect.objectContaining({ a: 'hub', b: 'single', count: 1 }),
    );
    expect(windowLinks(new PassCast([hub, single, ...partners, later]), units)).toMatchObject(
      partners.map((partner) => ({ a: 'hub', b: partner.key, count: 2 })),
    );
  });

  it('waits for the shared sentence before linking even when lift is already high', () => {
    const cast = new PassCast([entity('a', 'character', [1400, 1402]), entity('b', 'character', [1401, 1402]), background]);
    const first = unitOf(ordinals(1, 1401), false);
    const second = { ...unitOf(ordinals(1402, 1410)), id: 'u2', index: 1 };

    expect(windowLinks(cast, [first])).toEqual([]);
    expect(windowLinks(cast, [first, second])).toMatchObject([{ a: 'a', b: 'b', count: 1, from: 1410 }]);
  });

  it('admits two separate episodes on lift when their share is below the threshold', () => {
    const a = entity(
      'a',
      'character',
      Array.from({ length: 14 }, (_, index) => 1 + 25 * index),
    );
    const b = entity('b', 'character', [1, 26]);
    const background = entity(
      'background',
      'idea',
      Array.from({ length: 26 }, (_, index) => 400 + 25 * index),
    );
    const units = [unitOf(ordinals(1, 1025))];

    expect(windowLinks(new PassCast([a, b]), units)).toEqual([]);
    expect(windowLinks(new PassCast([a, b, background]), units)).toEqual([{ a: 'a', b: 'b', count: 2, score: 1, from: 1025, until: null }]);
    expect(windowLinks(new PassCast([a, b, background]), units, [], (ordinal) => ordinal >= 400)).toEqual([]);
  });

  it('uses the smaller side to link a character hub after three shared episodes', () => {
    const hubEpisodes = Array.from({ length: 24 }, (_, index) => 1 + 30 * index);
    const viv = entity('viv', 'character', hubEpisodes);
    const undead = entity('undead', 'idea', hubEpisodes.slice(-3));
    const cast = new PassCast([viv, undead]);
    const first = unitOf(ordinals(1, 685), false);
    const second = { ...unitOf(ordinals(686, 700)), id: 'u2', index: 1 };

    expect(windowLinks(cast, [first])).toEqual([]);
    expect(windowLinks(cast, [first, second])).toMatchObject([{ a: 'undead', b: 'viv', count: 3, from: 700 }]);
  });

  it('links a single dense scene once both entries have three distinct sentence hits', () => {
    const a = entity('a', 'character', [1, 2, 3]);
    const b = entity('b', 'character', [4, 5, 6]);
    const cast = new PassCast([a, b]);
    const first = unitOf(ordinals(1, 5), false);
    const second = { ...unitOf([6, 7]), id: 'u2', index: 1 };

    expect(windowLinks(cast, [first])).toEqual([]);
    expect(windowLinks(cast, [first, second])).toMatchObject([{ a: 'a', b: 'b', count: 1, from: 7 }]);
  });

  it('does not link an item named once to a place hub mentioned everywhere', () => {
    const through = ordinals(1, 80);
    const palace = entity('palace', 'place', through);
    const item = entity('sword', 'idea', [35]);
    expect(windowLinks(new PassCast([palace, item]), [unitOf(through)])).toEqual([]);
  });

  it.each([
    {
      path: 'smaller side',
      hub: Array.from({ length: 24 }, (_, index) => 1 + index * 30),
      prose: [1, 31, 61],
      quietMentions: [10, 40, 70],
      end: 700,
      count: 3,
    },
    { path: 'dense scene', hub: [1, 2, 3], prose: [1, 2, 3, 10, 11, 12, 13], quietMentions: [14, 15, 16], end: 16, count: 1 },
  ])('blocks the $path path for a stat-heavy entry', ({ hub, prose, quietMentions, end, count }) => {
    const cast = new PassCast([
      entity('a', 'character', hub),
      entity(
        'stat',
        'idea',
        [...prose, ...quietMentions].sort((a, b) => a - b),
      ),
    ]);
    const units = [unitOf(ordinals(1, end))];
    const quiet = (ordinal: number) => quietMentions.includes(ordinal);
    const proseOnly = new PassCast([entity('a', 'character', hub), entity('stat', 'idea', prose)]);

    expect(windowLinks(proseOnly, units, [], quiet)).toMatchObject([{ count }]);
    expect(windowLinks(cast, units, [], quiet)).toEqual([]);
  });

  it('reevaluates the quiet share when prose mentions leave the episode counts unchanged', () => {
    const a = entity('a', 'character', [1, 2, 3]);
    const stat = entity('stat', 'idea', [1, 2, 3, 7, 8, 9, 10]);
    const cast = new PassCast([a, stat]);
    const quiet = (ordinal: number) => ordinal === 7 || ordinal === 8;
    const first = unitOf(ordinals(1, 9), false);
    const second = { ...unitOf([10, 11]), id: 'u2', index: 1 };

    expect(windowLinks(cast, [first], [], quiet)).toEqual([]);
    expect(windowLinks(cast, [first, second], [], quiet)).toMatchObject([{ count: 1, from: 11 }]);
  });

  it('ignores co-mentions on status-screen lines', () => {
    const sentences = book(ordinals(1, 60).map(() => 'They walked on.'));
    sentences[0].text = 'Mara took the sword.';
    sentences[25].text = 'MARA EQUIPPED THE SWORD!';
    sentences[50].text = ' [Equipment: Mara, sword]';
    const mara = entity('mara', 'character', [1, 26, 51]);
    const sword = entity('sword', 'idea', [1, 26, 51]);
    const cast = new PassCast([mara, sword]);
    const units = [unitOf(ordinals(1, 60))];
    const quiet = (ordinal: number) => systemLine(sentences[ordinal - 1].text);

    expect(windowLinks(cast, units)).toMatchObject([{ count: 3 }]);
    expect(windowLinks(cast, units, [], (ordinal) => ordinal === 51)).toMatchObject([{ count: 2 }]);
    expect(windowLinks(cast, units, [], quiet)).toEqual([]);
    expect(windowLinks(cast, units, [{ a: mara, b: sword, cite: 1 }], quiet)).toMatchObject([{ count: 1 }]);
  });

  it('uses a strict majority threshold above 60 percent of letters, including Unicode capitals', () => {
    expect(systemLine('ÄÖÜab! 123')).toBe(false);
    expect(systemLine('ÄÖÜAb! 123')).toBe(true);
    expect(systemLine('123!')).toBe(false);
  });

  it('reads status-screen stat lines as system lines and leaves prose with a colon alone', () => {
    expect(systemLine('Acuity +1')).toBe(true);
    expect(systemLine('Intimidation reached Beginner 2')).toBe(true);
    expect(systemLine('Exhaustion')).toBe(true);
    expect(systemLine('[Power: your strength and defense.')).toBe(true);
    expect(systemLine('Her plan was simple: run.')).toBe(false);
    expect(systemLine('Viv thought: not again.')).toBe(false);
    expect(systemLine('Run!')).toBe(false);
  });

  it.each([
    ['Acuity +1', true, false],
    ['Exhaustion', true, false],
    ['Mana manipulation has reached Beginner 8', true, false],
    ['Mana sense: Beginner 2', true, false],
    ['[Necrarch ravager: an extremely dangerous undead creature', false, true],
    ['//WHY NOT USE MY RAVAGER BLADE?', false, true],
    ['Her plan was simple: run.', false, false],
  ] as const)('classifies stat and card lines: %s', (line, stat, card) => {
    expect(statLine(line)).toBe(stat);
    expect(cardLine(line)).toBe(card);
    expect(systemLine(line)).toBe(stat || card);
  });

  it('ranks by shared episode strength before lift and breaks ties by earliest evidence', () => {
    const through = ordinals(1, (LINK_CAP + 2) * 60);
    const hub = entity('hub', 'idea', through);
    const dense = entity('dense', 'idea', [1, 2, 3]);
    const leaves = Array.from({ length: LINK_CAP + 1 }, (_, index) => entity(`leaf${index}`, 'idea', [index * 60 + 61, index * 60 + 91]));
    const links = windowLinks(new PassCast([hub, dense, ...leaves]), [unitOf(through)]);

    expect(links).toHaveLength(LINK_CAP);
    expect(links.map(({ b }) => b)).toEqual(leaves.slice(0, LINK_CAP).map(({ key }) => key));
  });

  it('leaves a slot open when the other endpoint is already full', () => {
    let next = 1;
    const scenes = (count: number) => {
      const start = next;
      next += count * 30;
      return Array.from({ length: count }, (_, index) => start + index * 30);
    };
    const aLeaves = Array.from({ length: LINK_CAP }, (_, index) => entity(`leaf-a${index}`, 'idea', scenes(3)));
    const bLeaves = Array.from({ length: LINK_CAP - 1 }, (_, index) => entity(`leaf-b${index}`, 'idea', scenes(3)));
    const blocked = scenes(8);
    const open = [next, next + 1, next + 2];
    const a = entity('a', 'character', [...aLeaves.flatMap((leaf) => leaf.ordinals), ...blocked]);
    const b = entity('b', 'character', [...bLeaves.flatMap((leaf) => leaf.ordinals), ...blocked, ...open]);
    const c = entity('c', 'idea', open);
    const links = windowLinks(new PassCast([a, b, c, ...aLeaves, ...bLeaves]), [unitOf(ordinals(1, next + 2))]);

    expect(links.filter((link) => link.a === 'a')).toHaveLength(LINK_CAP);
    expect(links.filter((link) => link.a === 'b')).toHaveLength(LINK_CAP);
    expect(links).not.toContainEqual(expect.objectContaining({ a: 'a', b: 'b' }));
    expect(links).toContainEqual(expect.objectContaining({ a: 'b', b: 'c' }));
  });

  it('uses the previous co-mention to separate episodes', () => {
    const a = entity('a', 'character', [1, 25, 49, 74]);
    const b = entity('b', 'character', [1, 25, 49, 74]);
    expect(windowLinks(new PassCast([a, b]), [unitOf(ordinals(1, 74))])).toMatchObject([{ count: 2, from: 74 }]);
  });

  it('admits a link at the qualifying unit end, carrying the co-mention window across units in one section', () => {
    const a = entity('a', 'character', [2, 27, 56]);
    const b = entity('b', 'character', [5, 30, 59]);
    const cast = new PassCast([a, b]);
    const first = unitOf(ordinals(1, 2), false);
    const second = { ...unitOf(ordinals(3, 27), false), id: 'u2', index: 1 };
    const third = { ...unitOf(ordinals(28, 32), false), id: 'u3', index: 2 };
    const fourth = { ...unitOf(ordinals(33, 60)), id: 'u4', index: 3 };

    expect(windowLinks(cast, [first, second])).toEqual([]);
    expect(windowLinks(cast, [first, second, third])).toEqual([{ a: 'a', b: 'b', count: 2, score: 1, from: 32, until: null }]);
    expect(windowLinks(cast, [first, second, third, fourth])).toEqual([{ a: 'a', b: 'b', count: 3, score: 1, from: 32, until: null }]);
  });

  it('ties a nonfiction chapter title to its section headings, cited at each section heading', () => {
    const sentences = book(['Chapter: the explosion.', 'Body.', 'Recalcitrance', 'Body.', 'Next chapter.', 'Power heading']);
    for (const ordinal of [1, 3, 5, 6]) sentences[ordinal - 1].heading = true;
    for (const ordinal of [5, 6]) sentences[ordinal - 1].spineIndex = 1;
    const explosion = entity('explosion', 'idea', [1, 2]);
    const recalcitrance = entity('recalcitrance', 'idea', [3]);
    const power = entity('power', 'idea', [6]);
    const cast = new PassCast([explosion, recalcitrance, power]);
    const units = [unitOf([2, 4])];
    expect(headingPairs(cast, sentences, units, 'nonfiction')).toEqual([{ a: explosion, b: recalcitrance, cite: 3 }]);
    expect(headingPairs(cast, sentences, units, 'fiction')).toEqual([]);
    expect(headingPairs(cast, sentences, [unitOf([2])], 'nonfiction')).toEqual([]);
  });

  it('ties a heading that opens straight into sections to each section under it, its first section included, until the next such heading', () => {
    const sentences = book(Array.from({ length: 40 }, (_, index) => `Sentence ${index + 1}.`));
    for (const ordinal of [1, 3, 6, 8, 23, 26]) sentences[ordinal - 1].heading = true;
    const control = entity('control', 'idea', [3]);
    const boxing = entity('boxing', 'idea', [6]);
    const stunting = entity('stunting', 'idea', [8]);
    const motivation = entity('motivation', 'idea', [23]);
    const domesticity = entity('domesticity', 'idea', [26]);
    const cast = new PassCast([control, boxing, stunting, motivation, domesticity]);
    expect(headingPairs(cast, sentences, [unitOf([2, 40])], 'nonfiction')).toEqual([
      { a: control, b: boxing, cite: 6 },
      { a: control, b: stunting, cite: 8 },
      { a: motivation, b: domesticity, cite: 26 },
    ]);
  });

  it('measures distance in body sentences and clears the co-mention window at a section end', () => {
    const a = entity('a', 'character', [2, 56]);
    const b = entity('b', 'character', [8, 58]);
    const first = unitOf(ordinals(1, 28).map((index) => 2 * index));
    const second = { ...unitOf([58]), id: 'u2', index: 1, s: 1 };
    const cast = new PassCast([a, b]);
    expect(windowLinks(cast, [first, second], [{ a, b, cite: 8 }])).toMatchObject([{ count: 1 }]);
    expect(
      windowLinks(cast, [
        { ...first, sectionEnd: false },
        { ...second, s: 0 },
      ]),
    ).toMatchObject([{ count: 2, from: 58 }]);
  });

  it('emits a cited relation without episodes or retroactive alias mentions', () => {
    const a = entity('a', 'character', [1]);
    const b = entity('b', 'character', [5]);
    const alias = entity('alias', 'character', [4]);
    const cast = new PassCast([a, b, alias]);
    cast.merge({ member: alias, head: a, ordinal: 5, rule: 'alias' });
    const units = [unitOf([1, 2, 3]), { ...unitOf([4, 5]), id: 'u2', s: 1 }];
    expect(windowLinks(cast, units, [{ a, b, cite: 4 }])).toEqual([{ a: 'a', b: 'b', count: 0, score: 0, from: 4, until: null }]);
  });
});
