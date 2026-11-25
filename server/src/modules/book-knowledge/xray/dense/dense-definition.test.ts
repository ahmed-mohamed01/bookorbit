import { describe, expect, it } from 'vitest';
import type { Sentence } from '../../core/model';
import { bareLabel, definitionOf, definitionScore, sameText } from './dense-definition';

const book = (texts: string[]): Sentence[] =>
  texts.map((text, index) => ({
    ordinal: index + 1,
    spineIndex: 0,
    paragraphIndex: index,
    href: 'x.xhtml',
    text,
    structure: 'body' as const,
    heading: false,
    emphasis: [],
  }));

describe('definition picker', () => {
  const names = ['Mana Sight', 'Sight'];

  it.each([
    ['[Mana Sight: lets the user see mana flows]', 4],
    ['/Mana Sight (Passive) grants vision of mana', 4],
    ['"Mana Sight - a skill that reveals flows of power."', 4],
    ['Mana Sight is a passive skill that reveals mana.', 3],
    ['The Mana Sight allows a mage to see wards.', 3],
    ['Then your mana sight lets you see through walls.', 3],
    ['She gained the skill: Mana Sight after the fight.', 2],
    ['He unlocked Mana Sight at last.', 2],
    ['She walked the path of the Mana Sight for years.', 2],
    ['He was suffering from a bad case of Mana Sight.', 2],
    ['Her skills: Fireball, Mana Sight, Ward, Dash.', 1],
    ['She used Mana Sight to look around.', 0],
  ])('scores %s', (text, score) => {
    expect(definitionScore(text, names)).toBe(score);
  });

  it('wants three words after a gloss', () => {
    expect(definitionScore('Mana Sight: passive skill', names)).toBe(0);
    expect(definitionScore('Mana Sight: passive skill, rank two', names)).toBe(4);
  });

  it('wants the name as the subject of a definition', () => {
    expect(definitionScore('Viv said Mana Sight is useful.', names)).toBe(0);
  });

  it('wants at least three items in a colon list', () => {
    expect(definitionScore('Her skills: Fireball and Mana Sight.', names)).toBe(0);
  });

  it('takes the strongest sentence, the earliest on a tie', () => {
    const sentences = book([
      'She used Mana Sight.',
      'Her skills: Fireball, Mana Sight, Ward.',
      'Mana Sight is a passive skill.',
      'Mana Sight is a rare gift.',
      'Mana Sight 3/10',
    ]);
    expect(definitionOf([1, 2, 3, 4, 5], sentences, names)).toBe(3);
    expect(definitionOf([1, 2], sentences, names)).toBe(2);
    expect(definitionOf([1, 5], sentences, names)).toBeNull();
  });

  it.each(['Intermediate 7/8', 'Extreme compatibility:', '[Mana Sight 45%]', 'Mana Sight (3/10)'])('rejects the bare label %s', (text) => {
    const own = ['Intermediate', 'Extreme compatibility', 'Mana Sight'];
    expect(bareLabel(text, own)).toBe(true);
    expect(definitionScore(text, own)).toBe(0);
  });

  it('keeps a label with words beside the name', () => {
    expect(bareLabel('Mana Sight improved to 4/10', names)).toBe(false);
    expect(bareLabel('7/8', names)).toBe(false);
  });

  it('compares lines without case, spacing or digits', () => {
    expect(sameText('Fireball  3/10 ')).toBe(sameText('fireball 4/10'));
  });
});
