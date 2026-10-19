import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MonitoredWorkKind } from '@bookorbit/types';

import type { AudibleProduct } from '../../metadata-fetch/providers/audible/audible.types';
import { describe, expect, it } from 'vitest';

import { filterAudibleProductsByAuthor, mapAudibleObservations } from '../providers/audible-bibliography.provider';
import { mapGoodreadsObservations } from '../providers/goodreads-bibliography.provider';
import { mapHardcoverObservations } from '../providers/hardcover-bibliography.provider';
import { mergeCluster } from './cluster-merger';
import { matchObservations, normalizeCore } from './observation-matcher';
import type { MergedWork, Observation } from './observation.types';
import { resolveSlots, slotReasonKind } from './slot-resolution';
import { assignVerdict, computePopularityFloor } from './verdict';
import { COLLECTION_TITLE_PATTERN } from './work-shape';

const TODAY = '2026-09-03';
// brandon_sanderson_lost_metal is a second, later capture of the same author, kept because it is the
// only fixture that carries the rows the English/Italian identity regression needs: the Italian
// Il Metallo Perduto with no canonical_id, and a 2025 Russian printing that Hardcover DOES mark
// canonical. Hardcover had indexed neither when brandon_sanderson was captured.
const ALL_FIXTURES = [
  'brandon_sanderson',
  'brandon_sanderson_lost_metal',
  'adrian_tchaikovsky',
  'rinoz',
  'arcanecadence',
  'zogarth',
  'matt_dinniman',
  'dan_simmons',
  'arthur_c_clarke',
  'dakota_krout',
];
const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');
const NON_LATIN_SCRIPT_PATTERN =
  /\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Devanagari}|\p{Script=Thai}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}|\p{Script=Hangul}/u;

interface Fixture {
  name: string;
  hardcover: { books: unknown[] };
  goodreads: { rows: unknown[] };
  audible: { products: AudibleProduct[] };
}

type ReconciledWork = MergedWork & ReturnType<typeof assignVerdict> & { kind: MonitoredWorkKind | null };

function fixture(slug: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${slug}.json`), 'utf8')) as Fixture;
}

function observationsOf(input: Fixture): Observation[] {
  const audibleProducts = filterAudibleProductsByAuthor(input.audible.products, input.name);
  return [
    ...mapHardcoverObservations(input.hardcover.books),
    ...mapGoodreadsObservations(input.goodreads.rows),
    ...mapAudibleObservations(audibleProducts),
  ];
}

function reconcileObservations(observations: Observation[]): ReconciledWork[] {
  const clustered = matchObservations(observations).map((cluster) => mergeCluster(cluster, TODAY));
  // Mirrors fetchCatalog: slot resolution drops duplicates before the floor is computed, and hidden
  // works stay in the catalog demoted to the review tray. Without this the suite would stop covering
  // the stage entirely, because it reassembles the pipeline rather than calling the service.
  const slots = resolveSlots(clustered, TODAY);
  const survivors = clustered.map((work, index) => ({ work, index })).filter(({ index }) => !slots.rejected.has(index));
  const merged = survivors.map(({ work }) => work);
  const floor = computePopularityFloor(merged);
  return survivors.map(({ work, index }) => {
    const verdict = assignVerdict(work, { today: TODAY, floor });
    return {
      ...work,
      ...verdict,
      verdict: slots.hidden.has(index) ? ('suspect' as const) : verdict.verdict,
      kind: slotReasonKind(slots.reasons.get(index)),
    };
  });
}

function reconcile(input: Fixture): ReconciledWork[] {
  return reconcileObservations(observationsOf(input));
}

/** Everything a refresh would persist, order-insensitive, so a diff names the field that moved. */
function catalogFingerprint(works: ReconciledWork[]): string[] {
  return works
    .map((work) =>
      [
        Object.entries(work.providerWorkIds)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([source, id]) => `${source}=${id}`)
          .join(','),
        work.title,
        work.seriesName ?? '',
        work.seriesIndex ?? '',
        work.ebookReleaseDate ?? '',
        work.audioReleaseDate ?? '',
        work.verdict,
        [...work.sources].sort().join('+'),
        [...work.flags].sort().join('+'),
      ].join('|'),
    )
    .sort();
}

/** Deterministic permutation, so a failure is reproducible from the seed alone. */
function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  const next = (): number => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(next() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function verified(works: ReconciledWork[]): ReconciledWork[] {
  return works.filter((work) => work.verdict === 'verified' && work.flags.length === 0);
}

function loadAndReconcile(slug: string): ReconciledWork[] {
  const input = fixture(slug);
  const works = reconcile(input);
  console.info(`[monitored acceptance] ${input.name}: verified=${verified(works).length} total=${works.length}`);
  return works;
}

describe('multi-source reconciliation acceptance', () => {
  it('produces a zero-junk verified Brandon Sanderson catalog', () => {
    for (const slug of ['brandon_sanderson', 'brandon_sanderson_lost_metal']) {
      const works = verified(loadAndReconcile(slug));
      const identities = works.map((work) => `${normalizeCore(work.title, work.seriesName)}#${work.seriesIndex ?? ''}`);

      expect(works.length).toBeGreaterThanOrEqual(80);
      expect(works.length).toBeLessThanOrEqual(130);
      expect(works.some((work) => NON_LATIN_SCRIPT_PATTERN.test(work.title))).toBe(false);
      expect(works.some((work) => normalizeCore(work.title, work.seriesName) === '')).toBe(false);
      // These are announced books whose titles are not public yet, and each holds a numbered place in
      // the series - the most valuable rows a monitoring catalog can carry, not junk to suppress.
      expect(works.filter((work) => /^Untitled Stormlight Archive #(?:[6-9]|10)$/i.test(work.title)).length).toBeGreaterThanOrEqual(5);
      expect(works.some((work) => /books?\s*\d+\s*[-\u2013\u2014]\s*\d+|box(?:ed)?\s*set|omnibus/i.test(work.title))).toBe(false);
      expect(new Set(identities).size).toBe(identities.length);
    }
  });

  it('keeps RinoZ future and numbered works without duplicate Chrysalis 6', () => {
    const works = verified(loadAndReconcile('rinoz'));
    const cruelty = works.find((work) => /Cruelty's Antidote/i.test(work.title));

    expect(cruelty).toMatchObject({ seriesName: 'Chrysalis', seriesIndex: '10', verdict: 'verified' });
    for (const index of ['1', '2', '3', '4', '5']) {
      expect(works.some((work) => /Book of the Dead/i.test(work.seriesName ?? work.title) && work.seriesIndex === index)).toBe(true);
    }
    expect(works.filter((work) => /Chrysalis/i.test(work.seriesName ?? '') && Number(work.seriesIndex) === 6)).toHaveLength(1);
  });

  it('keeps ebook-first Primal Hunter works 16 and 17', () => {
    const works = verified(loadAndReconcile('zogarth'));

    for (const index of ['16', '17']) {
      expect(works.some((work) => /Primal Hunter/i.test(work.seriesName ?? work.title) && work.seriesIndex === index)).toBe(true);
    }
  });

  it('retains the ArcaneCadence identity variant with Hardcover evidence', () => {
    const works = verified(loadAndReconcile('arcanecadence'));
    const archmage = works.find((work) => /New Life As? A Max Level Archmage/i.test(work.title));

    expect(archmage?.sources).toContain('hardcover');
  });

  it('keeps The Lost Metal English while folding its Italian translation in', () => {
    // Providers file this book under three different series (Hardcover "Mistborn: Wax & Wayne" #4,
    // Goodreads "Mistborn" #7, Audible "The Mistborn Saga" #7), and Hardcover carries an Italian
    // edition claiming a slot the English row only lists as a secondary membership. That split the
    // work: the English row lost its Audible edition, its audio date and the owner's audiobook to the
    // translation. A translation is an EDITION, so it has to fold in, and the English row has to keep
    // the identity.
    const works = loadAndReconcile('brandon_sanderson_lost_metal');
    const lostMetal = works.filter(
      (work) =>
        normalizeCore(work.title, work.seriesName) === 'the lost metal' && !work.compilationFlag && !COLLECTION_TITLE_PATTERN.test(work.title),
    );

    expect(lostMetal).toHaveLength(1);
    expect(lostMetal[0]).toMatchObject({
      title: 'The Lost Metal',
      verdict: 'verified',
      audioReleaseDate: '2022-11-15',
      audioDatePrecision: 'day',
    });
    expect(lostMetal[0].flags).toEqual([]);
    expect(lostMetal[0].providerWorkIds.hardcover).toBe('the-lost-metal');
    expect([...lostMetal[0].sources].sort()).toEqual(['audible', 'goodreads', 'hardcover']);
    // The Italian row is inside the English work, not beside it, in any list and at any verdict.
    expect(lostMetal[0].observations.some((observation) => observation.id === 'hc:2730154')).toBe(true);
    expect(works.some((work) => work.providerWorkIds.hardcover === 'il-metallo-perduto')).toBe(false);
    expect(works.some((work) => /metallo perduto/i.test(work.title))).toBe(false);
  });

  it('is idempotent across every committed author fixture', () => {
    for (const slug of ALL_FIXTURES) {
      const input = fixture(slug);
      const firstWorks = verified(reconcile(input));
      console.info(`[monitored acceptance] ${input.name}: verified=${firstWorks.length}`);
      const first = firstWorks.map((work) => work.title);
      const second = verified(reconcile(input)).map((work) => work.title);
      expect(second).toEqual(first);
    }
  });

  it('reconciles the same observation set identically whatever order the providers returned it in', () => {
    // Providers do not promise a stable order (Audible pages a live catalog, Hardcover ships one row
    // per contribution), and every matcher pass merges greedily, so an unstable order would rewrite
    // the catalog on a refresh whose data never changed - moving editions, dates and verdicts.
    for (const slug of ALL_FIXTURES) {
      const observations = observationsOf(fixture(slug));
      const expected = catalogFingerprint(reconcileObservations(observations));

      for (const seed of [1, 42, 31337]) {
        expect(catalogFingerprint(reconcileObservations(shuffled(observations, seed)))).toEqual(expected);
      }
    }
  });

  it('never emits two works for one provider work', () => {
    for (const slug of ALL_FIXTURES) {
      const works = reconcile(fixture(slug));
      const claims = works.flatMap((work) => Object.entries(work.providerWorkIds).map(([source, id]) => `${source}:${id}`));

      expect(new Set(claims).size).toBe(claims.length);
    }
  });
});

describe('Hardcover signals on real catalogs', () => {
  const catalogs = new Map<string, ReconciledWork[]>();
  const catalog = (slug: string): ReconciledWork[] => {
    if (!catalogs.has(slug)) catalogs.set(slug, reconcile(fixture(slug)));
    return catalogs.get(slug)!;
  };
  const isShown = (work: ReconciledWork): boolean => work.verdict === 'verified' && work.flags.length === 0 && work.kind == null;
  const titled = (slug: string, title: string): ReconciledWork[] => {
    const works = catalog(slug).filter((work) => work.title === title);
    expect(works, `${slug} has no work titled ${title}`).not.toHaveLength(0);
    return works;
  };
  const expectShown = (slug: string, title: string): void => {
    expect(titled(slug, title).some(isShown), `${title} should be shown`).toBe(true);
  };
  const expectKind = (slug: string, title: string, kind: MonitoredWorkKind): void => {
    for (const work of titled(slug, title)) expect(work.kind, title).toBe(kind);
  };
  const expectForeign = (slug: string, title: string): void => {
    for (const work of titled(slug, title)) expect(work.flags, title).toContain('foreign_language');
  };

  it('hides Dungeon Crawler Carl season episodes as dramatizations and keeps the novels', () => {
    for (const title of ['A Betrayal Most Foul', 'Thank You for Volunteering', 'Cockblock!']) expectKind('matt_dinniman', title, 'dramatization');
    for (const title of [
      'Dungeon Crawler Carl',
      "Carl's Doomsday Scenario",
      "The Dungeon Anarchist's Cookbook",
      'The Gate of the Feral Gods',
      "The Butcher's Masquerade",
      'The Eye of the Bedlam Bride',
      'This Inevitable Ruin',
    ]) {
      expectShown('matt_dinniman', title);
    }
  });

  it('shows real books that Hardcover flags as compilations and hides the omnibuses', () => {
    expectShown('dakota_krout', 'Axiom');
    expectShown('adrian_tchaikovsky', 'A Time for Grief');
    expectShown('brandon_sanderson', 'Tailored Realities');
    for (const title of ['Mistborn Trilogy Boxed Set', "Legion and the Emperor's Soul", 'The Complete Wheel of Time']) {
      expectKind('brandon_sanderson', title, 'collection');
    }
  });

  it('hides anthologies the author only contributed to', () => {
    expectKind('adrian_tchaikovsky', 'Shakespeare vs. Cthulhu', 'anthology');
    expectKind('adrian_tchaikovsky', 'Solaris Rising 2: The New Solaris Book of Science Fiction', 'anthology');
    expectKind('dan_simmons', 'The Space Opera Renaissance', 'anthology');
    expectShown('adrian_tchaikovsky', 'Children of Time');
  });

  it('flags foreign editions and keeps the English originals', () => {
    expectForeign('dan_simmons', 'Černé léto');
    expectForeign('dan_simmons', 'La rebelión');
    expectForeign('arthur_c_clarke', 'Oceánem hvězd');
    expectForeign('arthur_c_clarke', 'Las Arenas de Marte');
    expectForeign('arthur_c_clarke', 'Fuentes del paraíso');
    expectShown('dan_simmons', 'Hyperion');
    expectShown('dan_simmons', 'Summer of Night');
    expectShown('arthur_c_clarke', "Childhood's End");
  });

  it('hides published prologues as supplemental', () => {
    for (const title of [
      'By Grace and Banners Fallen: Prologue to A Memory of Light',
      'What the Storm Means: Prologue to The Gathering Storm',
      'Distinctions: Prologue to Towers of Midnight',
    ]) {
      expectKind('brandon_sanderson', title, 'supplemental');
    }
  });
});
