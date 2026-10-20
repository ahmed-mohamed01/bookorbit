import { describe, expect, it } from 'vitest';

import { authorsContradict, authorsMatch, baseSeriesDisplayTitle, baseSeriesTitle, releaseNamesSeries } from '@bookorbit/types';
import { fixApostropheCase } from './web-serials-title.utils';

describe('fixApostropheCase', () => {
  it('lowercases the letter after an apostrophe that ends the word', () => {
    expect(fixApostropheCase("Frieren: Beyond Journey'S End")).toBe("Frieren: Beyond Journey's End");
    expect(fixApostropheCase("Don'T Stop")).toBe("Don't Stop");
    expect(fixApostropheCase('Journey’S End')).toBe('Journey’s End');
    expect(fixApostropheCase("They'Re Here")).toBe("They're Here");
  });

  it('keeps capitals the source wrote inside a word and does not invent any', () => {
    expect(fixApostropheCase("O'Brien's Law")).toBe("O'Brien's Law");
    expect(fixApostropheCase("D'Artagnan")).toBe("D'Artagnan");
    expect(fixApostropheCase("don't stop")).toBe("don't stop");
    expect(fixApostropheCase("Journey's End")).toBe("Journey's End");
  });

  it('leaves all-caps titles alone', () => {
    expect(fixApostropheCase("DON'T STOP")).toBe("DON'T STOP");
  });
});

describe('baseSeriesTitle', () => {
  it.each([
    ['The Water Magician: The Central Provinces Arc', 'water magician'],
    ['The Water Magician: The Western Provinces Arc', 'water magician'],
    ['The Water Magician: The Eastern Provinces Arc', 'water magician'],
    ['Water Magician', 'water magician'],
    ['Water Magician (Web Novel)', 'water magician'],
    ['Mizu Zokusei no Mahou Tsukai Dai San-bu: Touhou Shokoku-hen', 'mizu zokusei no mahou tsukai'],
    ['Mizu Zokusei no Mahou Tsukai Dai San-bu', 'mizu zokusei no mahou tsukai'],
    ['Mushoku Tensei - Jobless Reincarnation', 'mushoku tensei'],
    ['Mushoku Tensei \u2013 Jobless Reincarnation', 'mushoku tensei'],
    ['Attack on Titan Season 3', 'attack on titan'],
    ['Overlord Part 2', 'overlord'],
    ['Overlord 2nd Season', 'overlord'],
    ["A Returner's Magic Should Be Special", 'returner s magic should be special'],
    ['Re:Zero - Starting Life in Another World', 're zero starting life in another world'],
    ['The Arc', 'arc'],
    ['Spider-Man', 'spider man'],
  ])('%s -> %s', (title, base) => {
    expect(baseSeriesTitle(title)).toBe(base);
  });
});

describe('authorsMatch', () => {
  it('ignores name order, case and punctuation', () => {
    expect(authorsMatch(['Kubou Tadashi'], ['Tadashi Kubou'])).toBe(true);
    expect(authorsMatch(['KUBOU-Tadashi'], ['tadashi kubou'])).toBe(true);
    expect(authorsMatch(['Kubō Tadashi'], ['Tadashi Kubou'])).toBe(true);
    expect(authorsMatch(['Tadashi Kubo'], ['Kuboo Tadashi'])).toBe(true);
    expect(authorsMatch(['Satou Yuuki'], ['Satō Yūki'])).toBe(true);
    expect(authorsMatch(['Someone Else', 'Kubou Tadashi'], ['Tadashi Kubou'])).toBe(true);
  });

  it('folds long vowels only in romanized Japanese names', () => {
    expect(authorsMatch(['Kim Young'], ['Kim Yong'])).toBe(false);
    expect(authorsMatch(['Alan Moore'], ['Alan More'])).toBe(false);
    expect(authorsMatch(['Kubō'], ['Kubou'])).toBe(true);
    expect(authorsMatch(['Ryousuke Satou'], ['Ryōsuke Satō'])).toBe(true);
  });

  it('splits a credit naming several people', () => {
    expect(authorsMatch(['Kubou Tadashi & Someone Else'], ['Tadashi Kubou'])).toBe(true);
  });

  it('needs the same whole name on both sides', () => {
    expect(authorsMatch(['Tadashi'], ['Tadashi Kubou'])).toBe(false);
    expect(authorsMatch(['Kanehito Yamada'], ['Tadashi Kubou'])).toBe(false);
    expect(authorsMatch([], ['Tadashi Kubou'])).toBe(false);
    expect(authorsMatch(['Tadashi Kubou'], [])).toBe(false);
  });
});

describe('baseSeriesDisplayTitle', () => {
  it.each([
    ['The Water Magician: The Central Provinces Arc', 'The Water Magician'],
    ['Frieren - Beyond Journey', 'Frieren'],
    ['Overlord Season 2', 'Overlord'],
    ['Water Magician (Web Novel)', 'Water Magician'],
    ['Mushoku Tensei', 'Mushoku Tensei'],
  ])('shortens %s to %s, keeping its wording', (title, base) => {
    expect(baseSeriesDisplayTitle(title)).toBe(base);
  });
});

describe('authorsContradict', () => {
  it('is true only when both sides name a real author and none agree', () => {
    expect(authorsContradict(['Kim Webtoon'], ['Naoki Urasawa'])).toBe(true);
    expect(authorsContradict(['Urasawa Naoki'], ['Naoki Urasawa'])).toBe(false);
    expect(authorsContradict([], ['Naoki Urasawa'])).toBe(false);
    expect(authorsContradict(['Kim Webtoon'], [])).toBe(false);
    expect(authorsContradict(['Unknown'], ['Naoki Urasawa'])).toBe(false);
    expect(authorsContradict(['  '], ['Naoki Urasawa'])).toBe(false);
  });

  it.each<[string, string[]]>([
    ['Urasawa Naoki', ['Naoki Urasawa']],
    ['Oda Eiichirou', ['Eiichiro Oda']],
    ['Oda Eiichiro (Story & Art)', ['Eiichiro Oda']],
    ['Eiichiro Oda - Story & Art', ['Eiichiro Oda']],
    ['Chu-Gong', ['Chugong']],
    ['DUBU (REDICE STUDIO)', ['Chugong', 'DUBU']],
    ['Urasawa, Naoki', ['Naoki Urasawa']],
    ['浦沢直樹', ['Naoki Urasawa']],
    ['I Eat Tomatoes', ['Wo Chi Xi Hong Shi']],
    ['Kishimoto Masashi, Ikemoto Mikio', ['Masashi Kishimoto']],
    ['Ōkubo Atsushi', ['Atsushi Ohkubo']],
    ['Ookubo Atsushi', ['Atsushi Okubo']],
    ['Shūkan', ['Shuukan']],
    ["O'Brien Kate", ['Kate OBrien']],
  ])('treats %s and %j as the same person', (source, series) => {
    expect(authorsContradict([source], series)).toBe(false);
  });

  it.each<[string, string[]]>([
    ['Kim Webtoon', ['Naoki Urasawa']],
    ['DUBU (REDICE STUDIO)', ['Chugong']],
    ['Er Gen', ['Wo Chi Xi Hong Shi']],
    ['Naoki Urasawa (Art)', ['Kim Webtoon', '김웹툰']],
  ])('still tells %s from %j', (source, series) => {
    expect(authorsContradict([source], series)).toBe(true);
  });
});

describe('releaseNamesSeries', () => {
  it.each<[string, string[], boolean]>([
    ["2-Minute Tabletop's Everything Pack V7 by 2-Minute Tabletop [ENG] [VIP]", ['The Water Magician: The Central Provinces Arc'], false],
    ['The Water Magician Vol. 7 (Yen Press) [EPUB]', ['The Water Magician: The Central Provinces Arc'], true],
    ['Water Magician v01-05', ['The Water Magician: The Central Provinces Arc'], true],
    ['Mizu Zokusei no Mahou Tsukai v03', ['Some Other Name', 'Mizu Zokusei no Mahou Tsukai'], true],
    ['Magician Tales v2', ['The Water Magician: The Central Provinces Arc'], false],
    ['Water Magicians v2', ['Water Magician'], false],
    ['So Im a Spider So What Vol. 1 [EPUB]', ["So I'm a Spider, So What?"], true],
    ['So I’m a Spider, So What? v02', ['So Im a Spider So What'], true],
    ['Anything v2', ['', '   ', '!!!'], false],
    ['Anything v2', [], false],
  ])('matches %s against %j: %s', (release, titles, expected) => {
    expect(releaseNamesSeries(release, titles)).toBe(expected);
  });
});
