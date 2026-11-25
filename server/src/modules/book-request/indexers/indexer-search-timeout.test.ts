import { readIndexerSearchTimeoutSeconds } from './indexer-search-timeout';

describe('readIndexerSearchTimeoutSeconds', () => {
  it.each([
    { settings: {}, expected: null },
    { settings: null, expected: null },
    { settings: { searchTimeoutSeconds: '60' }, expected: null },
    { settings: { searchTimeoutSeconds: NaN }, expected: null },
    { settings: { searchTimeoutSeconds: Infinity }, expected: null },
    { settings: { searchTimeoutSeconds: 4 }, expected: 5 },
    { settings: { searchTimeoutSeconds: 181 }, expected: 180 },
    { settings: { searchTimeoutSeconds: 60.9 }, expected: 60 },
    { settings: { searchTimeoutSeconds: 60 }, expected: 60 },
  ])('reads $settings as $expected', ({ settings, expected }) => {
    expect(readIndexerSearchTimeoutSeconds('shelfmark', settings)).toBe(expected);
  });

  it('ignores a search time limit on other adapter types', () => {
    expect(readIndexerSearchTimeoutSeconds('torznab', { searchTimeoutSeconds: 60 })).toBeNull();
  });
});
