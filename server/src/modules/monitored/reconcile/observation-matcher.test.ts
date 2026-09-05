import { describe, expect, it } from 'vitest';

import { canonicalObservations, matchObservations } from './observation-matcher';
import type { Observation } from './observation.types';

function observation(id: string, patch: Partial<Observation> = {}): Observation {
  return {
    source: 'hardcover',
    id,
    canonicalId: null,
    title: id,
    subtitle: null,
    hasDesc: false,
    description: null,
    cover: null,
    releaseDate: null,
    releaseYear: null,
    precision: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    popularity: 0,
    popularityKind: 'users',
    format: 'unknown',
    language: null,
    role: null,
    isbn10: null,
    isbn13: null,
    asin: null,
    raw: {},
    ...patch,
  };
}

describe('matchObservations', () => {
  it('does not pull an unrelated work into a slot it only reaches through a secondary membership', () => {
    // The joining row's own series is a different one; it merely also lists the anchor's slot, has no
    // title in common, and contradicts the anchor on the other series they share. Nothing here says
    // these are one book, and a low readership must not be read as "minor edition of the anchor".
    const clusters = matchObservations([
      observation('hc:1', {
        title: 'The Emerald Gate',
        popularity: 4000,
        seriesName: 'Gatekeepers',
        seriesIndex: '1',
        seriesMemberships: [
          { name: 'Gatekeepers', index: '1' },
          { name: 'The Wide Universe', index: '5' },
        ],
      }),
      observation('hc:2', {
        title: 'Songs of the Deep',
        popularity: 6,
        seriesName: 'Tidewater',
        seriesIndex: '9',
        seriesMemberships: [
          { name: 'Tidewater', index: '9' },
          { name: 'Gatekeepers', index: '1' },
          { name: 'The Wide Universe', index: '7' },
        ],
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('lets a known year veto a merge when the dominant member carries no year at all', () => {
    // hc:1 has no year, so scoping the year check to the dominant member alone left the cluster with
    // no year evidence and merged it into a work two decades away. A cluster with any known year is
    // never year-blind.
    const clusters = matchObservations([
      observation('hc:1', { title: 'Repeated Title', releaseYear: null, popularity: 100 }),
      observation('hc:2', { title: 'Repeated Title', releaseYear: 2000, popularity: 5 }),
      observation('hc:3', { title: 'Repeated Title', releaseYear: 2020, popularity: 40 }),
    ]);
    const clusterOf = (id: string) => clusters.findIndex((cluster) => cluster.observations.some((entry) => entry.id === id));

    expect(clusters).toHaveLength(2);
    expect(clusterOf('hc:2')).not.toBe(clusterOf('hc:3'));
  });

  it('does not canonical-fold a box set into the single book its canonical id points at', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Stormcallers', popularity: 900 }),
      observation('hc:2', { title: 'Stormcallers Boxed Set: Books 1-3', canonicalId: 'hc:1', popularity: 4 }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('does not let a shared series slot merge a translated edition decades from the anchor', () => {
    const clusters = matchObservations([
      observation('hc:1', {
        title: 'The Alloy of Law',
        seriesName: 'Mistborn',
        seriesIndex: '4',
        releaseYear: 2011,
        popularity: 5000,
        language: 'english',
      }),
      observation('aud:1', {
        source: 'audible',
        title: 'Aleacion de ley',
        seriesName: 'Mistborn',
        seriesIndex: '4',
        releaseYear: 2035,
        popularity: 3,
        language: 'spanish',
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('still folds an audiobook edition that simply shipped years after the text at the same slot', () => {
    const clusters = matchObservations([
      observation('hc:1', {
        title: 'The Alloy of Law',
        seriesName: 'Mistborn',
        seriesIndex: '4',
        releaseYear: 2011,
        popularity: 5000,
        language: 'english',
      }),
      observation('aud:1', {
        source: 'audible',
        title: 'The Alloy of Law',
        seriesName: 'Mistborn',
        seriesIndex: '4',
        releaseYear: 2019,
        popularity: 300,
        language: 'english',
      }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it('folds a Hardcover edition into its canonical work', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Canonical' }),
      observation('hc:2', { title: 'Variant title', canonicalId: 'hc:1' }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].observations).toHaveLength(2);
  });

  it('collapses different-language bare titles in the same series slot', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Chrysalis 6', seriesName: 'Chrysalis', seriesIndex: '6' }),
      observation('aud:1', { source: 'audible', title: 'La Fourmilière', seriesName: 'Chrysalis', seriesIndex: '6' }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it('does not fuzzy-merge distinct books with incompatible slots and years', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'The Last Great Hunt', seriesName: 'Hunter', seriesIndex: '1', releaseYear: 2020 }),
      observation('gr:2', { source: 'goodreads', title: 'Last Great Hunter', seriesName: 'Hunter', seriesIndex: '2', releaseYear: 2024 }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('does not exact-core merge observations with incompatible slots and years', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Repeated Title', seriesName: 'Series', seriesIndex: '1', releaseYear: 2020 }),
      observation('gr:2', { source: 'goodreads', title: 'Repeated Title', seriesName: 'Series', seriesIndex: '2', releaseYear: 2024 }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('never fuses unrelated non-Latin titles whose cores normalize to nothing', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Война и мир', popularity: 5 }),
      observation('hc:2', { title: '君の名は。', popularity: 4 }),
      observation('hc:3', { title: '해리 포터', popularity: 3 }),
    ]);

    expect(clusters).toHaveLength(3);
  });

  it('never co-clusters year-incompatible members through a null-year bridge', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Repeated Title', releaseYear: null, popularity: 30 }),
      observation('hc:2', { title: 'Repeated Title', releaseYear: 2000, popularity: 20 }),
      observation('hc:3', { title: 'Repeated Title', releaseYear: 2020, popularity: 10 }),
    ]);
    const clusterOf = (id: string) => clusters.findIndex((cluster) => cluster.observations.some((entry) => entry.id === id));

    expect(clusters).toHaveLength(2);
    expect(clusterOf('hc:2')).not.toBe(clusterOf('hc:3'));
  });

  it('treats a blank series index as unknown rather than slot zero', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'The Way of Kings', seriesName: 'The Cosmere', seriesIndex: '', popularity: 100 }),
      observation('hc:2', { title: 'Mistborn: The Final Empire', seriesName: 'The Cosmere', seriesIndex: '   ', popularity: 90 }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('does not bridge distinct books that share a meta-series slot on function words alone', () => {
    const slot = { seriesName: 'The Cosmere (Spanish Edition)', seriesIndex: '0' };
    const clusters = matchObservations([
      observation('hc:1', { title: 'El Imperio Final', popularity: 100, ...slot }),
      observation('hc:2', { title: 'El Pozo de la Ascensión', popularity: 90, ...slot }),
      observation('hc:3', { title: 'El Héroe de las Eras', popularity: 80, ...slot }),
      observation('hc:4', { title: 'El Camino de los Reyes', popularity: 70, ...slot }),
      observation('hc:5', { title: 'El Aliento de los Dioses', popularity: 60, ...slot }),
      observation('hc:6', { title: 'El Imperio Final (Edición Ilustrada)', popularity: 5, ...slot }),
    ]);

    expect(clusters).toHaveLength(5);
    expect(clusters.find((cluster) => cluster.observations.some((entry) => entry.id === 'hc:6'))?.observations).toHaveLength(2);
  });

  it('merges an audiobook shipped years after the book it narrates', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Cage of Souls', releaseYear: 2019 }),
      observation('aud:1', { source: 'audible', title: 'Cage of Souls', releaseYear: 2026, format: 'audiobook' }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it('does not merge a years-later translated audiobook into the English work', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Steelheart', releaseYear: 2013 }),
      observation('aud:1', { source: 'audible', title: 'Steelheart', releaseYear: 2021, format: 'audiobook', language: 'spanish' }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('still splits two same-title text editions published years apart', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Cage of Souls', releaseYear: 2019 }),
      observation('gr:1', { source: 'goodreads', title: 'Cage of Souls', releaseYear: 2026 }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('ignores the documented stopwords during fuzzy title comparison', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'The Rise of Magic', releaseYear: 2024 }),
      observation('gr:2', { source: 'goodreads', title: 'Rise Magic', releaseYear: 2024 }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it('merges a work its providers file under different series, each with its own index', () => {
    // Hardcover calls The Lost Metal "Mistborn: Wax & Wayne" #4; Goodreads and Audible call the same
    // book "Mistborn" #7. Comparing the bare indexes read 4 != 7 as two different books.
    const clusters = matchObservations([
      observation('hc:1', { title: 'The Lost Metal', seriesName: 'Mistborn: Wax & Wayne', seriesIndex: '4', releaseYear: 2022, popularity: 3295 }),
      observation('gr:1', {
        source: 'goodreads',
        title: 'The Lost Metal',
        seriesName: 'Mistborn',
        seriesIndex: '7',
        releaseYear: 2022,
        popularity: 135425,
      }),
      observation('aud:1', {
        source: 'audible',
        title: 'The Lost Metal',
        seriesName: 'The Mistborn Saga',
        seriesIndex: '7',
        releaseYear: 2022,
        popularity: 215,
        language: 'english',
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].observations.map((entry) => entry.source).sort()).toEqual(['audible', 'goodreads', 'hardcover']);
  });

  it('keeps two books apart when they contest the same index of a series they both claim', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Shadows of Self', seriesName: 'Mistborn', seriesIndex: '5', releaseYear: 2015, popularity: 4000 }),
      observation('gr:1', {
        source: 'goodreads',
        title: 'Shadows of Self',
        seriesName: 'Mistborn',
        seriesIndex: '6',
        releaseYear: 2015,
        popularity: 4000,
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('does not let a shared series membership override the primary series the sides contest', () => {
    const clusters = matchObservations([
      observation('hc:1', {
        title: 'Elantris',
        seriesName: 'The Cosmere',
        seriesIndex: '1',
        seriesMemberships: [{ name: 'The Cosmere', index: '1' }],
        releaseYear: 2005,
        popularity: 4000,
      }),
      observation('gr:1', {
        source: 'goodreads',
        title: 'Elantris',
        seriesName: 'The Cosmere',
        seriesIndex: '2',
        seriesMemberships: [{ name: 'The Cosmere', index: '2' }],
        releaseYear: 2005,
        popularity: 4000,
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('clusters one provider work once even when the payload repeats its id per contribution role', () => {
    const clusters = matchObservations([
      observation('hc:1', { title: 'Elantris', role: 'Author-duplicate', popularity: 10 }),
      observation('hc:1', { title: 'Elantris', role: 'Author', popularity: 10 }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].observations).toHaveLength(1);
  });

  it('keeps the strongest contribution role when it drops a repeated id', () => {
    const forward = canonicalObservations([observation('hc:1', { role: 'Translator' }), observation('hc:1', { role: 'Author' })]);
    const reversed = canonicalObservations([observation('hc:1', { role: 'Author' }), observation('hc:1', { role: 'Translator' })]);

    expect(forward.map((entry) => entry.role)).toEqual(['Author']);
    expect(reversed.map((entry) => entry.role)).toEqual(['Author']);
  });

  it('clusters the same observation set identically whatever order the providers returned it in', () => {
    // Every pass merges greedily and re-reads what it has already merged, so arrival order used to
    // decide the merge path and a refresh could move an edition between works on unchanged data.
    const observations = [
      observation('hc:1', { title: 'White Sand, Vol. 1', seriesName: 'White Sand', seriesIndex: '1', releaseYear: 2016, popularity: 900 }),
      observation('hc:2', { title: 'White Sand, Vol. 2', seriesName: 'White Sand', seriesIndex: '2', releaseYear: 2017, popularity: 700 }),
      observation('hc:3', { title: 'White Sand, Vol. 3', seriesName: 'White Sand', seriesIndex: '3', releaseYear: 2019, popularity: 600 }),
      observation('gr:1', {
        source: 'goodreads',
        title: 'White Sand, Vol. 1',
        seriesName: 'White Sand',
        seriesIndex: '1',
        releaseYear: 2016,
        popularity: 500,
      }),
      observation('gr:2', {
        source: 'goodreads',
        title: 'White Sand, Vol. 2',
        seriesName: 'White Sand',
        seriesIndex: '2',
        releaseYear: 2017,
        popularity: 400,
      }),
      observation('gr:3', {
        source: 'goodreads',
        title: 'White Sand, Vol. 3',
        seriesName: 'White Sand',
        seriesIndex: '3',
        releaseYear: 2019,
        popularity: 300,
      }),
      observation('aud:1', {
        source: 'audible',
        title: 'White Sand',
        seriesName: 'White Sand',
        releaseYear: 2020,
        popularity: 40,
        language: 'english',
      }),
    ];
    const fingerprint = (input: Observation[]): string =>
      matchObservations(input)
        .map((cluster) =>
          cluster.observations
            .map((entry) => entry.id)
            .sort()
            .join('+'),
        )
        .sort()
        .join('|');
    const expected = fingerprint(observations);

    for (let rotation = 1; rotation < observations.length; rotation++) {
      expect(fingerprint([...observations.slice(rotation), ...observations.slice(0, rotation)])).toBe(expected);
    }
    expect(fingerprint([...observations].reverse())).toBe(expected);
  });
});
