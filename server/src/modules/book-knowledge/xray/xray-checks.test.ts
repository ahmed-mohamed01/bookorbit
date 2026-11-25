import { guessesGender } from './xray-checks';

describe('round 4 checks', () => {
  it('flags a gender no source sentence gives', () => {
    expect(guessesGender('She is a medic.', ['Viv packed the bag.'])).toBe(true);
    expect(guessesGender('She is a medic.', ['Viv packed her bag.'])).toBe(false);
    expect(guessesGender('A medic.', ['Viv packed the bag.'])).toBe(false);
  });
});
