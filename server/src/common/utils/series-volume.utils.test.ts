import { describe, expect, it } from 'vitest';

import { seriesVolumeConflict, statedVolume, type SeriesPlacedTitle } from './series-volume.utils';

function p(title: string, seriesName: string | null = null, seriesIndex: string | null = null): SeriesPlacedTitle {
  return { title, seriesName, seriesIndex };
}

describe('statedVolume', () => {
  const stated: [string, number, string, boolean][] = [
    ['Beware of Chicken Volume 6', 6, 'Beware of Chicken', true],
    ['Azarinth Healer: Book Seven', 7, 'Azarinth Healer', true],
    ['The Primal Hunter 16', 16, 'The Primal Hunter', false],
    ['Beware of Chicken 5: A Xianxia Cultivation Novel', 5, 'Beware of Chicken', false],
    ['Words of Radiance (The Stormlight Archive, Book 2)', 2, 'The Stormlight Archive', true],
  ];
  it.each(stated)('reads the volume %s states', (title, volume, front, marked) => {
    expect(statedVolume(title)).toEqual({ volume, front, marked });
  });

  it.each(['2. Elantris', 'Warbreaker - 2009', 'Six of Crows', 'Ready Player One', 'Beware of Chicken (2022)'])('states no volume: %s', (title) => {
    expect(statedVolume(title)).toBeNull();
  });
});

describe('seriesVolumeConflict', () => {
  const conflicting: [string, SeriesPlacedTitle, SeriesPlacedTitle][] = [
    [
      'a numbered volume against the bare series title at another number',
      p('Beware of Chicken Volume 6', 'Beware of Chicken', '6'),
      p('Beware of Chicken', 'Beware of Chicken', '1'),
    ],
    [
      'a numbered volume against the bare series title with no number',
      p('Beware of Chicken Volume 6', 'Beware of Chicken', '6'),
      p('Beware of Chicken'),
    ],
    [
      'a numbered volume against the series with a subtitle',
      p('Beware of Chicken Volume 6', 'Beware of Chicken', '6'),
      p('Beware of Chicken: A Xianxia Cultivation Novel'),
    ],
    ['a numbered volume against the series with a year', p('Beware of Chicken Volume 6', 'Beware of Chicken', '6'), p('Beware of Chicken (2022)')],
    [
      'two stated volumes behind the same series front',
      p('The Water Magician: Arc 1 Volume 7', 'The Water Magician (Light Novel)', '7'),
      p('The Water Magician: The Central Provinces Arc, Volume 1'),
    ],
    ['spelled-out volumes', p('Azarinth Healer: Book Seven'), p('Azarinth Healer: Book Three')],
    ['trailing volume numbers', p('He Who Fights with Monsters 13'), p('He Who Fights with Monsters 11')],
    ['series numbers on the same series', p('The Primal Hunter', 'The Primal Hunter', '1'), p('The Primal Hunter 6', 'The Primal Hunter', '6')],
    [
      'trailing numbers each confirmed by its own series position',
      p('The Primal Hunter 16', 'The Primal Hunter', '16'),
      p('The Primal Hunter 11', 'The Primal Hunter', '11'),
    ],
    ['series numbers on an unnumbered title', p('Wintersteel', 'Cradle', '8'), p('Wintersteel', 'Cradle', '9')],
    [
      'series numbers on a self-named series',
      p('Unintended Cultivator', 'Unintended Cultivator', '3'),
      p('Unintended Cultivator', 'Unintended Cultivator', '1'),
    ],
    [
      'a stated volume against the numbered first book',
      p('Defiance of the Fall 2: A LitRPG Adventure'),
      p('Defiance of the Fall', 'Defiance of the Fall', '1'),
    ],
    [
      'a stated volume against a bracketed one',
      p('Rise of the Living Forge 6', 'Rise of the Living Forge', '6'),
      p('Rise of the Living Forge (Book 5)', 'Rise of the Living Forge', '5'),
    ],
    ['a novella slot against the novel it hangs off', p("Elantris - The Emperor's Soul", 'Elantris', '1.75'), p('Elantris', 'Elantris', '1')],
    [
      'equal series numbers behind different stated volumes',
      p('Beware of Chicken: Volume 6', 'Beware of Chicken', '1'),
      p('Beware of Chicken: Volume 5', 'Beware of Chicken', '1'),
    ],
    ['the series name as the other title against a later stated volume', p('The 100'), p('The 100 (The 100, Book 2)')],
  ];
  it.each(conflicting)('conflicts: %s', (_, left, right) => {
    expect(seriesVolumeConflict(left, right)).toBe(true);
  });

  const agreeing: [string, SeriesPlacedTitle, SeriesPlacedTitle][] = [
    [
      'different series names number the same title independently',
      p('The Alloy of Law', 'Mistborn', '4'),
      p('The Alloy of Law', 'Mistborn: Wax and Wayne', '1'),
    ],
    ['a series named in the title is not that series', p('Evershore', 'Skyward Flight', '3'), p('Evershore (Skyward Flight)', 'Skyward', '6')],
    [
      'the same volume stated twice',
      p('The Primal Hunter 16: A LitRPG Adventure', 'The Primal Hunter', '16'),
      p('The Primal Hunter 16', 'The Primal Hunter', '16'),
    ],
    ['the first book against its bare series title', p('Beware of Chicken', 'Beware of Chicken', '1'), p('Beware of Chicken')],
    ['the series name as the other title against its stated first book', p('The 100'), p('The 100 (The 100, Book 1)')],
    [
      'a bare title against a bracketed series and volume',
      p('Words of Radiance'),
      p('Words of Radiance (The Stormlight Archive, Book 2)', 'The Stormlight Archive', '2'),
    ],
    [
      'the same slot through a bracketed series name',
      p('Red Rising', 'Red Rising Saga', '1'),
      p('Red Rising (Red Rising Saga, Book 1)', 'Red Rising Saga', '1'),
    ],
    ['a trailing year', p('Warbreaker'), p('Warbreaker - 2009')],
    ['a leading file index', p('Elantris'), p('2. Elantris')],
    ['a padded file index and author', p('Mort'), p('04. Mort - Terry Pratchett')],
    ['a number inside the title word', p('Catch-22', 'Catch-22', '1'), p('Catch-22')],
    ['a number that is part of the title', p('Fahrenheit 451', 'Ray Bradbury Graphic Novels', '1'), p('Fahrenheit 451')],
    ['a bare title number overruled by the series position', p('The 100', 'The 100', '1'), p('The 100 (TV Tie-in Edition)', 'The 100', '1')],
    ['a number inside the title word at a series position', p('Catch-22', 'Catch-22', '1'), p('Catch-22', 'Catch-22', '1')],
    [
      'the same novella slot stated twice',
      p('Mitosis: A Reckoners Story', 'The Reckoners', '1.5'),
      p('Mitosis: The Reckoners (Book 1.5)', 'The Reckoners', '1.5'),
    ],
  ];
  it('keeps a volume stated in brackets when the series name is outside them', () => {
    expect(
      seriesVolumeConflict(
        p('Rise of the Living Forge, Book 2', 'Rise of the Living Forge', '2'),
        p('Rise of the Living Forge (Book 2)', 'Rise of the Living Forge', '2'),
      ),
    ).toBe(false);
  });

  it.each(agreeing)('does not conflict: %s', (_, left, right) => {
    expect(seriesVolumeConflict(left, right)).toBe(false);
  });

  it('library metadata numbering the same book differently is still a conflict', () => {
    expect(seriesVolumeConflict(p('Inhibitor Phase', 'Revelation Space', '4'), p('Inhibitor Phase', 'Revelation Space', '5'))).toBe(true);
  });
});
