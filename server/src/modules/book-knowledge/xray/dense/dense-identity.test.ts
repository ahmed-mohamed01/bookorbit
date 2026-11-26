import type { StoryGuideEntityKind } from '@bookorbit/types';
import type { Sentence } from '../../core/model';
import { PassCast } from '../pass/pass-cast';
import { PassState } from '../pass/pass-state';
import type { PassUnit } from '../pass/pass-units';
import type { XrayEntity } from '../xray-entities';
import { entity } from '../xray-fixtures.testing';
import { aliasCandidates, epithetFolds, joinAlias } from './dense-alias';
import { identityEvidence, identityMerges } from './dense-identity';
import { addKinTies } from './dense-run';
import { SceneSame } from './dense-scene';

const sentences = (texts: string[]): Sentence[] =>
  texts.map((text, index) => ({
    text,
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: index,
    href: 'a.xhtml',
    structure: 'body',
    heading: false,
    emphasis: [],
  }));

const named = (name: string, kind: StoryGuideEntityKind, ordinals: number[], extra: Partial<XrayEntity> = {}) =>
  entity(name.toLowerCase().replace(/\W+/g, '-'), kind, ordinals, { name, names: [{ text: name, ordinal: ordinals[0] }], ...extra });

describe('identity evidence', () => {
  it('joins a pair a vocative shows twice, and keeps a single sentence for the alias ask', () => {
    const text = sentences(['"Yes, Captain," Ash told Viv.', '"Now, Captain," Ash told Viv.', '"Wait, Captain," Ash told Viv.']);
    const viv = named('Viv', 'character', [1, 2, 3, 4, 5]);
    const captain = named('Captain', 'character', [1, 2]);
    const ash = named('Ash', 'character', [1, 2, 3]);
    const { merges, single } = identityMerges(new PassCast([viv, captain, ash]), text);
    expect(merges.map(({ member, head, reason, ordinal }) => [member.name, head.name, reason, ordinal])).toEqual([
      ['Captain', 'Viv', 'vocative@1,2', 1],
    ]);
    expect(single).toEqual([]);

    const once = identityMerges(new PassCast([viv, named('Captain', 'character', [1]), ash]), text);
    expect(once.merges).toEqual([]);
    expect(once.single.map(({ rule, ordinal }) => [rule, ordinal])).toEqual([['vocative', 1]]);
  });

  it('reads an apposition, a title and a naming', () => {
    const viv = named('Viv', 'character', [1, 2, 3]);
    const medic = named('medic', 'character', [1]);
    const bob = named('Bob', 'character', [2, 3]);
    const princess = named('Princess', 'character', [2]);
    const robert = named('Robert', 'character', [3]);
    const found = identityEvidence(
      [viv, medic, bob, princess, robert],
      sentences(['Viv, the medic, waved.', 'Princess Bob sat down.', 'Bob, or Robert as his mother said, left.']),
    );
    expect(found.map(({ a, b, rule }) => [a.name, b.name, rule])).toEqual(
      expect.arrayContaining([
        ['Viv', 'medic', 'apposition'],
        ['Bob', 'Princess', 'title'],
        ['Bob', 'Robert', 'naming'],
      ]),
    );
  });

  it('gives no evidence for a descriptor beside two names or for a stop-listed noun', () => {
    const viv = named('Viv', 'character', [1, 3]);
    const pell = named('Pell', 'character', [2]);
    const medic = named('medic', 'character', [1, 2]);
    const golem = named('golem', 'character', [3]);
    const found = identityEvidence(
      [viv, pell, medic, golem],
      sentences(['Viv, the medic, waved.', 'Pell, the medic, waved.', 'Viv, the golem, waved.']),
    );
    expect(found).toEqual([]);
    const princess = named('Princess', 'character', [1, 2]);
    const titled = identityEvidence([viv, pell, princess], sentences(['Princess Viv sat.', 'Princess Pell sat.']));
    expect(titled).toEqual([]);
  });

  it('reads a status screen name beside exactly one other character', () => {
    const viv = named('Viv', 'character', [1]);
    const robert = named('Robert', 'character', [1]);
    const found = identityEvidence([viv, robert], sentences(['[Name: Robert] Viv stared at the screen.']));
    expect(found.map(({ a, b, rule }) => [a.name, b.name, rule])).toEqual([['Robert', 'Viv', 'screen']]);
    const crowded = named('Pell', 'character', [1]);
    expect(identityEvidence([viv, robert, crowded], sentences(['[Name: Robert] Viv and Pell stared.']))).toEqual([]);
  });

  it('reads a title only from a title word before a character', () => {
    const bob = named('Bob', 'character', [1, 2, 3]);
    const bright = named('Bright', 'character', [1]);
    const princess = named('Princess', 'character', [2, 3]);
    const glade = named('Glade', 'place', [3]);
    const found = identityEvidence([bob, bright, princess, glade], sentences(['Bright Bob sat.', 'Princess Bob sat.', 'Princess Glade lay quiet.']));
    expect(found.map(({ a, b, rule, ordinal }) => [a.name, b.name, rule, ordinal])).toEqual([['Bob', 'Princess', 'title', 2]]);
  });

  it('reads a naming up to four words past ", or", and "called" only as a name given', () => {
    const viv = named('Viv', 'character', [1, 2, 3, 4, 5]);
    const bob = named('Princess Bob', 'character', [1, 2, 3, 4, 5]);
    const found = identityEvidence(
      [viv, bob],
      sentences([
        'Viv, or the newly minted Princess Bob, waved.',
        'Viv, or one of the many people near Princess Bob, waved.',
        'Viv called Princess Bob over.',
        'Viv was called Princess Bob by the guards.',
        'Viv called herself Princess Bob.',
      ]),
    );
    expect(found.map(({ rule, ordinal }) => [rule, ordinal])).toEqual([
      ['naming', 1],
      ['naming', 4],
      ['naming', 5],
    ]);
  });

  it('sends a single title sentence to no ask, but a single naming sentence to the alias ask', () => {
    const bob = named('Bob', 'character', [1, 2]);
    const princess = named('Princess', 'character', [1]);
    expect(identityMerges(new PassCast([bob, princess]), sentences(['Princess Bob sat.', 'Bob left.'])).single).toEqual([]);
    const robert = named('Robert', 'character', [1]);
    const once = identityMerges(new PassCast([bob, robert]), sentences(['Bob, or Robert as his mother said, left.', 'Bob left.']));
    expect(once.single.map(({ rule }) => rule)).toEqual(['naming']);
  });

  it('offers a single-evidence pair to the alias ask even across kinds', () => {
    const viv = named('Viv', 'character', [1, 2]);
    const captain = named('Captain', 'idea', [1]);
    const cast = new PassCast([viv, captain]);
    const candidates = aliasCandidates(cast, sentences(['Captain.', 'Viv.']), 'fiction', [{ a: captain, b: viv, rule: 'vocative', ordinal: 1 }]);
    expect(candidates.map(({ member, head, reason }) => [member.name, head.name, reason])).toEqual([['Captain', 'Viv', 'evidence']]);
  });
});

describe('epithet folds', () => {
  const text = sentences(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const viv = named('Viv', 'character', [1, 2, 3]);
  const pell = named('Pell', 'character', [5, 6]);
  const town = named('Town', 'place', [7, 8]);

  it('folds a lowercase epithet into its one named match of the same kind', () => {
    const dragonette = named('dragonette', 'character', [1, 2]);
    const folds = epithetFolds(new PassCast([viv, pell, town, dragonette]), text);
    expect(folds.map(({ member, head, ordinal }) => [member.name, head.name, ordinal])).toEqual([['dragonette', 'Viv', 1]]);
    expect(epithetFolds(new PassCast([viv, pell, town, dragonette]), text, 'nonfiction')).toEqual([]);
  });

  it('leaves an epithet with two matches, a stop-listed noun and a possession to the alias ask', () => {
    const fern = named('Fern', 'character', [1, 2]);
    expect(epithetFolds(new PassCast([viv, fern, pell, town, named('dragonette', 'character', [1, 2])]), text)).toEqual([]);
    expect(epithetFolds(new PassCast([viv, pell, town, named('golem', 'character', [1, 2])]), text)).toEqual([]);
    const owned = sentences(['Her dragonette slept.', 'Her dragonette woke.', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(epithetFolds(new PassCast([viv, pell, town, named('dragonette', 'character', [1, 2])]), owned)).toEqual([]);
  });
});

describe('kin ties', () => {
  const unit: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: [1, 2, 3], sectionEnd: true };

  it('ties a named character’s relative to them, the parent first', () => {
    const viv = named('Viv', 'character', [1, 2]);
    const mother = named('Viv’s mother', 'character', [2]);
    const daughter = named('Viv’s daughter', 'character', [3]);
    const state = new PassState();
    expect(addKinTies(new PassCast([viv, mother, daughter]), state, [unit])).toBe(2);
    expect(state.ties.map(({ value }) => [value.a.head.name, value.type, value.b.head.name])).toEqual([
      ['Viv’s mother', 'parent_of', 'Viv'],
      ['Viv', 'parent_of', 'Viv’s daughter'],
    ]);
  });

  it('ties a relative under the name she has where she is first named, not the one a later merge gives her', () => {
    const mother = named('Viv’s mother', 'character', [1]);
    const viv = named('Viv', 'character', [1, 2]);
    const selene = named('Selene', 'character', [5]);
    const cast = new PassCast([mother, viv, selene]);
    cast.merge({ member: mother, head: selene, ordinal: 5, rule: 'model' });
    const state = new PassState();
    const units: PassUnit[] = [unit, { id: 'u2', index: 1, s: 1, ordinals: [4, 5], sectionEnd: true }];
    expect(addKinTies(cast, state, units)).toBe(1);
    expect(state.ties.map(({ unit, value }) => [value.a.head.name, value.type, value.b.head.name, value.cite, unit.id])).toEqual([
      ['Viv’s mother', 'parent_of', 'Viv', 1, 'u1'],
    ]);
  });

  it('adds nothing for an unknown owner, a non-character owner or an unknown kin word', () => {
    const town = named('Town', 'place', [1]);
    const cast = new PassCast([
      town,
      named('Town’s mother', 'character', [2]),
      named('Ash’s mother', 'character', [2]),
      named('Town’s keeper', 'character', [3]),
    ]);
    const state = new PassState();
    expect(addKinTies(cast, state, [unit])).toBe(0);
    expect(state.ties).toEqual([]);
  });
});

describe('named heads', () => {
  const busy = Array.from({ length: 30 }, (_, index) => index + 1);

  it('heads an identity merge with the capitalised character, whatever the counts', () => {
    const viv = named('Viv', 'character', [1, 2]);
    const medic = named('medic', 'character', busy);
    const { merges } = identityMerges(new PassCast([viv, medic]), sentences(['Viv, the medic, waved.', 'Viv, the medic, left.']));
    expect(merges.map(({ member, head }) => [member.name, head.name])).toEqual([['medic', 'Viv']]);
  });

  it('keeps the busier head when both or neither are capitalised characters', () => {
    const viv = named('Viv', 'character', [1, 2]);
    const captain = named('Captain', 'character', busy);
    const ash = named('Ash', 'character', [1, 2]);
    const text = sentences(['"Yes, Viv," Ash told Captain.', '"Now, Viv," Ash told Captain.']);
    expect(identityMerges(new PassCast([viv, captain, ash]), text).merges.map(({ member, head }) => [member.name, head.name])).toEqual([
      ['Viv', 'Captain'],
    ]);
    const cast = new PassCast([named('the guard', 'character', [1]), named('the sentry', 'character', busy)]);
    cast.merge({ member: cast.heads[0], head: cast.heads[1], ordinal: 1, rule: 'alias' });
    expect(cast.heads.map((head) => head.name)).toEqual(['the sentry']);
  });

  it('never makes a capitalised character a member of a lowercase or non-character head, and the merged kind is character', () => {
    const bob = named('Bob', 'character', [2, 3]);
    const titled = named('Princess Bob', 'idea', busy);
    const cast = new PassCast([bob, titled]);
    expect(cast.merge({ member: bob, head: titled, ordinal: 2, rule: 'model' })).toBe(true);
    expect(cast.heads).toEqual([bob]);
    expect(cast.headOf(titled)).toBe(bob);
    expect(cast.heads[0].kind).toBe('character');
    expect(cast.merges[0]).toMatchObject({ member: titled, head: bob });
  });

  it('heads an alias merge and a scene merge with the capitalised character', () => {
    const viv = named('Viv', 'character', [1, 2]);
    const medic = named('medic', 'character', busy);
    const cast = new PassCast([viv, medic]);
    joinAlias(cast, { member: viv, head: medic, ordinal: 2, reason: 'evidence' });
    expect(cast.heads).toEqual([viv]);

    const pell = named('Pell', 'character', [1, 2]);
    const stranger = named('stranger', 'character', busy);
    const scene = new PassCast([pell, stranger]);
    const unit: PassUnit = { id: 'u1', index: 0, s: 0, ordinals: busy, sectionEnd: true };
    const [a, b] = scene.slots(unit);
    const same = new SceneSame();
    const said = sentences(['Pell was the stranger.', 'The stranger is Pell.']);
    same.apply(scene, { ...unit, ordinals: [1] }, [{ a, b, cite: 1 }], said);
    expect(same.apply(scene, { ...unit, ordinals: [2] }, [{ a, b, cite: 2 }], said)).toEqual({ 'scene:same-merge': 1 });
    expect(scene.heads).toEqual([pell]);
  });
});
