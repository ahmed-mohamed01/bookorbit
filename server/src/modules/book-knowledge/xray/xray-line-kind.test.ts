import { describe, expect, it } from 'vitest';
import { checkedSub, correctedKind, descriptorOf, kindFromLine } from './xray-line-kind';

describe('kind from a description line', () => {
  it('reads the opening noun', () => {
    expect(kindFromLine('A people at war with the river clans, led by Orrin.')).toBe('group');
    expect(kindFromLine('The language of the drowned kingdom, spoken by Tavia.')).toBe('idea');
    expect(kindFromLine('A path open to Tavia that strengthens her ember spells.')).toBe('idea');
    expect(kindFromLine('A muddy border town where the river clans trade.')).toBe('place');
    expect(kindFromLine('A location Orrin names when he warns off strangers.')).toBe('place');
    expect(kindFromLine('A place whose service Orrin enters as a guard.')).toBe('place');
    expect(kindFromLine('A knight of the Ember Order who guards Tavia.')).toBe('character');
  });

  it('leaves unknown heads alone', () => {
    expect(kindFromLine('A Mavro shieldmaiden who left her tribe.')).toBeNull();
    expect(kindFromLine('Dried feathers scattered across the floor.')).toBeNull();
    expect(kindFromLine('A large circular landmass linked to its neighbour.')).toBeNull();
  });

  it('corrects only misfiled persons, places and groups', () => {
    expect(correctedKind('character', 'A people at war with the river clans.')).toBe('group');
    expect(correctedKind('character', 'A path open to Tavia.')).toBe('idea');
    expect(correctedKind('place', 'The language of the drowned kingdom.')).toBe('idea');
    expect(correctedKind('object', 'A path open to Tavia.')).toBe('object');
    expect(correctedKind('character', 'A Mavro shieldmaiden.')).toBe('character');
    expect(correctedKind('place', null)).toBe('place');
  });
});

describe('descriptor entries', () => {
  it('names the character a word stands for', () => {
    expect(descriptorOf('Orrin is a skyling.', ['skyling'])).toBe('Orrin');
    expect(descriptorOf('Orrin is a baby skyling', ['skylings'])).toBe('Orrin');
    expect(descriptorOf('Tavia Pell is the warden.', ['warden'])).toBe('Tavia Pell');
  });

  it('ignores real descriptions', () => {
    expect(descriptorOf('A young skyling Orrin found in the hills.', ['skyling'])).toBeNull();
    expect(descriptorOf('Orrin is a skyling who guards the mill.', ['skyling'])).toBeNull();
    expect(descriptorOf('Orrin is a warden.', ['skyling'])).toBeNull();
    expect(descriptorOf(null, ['skyling'])).toBeNull();
  });
});

describe('god and spirit subtypes', () => {
  it('keeps them only when the description says so', () => {
    expect(checkedSub('spirit', 'character', 'A river spirit bound to the old mill.')).toBe('spirit');
    expect(checkedSub('spirit', 'character', 'A Mavro shieldmaiden seeking work.')).toBeNull();
    expect(checkedSub('god', 'character', 'The goddess of tides whom Tavia prays to.')).toBe('god');
    expect(checkedSub('spirit', 'group', 'A species of river spirits.')).toBeNull();
    expect(checkedSub('spirit', 'character', null)).toBeNull();
    expect(checkedSub('animal', 'character', 'A grey mare.')).toBe('animal');
    expect(kindFromLine('A species facing hardship, represented by Orrin.')).toBe('group');
  });
});
