import { Logger } from '@nestjs/common';
import type { Sentence } from '../../core/model';
import type { Rejections } from '../xray-checks';
import { entity } from '../xray-fixtures.testing';
import { namesAt } from '../xray-lines';
import { XrayPrivacy, XrayStepRun } from '../xray-runner';
import { PassCast, type PassSlot } from '../pass/pass-cast';
import { ABOUT_REFRESH_FACTS, writeAbout, type Ask } from '../pass/pass-run';
import { PassState } from '../pass/pass-state';
import { passUnits, type PassUnit } from '../pass/pass-units';
import { aliasCandidates, epithetFolds, joinAlias } from './dense-alias';
import { denseChunks } from './dense-chunks';
import { identityEvidence } from './dense-identity';
import { factsReader, notesReader, sceneReader, NO_ACTOR } from './dense-read';
import { SceneSame } from './dense-scene';

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
const unitOf = (ordinals: number[]): PassUnit => ({ id: 'u1', index: 0, s: 0, ordinals, sectionEnd: true });
const person = (id: string, name: string, ordinals: number[], count = ordinals.length) =>
  entity(id, 'character', ordinals, { name, count, names: [{ text: name, ordinal: ordinals[0] }] });
const reader = (sentences: Sentence[], cast: PassCast, unit: PassUnit, entities = cast.heads) => {
  const slots = cast.slots(unit);
  return { chunk: unit, slots, sentences, mode: 'fiction' as const, names: namesAt(entities, unit.ordinals.at(-1)!) };
};

describe('alias joins wait for the name the evidence uses', () => {
  it('joins a candidate to a head at the join of the member its cited sentence names', () => {
    const sentences = book(Array.from({ length: 10 }, (_, index) => `Line ${index + 1}.`));
    const varn = person('v', 'Varn', [9, 10]);
    const stranger = person('s', 'the stranger', [2, 9]);
    const hooded = person('h', 'the hooded man', [2, 3]);
    const cast = new PassCast([varn, stranger, hooded]);
    cast.merge({ member: stranger, head: varn, ordinal: 9, rule: 'alias' });
    joinAlias(cast, { member: hooded, head: varn, ordinal: 2, reason: 'token', evidence: { cite: 2, shown: [2, 3, 9] } });
    expect(cast.merges.at(-1)).toMatchObject({ member: hooded, head: varn, ordinal: 9 });
    expect(cast.headOf(hooded, 5)).toBe(hooded);
    expect(sentences).toHaveLength(10);
  });

  it('never offers two full names that share a surname, even after the bare surname joins one', () => {
    const sentences = book(['John Marsh came.', 'Marsh sat.', 'Tavia Marsh left.', 'Tavia Marsh ran.']);
    const john = person('j', 'John Marsh', [1], 5);
    const marsh = person('m', 'Marsh', [2], 1);
    const tavia = person('t', 'Tavia Marsh', [3, 4]);
    const cast = new PassCast([john, marsh, tavia]);
    cast.merge({ member: marsh, head: john, ordinal: 2, rule: 'full-name' });
    expect(aliasCandidates(cast, sentences)).toEqual([]);
  });

  it('offers a one-word short form that pattern merges left apart to the alias ask', () => {
    const sentences = book(['Rob ran.', 'Robert ran.']);
    const cast = new PassCast([person('rob', 'Rob', [1]), person('robert', 'Robert', [2])]);
    expect(aliasCandidates(cast, sentences).map((candidate) => candidate.reason)).toEqual(['token']);
  });

  it('keeps sentence evidence and misspellings within the candidate cap before busier token pairs', () => {
    const word = (index: number) => `K${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}x`;
    const heads = Array.from({ length: 160 }, (_, index) => [
      person(`f${index}`, `${word(index)} Brand`, [index * 2 + 1], 12),
      person(`p${index}`, word(index), [index * 2 + 2], 11),
    ]).flat();
    const niyl = person('niyl', 'Niyl', [400], 30);
    const nyil = person('nyil', 'Nyil', [401], 2);
    const sentences = book(Array.from({ length: 401 }, (_, index) => `Line ${index + 1}.`));
    const found = aliasCandidates(new PassCast([...heads, niyl, nyil]), sentences);
    expect(found).toHaveLength(150);
    expect(found[0]).toMatchObject({ member: nyil, reason: 'spelling' });
  });
});

describe('epithet folds', () => {
  // Thirty paragraphs of other names, so Varn sits in a small share of the book and the epithet's lift over chance is real.
  const withFiller = (texts: string[]) => {
    const sentences = book([...texts, ...Array.from({ length: 30 }, (_, index) => `Others talk ${index}.`)]);
    const filler = person(
      'x',
      'Others',
      Array.from({ length: 30 }, (_, index) => texts.length + index + 1),
    );
    return { sentences, filler };
  };

  it('folds a mystery epithet after its last lone run, not at an early shared paragraph', () => {
    const texts = ['Varn wondered about the assassin.', 'The assassin struck.', 'The assassin fled.', 'The assassin hid.'];
    for (let index = 0; index < 8; index++) texts.push(`Varn, the assassin, waited ${index}.`);
    const { sentences, filler } = withFiller(texts);
    const varn = person('v', 'Varn', [1, 5, 6, 7, 8, 9, 10, 11, 12], 40);
    const assassin = entity('a', 'character', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { name: 'assassin' });
    const folds = epithetFolds(new PassCast([varn, assassin, filler]), sentences);
    expect(folds.map((fold) => [fold.member.id, fold.head.id, fold.ordinal])).toEqual([['a', 'v', 6]]);
  });

  it('folds at a sentence that says the two are one when the text has one', () => {
    const { sentences, filler } = withFiller([
      'Varn wondered about the assassin.',
      'The assassin struck.',
      'Varn, the assassin, smiled.',
      'Varn and the assassin left.',
    ]);
    const varn = person('v', 'Varn', [1, 3, 4], 40);
    const assassin = entity('a', 'character', [1, 2, 3, 4], { name: 'assassin' });
    const cast = new PassCast([varn, assassin, filler]);
    expect(epithetFolds(cast, sentences)[0]?.ordinal).toBe(1);
    expect(epithetFolds(cast, sentences, 'fiction', [{ a: varn, b: assassin, rule: 'apposition', ordinal: 3 }])[0]?.ordinal).toBe(3);
  });
});

describe('scene and facts votes on a member', () => {
  it("joins a member slot no earlier than the member's own join", () => {
    const sentences = book(['Pip is Tavia.', 'Tavia waits.', 'Pip, called Tavia, ran.', 'Line.', 'Line.', 'Tavia is Wren.']);
    const wren = person('w', 'Wren', [6]);
    const tavia = person('t', 'Tavia', [1, 2, 3, 6]);
    const pip = person('p', 'Pip', [1, 3]);
    const cast = new PassCast([wren, tavia, pip]);
    cast.merge({ member: tavia, head: wren, ordinal: 6, rule: 'alias' });
    const slot = (owner: typeof tavia, head = owner): PassSlot => ({
      id: owner.id,
      head,
      member: owner === head ? null : owner,
      name: owner.name,
      aliases: [],
      kind: 'character',
      mentions: 1,
    });
    const same = new SceneSame();
    same.apply(cast, unitOf([1, 2]), [{ a: slot(pip), b: slot(tavia, wren), cite: 1 }], sentences, 'merges');
    const counts = same.apply(cast, unitOf([3, 4]), [{ a: slot(pip), b: slot(tavia, wren), cite: 3 }], sentences, 'merges');
    expect(counts).toEqual({ 'merges:same-merge': 1 });
    expect(cast.merges.at(-1)?.ordinal).toBe(6);
    expect(cast.headOf(pip, 5)).not.toBe(cast.headOf(wren, 5));
    expect(cast.headOf(pip, 6)).toBe(cast.headOf(wren, 6));
  });
});

describe('dense readers', () => {
  it("shows a tie's label from the latest sentence cited for it", () => {
    const sentences = book(['Iona and Pell crossed the bridge.', 'Rain fell.', 'Pell was her father, Iona knew.']);
    const cast = new PassCast([person('i', 'Iona', [1, 3]), person('p', 'Pell', [1, 3])]);
    const input = reader(sentences, cast, unitOf([1, 2, 3]));
    const read = sceneReader(
      input,
      {},
    )({ pov: null, relations: [{ a: 'p', type: 'parent_of', b: 'i', sentence: 'Pell is the father of Iona.', n: [1, 3] }] });
    expect(read?.items.ties.map((tie) => tie.cite)).toEqual([3]);
    expect(read?.items.linkPairs.map((pair) => pair.cite)).toEqual([1]);
  });

  it('reads a retried fact under the id it was shown as ("e1#2") and a note keyed by name', () => {
    const sentences = book(['Tavia is a ferrywoman.', 'Tavia rows across.']);
    const cast = new PassCast([person('e1', 'Tavia', [1, 2])]);
    const input = reader(sentences, cast, unitOf([1, 2]));
    const facts = factsReader(input, {})({ identity: [{ id: 'e1#2', fact: 'Tavia rows the ferry.', n: [2] }] });
    expect(facts?.items.facts.map((fact) => fact.slot.id)).toEqual(['e1']);
    const notes = notesReader(input, {})({ notes: { Tavia: { note: 'Tavia rows across.', n: [2] } }, summary: 'Tavia rows.' });
    expect(notes?.items.notes.map((note) => note.slot.id)).toEqual(['e1']);
  });

  it("accepts a thing's note led by a character of the unit who has no line in the chunk", () => {
    const sentences = book(['Tavia found a key.', 'She hid the ember key.']);
    const tavia = person('t', 'Tavia', [1]);
    const key = entity('k', 'object', [2], { name: 'ember key' });
    const cast = new PassCast([tavia, key]);
    const chunk = unitOf([2]);
    const input = { ...reader(sentences, cast, chunk, [tavia, key]), unitCast: cast.slots(unitOf([1, 2])) };
    const rejected: Rejections = {};
    const answer = { notes: { k: { note: 'Tavia hides the ember key.', n: [2] } }, summary: 'A key is hidden.' };
    expect(notesReader(input, rejected)(answer)?.items.notes.map((note) => note.slot.id)).toEqual(['k']);
    const narrow = notesReader({ ...input, unitCast: undefined }, rejected)(answer);
    expect(narrow?.items.failed.map((item) => item.detail)).toEqual([NO_ACTOR]);
  });

  it('lets a note name a regnal numeral but not say I', () => {
    const sentences = book(['Tavia crowned Henry.', 'I watched.']);
    const cast = new PassCast([person('t', 'Tavia', [1])]);
    const input = reader(sentences, cast, unitOf([1, 2]));
    const read = notesReader(input, {})({ notes: { t: { note: 'Tavia crowns Henry I.', n: [1] } }, summary: 'A crowning.' });
    expect(read?.items.notes).toHaveLength(1);
    const first = notesReader(input, {})({ notes: { t: { note: 'I watch Tavia crown him.', n: [1] } }, summary: 'A crowning.' });
    expect(first?.items.failed).toHaveLength(1);
  });
});

describe('identity evidence', () => {
  it('reads a short form in brackets after its name as one referent', () => {
    const sentences = book(['The ship crossed the Petrova line (PL) at dawn.']);
    const line = entity('line', 'idea', [1], { name: 'Petrova line', names: [{ text: 'Petrova line', ordinal: 1 }] });
    const short = entity('pl', 'idea', [1], { name: 'PL', names: [{ text: 'PL', ordinal: 1 }] });
    expect(identityEvidence([line, short], sentences)).toEqual([{ a: short, b: line, rule: 'abbreviation', ordinal: 1 }]);
  });
});

describe('text with no paragraph breaks', () => {
  it('cuts chunks and units between sentences instead of keeping one whole section', () => {
    const sentences = book(
      Array.from({ length: 1000 }, (_, index) => `Sentence number ${index} of the wall of text.`),
      () => 0,
    );
    const ordinals = sentences.map(({ ordinal }) => ordinal);
    const chunks = denseChunks(sentences, unitOf(ordinals));
    expect(Math.max(...chunks.map((chunk) => chunk.ordinals.length))).toBeLessThanOrEqual(200);
    expect(chunks.flatMap((chunk) => chunk.ordinals)).toEqual(ordinals);
    const units = passUnits(sentences, [{ s: 0, ordinals } as never], 5000);
    expect(units.length).toBeGreaterThan(1);
  });
});

describe('pass state', () => {
  it('lists only the abilities a prompt names and keeps no snapshot for a gain already held', () => {
    const cast = new PassCast([person('t', 'Tavia', [1])]);
    const [slot] = cast.slots(unitOf([1]));
    const state = new PassState();
    const base = { notes: [], facts: [], ties: [], merges: [], summary: null, failed: [] };
    const gain = (name: string, cite: number) => ({ slot, change: 'gained' as const, group: 'skill' as const, name, detail: null, cite });
    state.apply(unitOf([1]), [slot], { ...base, abilities: [gain('Mend', 1), gain('Rally', 1)] });
    state.apply({ ...unitOf([2]), id: 'u2' }, [slot], { ...base, abilities: [gain('Mend', 2)] });
    expect(state.abilities.get('t')).toHaveLength(1);
    expect(state.abilitiesText('t', Infinity, 'She chose to mend the sail.')).toBe('Mend (skill); 1 more not named here');
  });
});

describe('about refresh back-off', () => {
  it('asks a lead with many facts again only once the new facts match the old', async () => {
    const tavia = person('t', 'Tavia', [1, 2, 3]);
    const cast = new PassCast([tavia]);
    const units = [1, 2, 3].map((ordinal, index) => ({ ...unitOf([ordinal]), id: `u${ordinal}`, index }));
    const [slot] = cast.slots(units[2]);
    const state = new PassState();
    state.slots.set(slot.id, slot);
    state.setAbout(slot.id, units[0], 'A ferrywoman of the river.');
    const fact = (unit: PassUnit, index: number) =>
      state.facts.set('t', [...(state.facts.get('t') ?? []), { unit, value: { slot, text: `Fact ${index}.`, cite: unit.ordinals[0] } }]);
    for (let index = 0; index < 10; index++) fact(units[0], index);
    for (let index = 0; index < ABOUT_REFRESH_FACTS + 1; index++) fact(units[2], 100 + index);
    const logger = new Logger('test');
    vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    const step = new XrayStepRun('about', 'fast', new XrayPrivacy([]), logger, 'runId=r');
    const ask = vi.fn<Ask>(() => () => Promise.resolve({ text: '{}', usage: { input: 1, output: 1 }, finish: 'stop', model: 'm' }));
    await writeAbout([slot], units[2], state, namesAt([tavia], 3), 'fiction', ask, step);
    expect(ask).not.toHaveBeenCalled();
  });
});
