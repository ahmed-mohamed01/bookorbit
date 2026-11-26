import type { XrayEntity } from '../xray-entities';
import { Logger } from '@nestjs/common';
import { AiError } from '../../../ai/ai-client.types';
import type { BookKnowledgeXrayStepId } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import { limiter, XrayPrivacy, XrayStepRun } from '../xray-runner';
import { stitchNotes, introducing as introducingWith, runDense } from './dense-run';
import type { Rejections } from '../xray-checks';
import { entity } from '../xray-fixtures.testing';
import { namesAt } from '../xray-lines';
import { NARRATOR_ID, namedFirst, PassCast, patternMerges, type PassSlot } from '../pass/pass-cast';
import type { Ask } from '../pass/pass-run';
import type { PassUnit } from '../pass/pass-units';
import { citesIn, denseChunks, numberedText } from './dense-chunks';
import { factsOutputTokens, FACTS_MAX_OUTPUT_TOKENS, notesUser, requiredIds, retryUser } from './dense-prompt';
import { ALIAS_GROUPS_PER_CALL, aliasCandidates, aliasMerges, joinAlias, editDistance, epithetFolds } from './dense-alias';
import { clean, descriptionProblem } from './dense-describe';
import { headingPairs, LINK_CAP, windowLinks } from './dense-links';
import { factsReader, notesReader, sceneReader } from './dense-read';
import { sceneRoster, SceneSame } from './dense-scene';
import { mapTieType } from './dense-tie-map';
import { NarrationDetector } from './dense-narration';
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
    expect(requiredIds(slots)).toEqual(['e1', 'e2']);
    const user = notesUser('[1] text', slots, { about: new Map(), abilities: new Map(), previous: null }, 'fiction');
    expect(user).toContain('Required: e1, e2');
    expect(retryUser(user, ['e2'], [])).toContain('left out these Required ids: e2');
  });

  it.each([
    'Viv is named once, but no action occurs.',
    'Viv is mentioned only in passing.',
    'Viv is not described.',
    'Viv does not appear in this stretch.',
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

  it('rests a relation given without a number on the first sentence naming both sides, and drops it when none does', () => {
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
    expect(read?.items.ties.map((tie) => [tie.a.id, tie.b.id, tie.cite])).toEqual([['e1', 'e2', 1]]);
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

it('skips a facts merge across kinds while applying a same-kind merge', async () => {
  const sentences = book(['Piper is the Cloak.', 'Piper is called Raven.']);
  const cast = [
    entity('e1', 'character', [1, 2], { name: 'Piper' }),
    entity('e2', 'object', [1], { name: 'Cloak' }),
    entity('e3', 'character', [2], { name: 'Raven' }),
  ];
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const privacy = new XrayPrivacy(sentences);
  const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
  const result = await runDense({
    entities: cast,
    sentences,
    units: [unitOf([1, 2])],
    mode: 'fiction',
    ask:
      ({ system, user }) =>
      () =>
        Promise.resolve({
          text: JSON.stringify(
            `${system}${user}`.includes('merges: {"a"')
              ? {
                  merges: [
                    { a: 'e2', b: 'e1', n: [1] },
                    { a: 'e3', b: 'e1', n: [2] },
                  ],
                }
              : { pov: null, notes: {}, summary: null },
          ),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        }),
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
  expect(result.cast.merges.map(({ member, head }) => [member.id, head.id])).toEqual([['e3', 'e1']]);
  expect(result.cast.heads.map(({ id }) => id)).toEqual(['e1', 'e2']);
});

it('heads a model merge with the more-mentioned name, whichever order the model gave', async () => {
  const sentences = book(['Tavia ran.', 'Tavia hid.', 'Tavia, called Princess Pip, laughed.']);
  const cast = [entity('e1', 'character', [1, 2, 3], { name: 'Tavia' }), entity('e2', 'character', [3], { name: 'Pip' })];
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const privacy = new XrayPrivacy(sentences);
  const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', privacy, logger, 'runId=r');
  const result = await runDense({
    entities: cast,
    sentences,
    units: [unitOf([1, 2, 3])],
    mode: 'fiction',
    ask:
      ({ system, user }) =>
      () =>
        Promise.resolve({
          text: JSON.stringify(
            `${system}${user}`.includes('merges: {"a"') ? { merges: [{ a: 'e1', b: 'e2', n: [3] }] } : { pov: null, notes: {}, summary: null },
          ),
          usage: { input: 1, output: 1 },
          finish: 'stop' as const,
          model: 'm',
        }),
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
  expect(result.cast.merges.map(({ member, head }) => [member.id, head.id])).toEqual([['e2', 'e1']]);
});

describe('dense now', () => {
  it('feeds status facts to `now`, not `about`, and drops a now line that starts with the name', async () => {
    const sentences = book(['Viv moved into the watchroom.', 'Viv now serves Fort Stone.', 'Viv is a witch.']);
    const viv = entity('e1', 'character', [1, 2, 3], { name: 'Viv', names: [{ text: 'Viv', ordinal: 1 }] });
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
    const reply = (value: unknown) => () =>
      Promise.resolve({ text: JSON.stringify(value), usage: { input: 1, output: 1 }, finish: 'stop' as const, model: 'm' });
    const run = (now: string) =>
      runDense({
        entities: [viv],
        sentences,
        units: [unitOf([1, 2, 3])],
        mode: 'fiction',
        ask: (request) => {
          if (request.system.includes('now line')) return reply({ now: { e1: now } });
          if (`${request.system}${request.user}`.includes('notes: an object keyed by id')) return reply({ notes: { e1: null }, summary: '' });
          return reply({
            identity: [
              { id: 'e1', fact: 'Viv is a witch.', kind: 'identity', n: [3] },
              { id: 'e1', fact: 'Viv serves Fort Stone.', kind: 'status', n: [2] },
            ],
          });
        },
        askAbout: () => reply({ lines: { viv: 'A witch.' } }),
        ...steps,
        writesAbout: () => true,
      });
    const good = await run('Serves Fort Stone from the watchroom.');
    expect(good.state.currentNow('e1')).toBe('Serves Fort Stone from the watchroom.');
    expect(good.state.factsOf('e1').map((fact) => fact.value.text)).toEqual(['Viv is a witch.']);
    expect(good.state.statusOf('e1').map((fact) => fact.value.text)).toEqual(['Viv serves Fort Stone.']);
    const bad = await run('Viv, a witch, serves Fort Stone.');
    expect(bad.state.currentNow('e1')).toBeNull();
    expect(steps.now.record.rejected).toEqual({ 'now:starts-with-name': 1 });
    const ungrounded = await run('Serves Fort Stone beside Shallan.');
    expect(ungrounded.state.currentNow('e1')).toBeNull();
    expect(steps.now.record.rejected).toEqual({ 'now:starts-with-name': 1, 'now:ungrounded': 1 });
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
    expect(result.state.currentAbout('e3')).toBe('Concept: Reveals nearby sources of magic.');
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
      writesAbout?: (slot: PassSlot) => boolean;
    },
  ) => {
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = (id: BookKnowledgeXrayStepId) => new XrayStepRun(id, 'fast', new XrayPrivacy(sentences), logger, 'runId=r');
    const describe = step('describe');
    const asked: string[] = [];
    const ask: Ask =
      ({ system, user }) =>
      () => {
        let answer: unknown = {};
        if (system.includes(DESCRIBE_KEY)) {
          asked.push(user);
          answer = options.describe?.(user) ?? {};
        } else if (user.includes('notes: an object keyed by id')) answer = options.notes?.(user) ?? { notes: {}, summary: 'Piper walks.' };
        else if (user.includes('"identity":')) answer = options.facts?.(user) ?? {};
        return Promise.resolve({ text: JSON.stringify(answer), usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' });
      };
    const result = await runDense({
      entities,
      units,
      sentences,
      mode: options.mode ?? 'fiction',
      ask,
      askAbout: ask,
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe,
      now: step('now'),
      about: step('about'),
      writesAbout: options.writesAbout ?? (() => false),
    });
    return { result, asked, describe };
  };

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
    expect(result.state.currentAbout('e3')).toBe('Concept: Reveals nearby sources of magic.');
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
    return runDense({ entities, units, sentences, mode: 'fiction', ask, askAbout: ask, ...steps, writesAbout: () => false, ...options });
  };
  return { steps, run };
}

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

  it.each([false, true])('joins the anonymous entry only after earlier first-person votes (blurb hint: %s)', async (hinted) => {
    const sentences = book(
      Array.from({ length: 301 }, (_, index) =>
        index === 0 ? 'I, Viv, turned the key.' : index === 1 ? 'My sister calls me Vee.' : 'I waited by my window.',
      ),
    );
    const viv = entity('v', 'character', [1, 2], {
      name: 'Viv',
      names: [
        { text: 'Viv', ordinal: 1 },
        { text: 'Vee', ordinal: 2 },
      ],
    });
    const ordinals = sentences.map(({ ordinal }) => ordinal);
    const units = [
      { ...unitOf(ordinals.slice(0, 200)), sectionEnd: false },
      { ...unitOf(ordinals.slice(200)), id: 'u2', index: 1 },
    ];
    const seen: { kind: string; user: string; maxOutputTokens: number }[] = [];
    const readDescription = vi.fn(() => Promise.resolve(hinted ? '<p>Vee and UnseenBlurbName face the world.</p>' : null));
    const result = await denseHarness(sentences).run(
      [viv],
      units,
      (kind, user) => {
        const start = Number(user.match(/\[(\d+)\]/)?.[1]);
        if (kind === 'scene') return { pov: 'v' };
        if (kind === 'notes') {
          const id = start === 1 || (!hinted && start === 101) ? 'narrator' : 'v';
          return { notes: { narrator: null, v: null, [id]: { note: 'Waits by the window.', n: [start] } }, summary: 'Someone waits.' };
        }
        return noFacts;
      },
      (kind) => (kind === 'scene' ? 3 : 0),
      seen,
      [],
      { readDescription },
    );
    const last = result.cast.heads[0];
    expect(result.cast.heads).toEqual([last]);
    expect(last).toMatchObject({ name: 'Viv', count: 301, ordinals });
    expect(result.cast.merges).toEqual([expect.objectContaining({ rule: 'narrator', ordinal: hinted ? 100 : 200, head: last })]);
    const notes = seen.filter(({ kind, user }) => kind === 'notes' && !user.includes('Answer only'));
    expect(notes[0].user).toContain('outside dialogue refers to narrator.');
    expect(notes[1].user).toContain(`outside dialogue refers to ${hinted ? 'v' : 'narrator'}.`);
    expect(notes[2].user).toContain('outside dialogue refers to v.');
    expect(notes[2].user).toContain('v | Viv | Vee | character | 101');
    expect(result.state.timeline.get('v')?.at(-1)?.value).toMatchObject({ note: 'Waits by the window.', at: 201 });
    expect(readDescription).toHaveBeenCalledTimes(1);
    expect(seen.some(({ user }) => user.includes('UnseenBlurbName'))).toBe(false);
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
    expect(result.cast.merges).toMatchObject([{ rule: 'narrator', ordinal: 2 }]);
    expect(result.cast.heads).toMatchObject([{ name: 'Viv', count: 2 }]);
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

  it('allows the narrator phrase only in the anonymous entry description and about line', async () => {
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
    expect(result.state.timeline.get('narrator')?.[0].value.note).toBeNull();
  });
});

describe('dense run order and context', () => {
  it('carries a POV through a unit past a failed scene call, and never into the next unit', async () => {
    const texts = Array.from({ length: 301 }, () => 'Piper walked.');
    texts[0] = texts[100] = 'Piper and Fern meet Rowan.';
    const sentences = book(texts);
    const all = Array.from({ length: 301 }, (_, index) => index + 1);
    const entities = [
      entity('e1', 'character', all, { name: 'Piper', importance: 3 }),
      entity('e2', 'character', [1, 101], { name: 'Fern', importance: 3 }),
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
  it('carries windows across units of one section, keeps prior admission times, and uses final counts and scores', () => {
    const cast = new PassCast([entity('a', 'character', [2, 5]), entity('b', 'character', [3, 6]), entity('c', 'place', [6])]);
    const first = unitOf([1, 2, 3], false);
    const second = { ...unitOf([4, 5, 6]), id: 'u2', index: 1 };
    const third = { ...unitOf([7, 8, 9]), id: 'u3', index: 2, s: 1 };
    expect(windowLinks(cast, [first])).toEqual([{ a: 'a', b: 'b', count: 2, score: 1, from: 3, until: null }]);
    const links = windowLinks(cast, [first, second]);
    expect(links).toEqual([
      { a: 'a', b: 'b', count: 5, score: 0.833, from: 3, until: null },
      { a: 'a', b: 'c', count: 5, score: 0.833, from: 6, until: null },
      { a: 'b', b: 'c', count: 6, score: 1, from: 6, until: null },
    ]);
    expect(windowLinks(cast, [first, second, third])).toEqual(links);
  });

  it('caps each ranking and admits a pair promoted by a later section only at that checkpoint', () => {
    const entities = Array.from({ length: LINK_CAP + 2 }, (_, index) =>
      entity(`e${index}`, 'character', index === 0 || index === 16 ? [index + 2, 30] : [index + 2]),
    );
    const first = unitOf(Array.from({ length: 26 }, (_, index) => index + 1));
    const second = { ...unitOf([27, 28, 29, 30]), id: 'u2', s: 1 };
    const cast = new PassCast(entities);
    const before = windowLinks(cast, [first]);
    const after = windowLinks(cast, [first, second]);
    expect(before).toHaveLength((entities.length * (entities.length - 1)) / 2 - 1);
    expect(before.some(({ a, b }) => a === 'e0' && b === 'e16')).toBe(false);
    expect(after.at(-1)).toMatchObject({ a: 'e0', b: 'e16', from: 30, count: 6 });
    const admission = ({ a, b, from }: (typeof before)[number]) => [a, b, from];
    expect(after.filter(({ from }) => from < 27).map(admission)).toEqual(before.map(admission));
  });

  it('keeps a pair that busier hub partners push out of both raw rankings', () => {
    const hubs = Array.from({ length: LINK_CAP + 1 }, (_, index) =>
      entity(`h${index}`, 'idea', Array.from({ length: 20 }, (_, at) => at + 1).concat(Array.from({ length: 10 }, (_, at) => at + 21))),
    );
    const a = entity(
      'za',
      'idea',
      Array.from({ length: 10 }, (_, at) => at + 21),
    );
    const b = entity('zb', 'idea', [26, 27, 28, 29, 30]);
    const units = [
      unitOf(Array.from({ length: 20 }, (_, at) => at + 1)),
      { ...unitOf(Array.from({ length: 10 }, (_, at) => at + 21)), id: 'u2', s: 1 },
    ];
    const links = windowLinks(new PassCast([...hubs, a, b]), units);
    expect(links.some((link) => link.a === 'za' && link.b === 'zb')).toBe(true);
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

  it('uses 25 body sentences, irrespective of the original ordinal gaps', () => {
    const a = entity('a', 'character', [12]);
    const b = entity('b', 'character', [58]);
    const c = entity('c', 'character', [62]);
    const unit = unitOf(Array.from({ length: 31 }, (_, index) => 2 * (index + 1)));
    const links = windowLinks(new PassCast([a, b, c]), [unit]);
    expect(links.find((link) => link.a === 'a' && link.b === 'b')).toMatchObject({ count: 2, from: 62 });
    expect(links.some((link) => link.a === 'a' && link.b === 'c')).toBe(false);
  });

  it('emits a cited relation with zero windows and never crosses a section or counts a member before its join', () => {
    const a = entity('a', 'character', [1]);
    const b = entity('b', 'character', [5]);
    const alias = entity('alias', 'character', [4]);
    const cast = new PassCast([a, b, alias]);
    cast.merge({ member: alias, head: a, ordinal: 5, rule: 'alias' });
    const units = [unitOf([1, 2, 3]), { ...unitOf([4, 5]), id: 'u2', s: 1 }];
    expect(windowLinks(cast, units, [{ a, b, cite: 4 }])).toEqual([{ a: 'a', b: 'b', count: 0, score: 0, from: 4, until: null }]);
  });
});
