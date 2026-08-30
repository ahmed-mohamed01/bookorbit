/**
 * Audiobookshelf UPSTREAM CONTRACT tests.
 *
 * WHAT THIS IS
 * ------------
 * The Audiobookshelf (ABS) integration is a personal downstream fork that keeps merging
 * upstream BookOrbit. ABS deliberately CALLS existing upstream functions instead of
 * reinventing them (see docs-fork/abs-integration-decisions.md). The rest of the ABS test
 * suite MOCKS those upstream functions, so an upstream change that keeps the same signature
 * but changes BEHAVIOUR (e.g. a scorer's range, a normalizer's character class, an SSRF
 * range check, a timezone boundary) would pass every mocked test while silently breaking the
 * live integration on the next merge.
 *
 * These tests import and call the REAL upstream functions ABS depends on and assert the
 * SPECIFIC behaviour ABS relies on. They must NOT mock the function under test - that is the
 * whole point. When a future upstream merge drifts one of these behaviours, a test here fails
 * and names the exact contract that broke.
 *
 * OUT OF SCOPE (needs an integration / DB harness this layer intentionally does NOT use)
 * -------------------------------------------------------------------------------------
 * DB-bound upstream dependencies are not exercised here because they require a live database,
 * scoped users, and real table rows:
 *   - ReadingAttemptService.importUnlinkedRead      (writes reading_attempts)
 *   - MetadataService.applyCoverFromSources         (cover precedence + disk/DB writes)
 *   - BookService.saveAudioProgress / ABS upsertAudioProgress (audio_progress writes)
 *   - shared reading-session / daily-stats table writes
 * Their PURE helpers (aggregateReadingSessionDailyStats, getDayRangeForDateKeys,
 * getReadingSessionDayKeys, the timezone utils) ARE covered here; only the DB round-trip is
 * deferred to an integration harness.
 */

import { describe, expect, it } from 'vitest';

// 1) Hardcover fuzzy-match helpers - ABS's scoreFuzzy tier is built on these.
import {
  normalizeIsbn as hardcoverNormalizeIsbn,
  normalizeName,
  normalizedLevenshtein,
  scoreAuthors,
  scoreTitle,
  tokenOverlap,
} from '../../common/utils/fuzzy-match.utils';

// 2/3) isbn-detect - ABS's metadata.json persist-path validator/normalizer.
import { isValidIsbn10, isValidIsbn13, normalizeIsbn as isbnDetectNormalizeIsbn } from '../metadata/lib/isbn-detect';

// 4) SSRF guard - ABS's client calls this on every outbound request.
import { ensureSafeUrl } from '../../common/utils/ssrf.utils';

// 5) timezone utils - ABS files sessions/attempts by tz date key.
import { resolveTimeZone, toDateKeyInTimeZone } from '../../common/utils/timezone.utils';

// 6) reading daily-stats utils - ABS session ingest feeds the reading log through these.
import {
  aggregateReadingSessionDailyStats,
  getDayRangeForDateKeys,
  getReadingSessionDayKeys,
  type ReadingSessionDailyStatsInput,
} from '../../common/utils/reading-daily-stats.utils';

// 7) cover decode gate - ABS's sidecar cover handler gates writes on this.
import { isDecodableImage } from '../metadata/lib/cover';

// 8) migration planner path helpers - ABS's path match tier rewrites ABS item paths through these.
import { applyPathMappings, pathMatchesPrefix } from '../migration/planner/matching.service';

/**
 * ABS thresholds, copied verbatim from audiobookshelf-match.service.ts. If upstream scorer
 * behaviour drifts relative to these numbers, ABS auto-linking silently shifts, so we pin the
 * scorer behaviour against the exact gates ABS uses.
 */
const FUZZY_ACCEPT_CONFIDENCE = 84;
const FUZZY_TITLE_MIN = 0.8;
const FUZZY_AUTHOR_MIN = 0.7;

describe('upstream contract: hardcover fuzzy-match helpers (ABS scoreFuzzy tier)', () => {
  it('scoreTitle returns a number in [0,1]', () => {
    const score = scoreTitle('The Hobbit', 'The Silmarillion');
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scoreTitle: identical titles score ~1 and clear the FUZZY_TITLE_MIN gate ABS uses', () => {
    const score = scoreTitle('The Fellowship of the Ring', 'The Fellowship of the Ring');
    expect(score).toBeCloseTo(1, 5);
    expect(score).toBeGreaterThanOrEqual(FUZZY_TITLE_MIN);
  });

  it('scoreTitle: unrelated titles score low (below FUZZY_TITLE_MIN)', () => {
    const score = scoreTitle('The Hobbit', 'Cooking for Beginners');
    expect(score).toBeLessThan(FUZZY_TITLE_MIN);
  });

  it('scoreAuthors: a matching author scores ~1 and clears FUZZY_AUTHOR_MIN', () => {
    const score = scoreAuthors(['J.R.R. Tolkien'], ['J. R. R. Tolkien']);
    expect(score).toBeGreaterThanOrEqual(FUZZY_AUTHOR_MIN);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scoreAuthors: a non-matching author scores below FUZZY_AUTHOR_MIN', () => {
    const score = scoreAuthors(['J.R.R. Tolkien'], ['Isaac Asimov']);
    expect(score).toBeLessThan(FUZZY_AUTHOR_MIN);
  });

  it('a fully-matching title+author pair produces confidence >= FUZZY_ACCEPT_CONFIDENCE (ABS 0.7/0.3 weighting)', () => {
    const titleScore = scoreTitle('The Two Towers', 'The Two Towers');
    const authorScore = scoreAuthors(['J.R.R. Tolkien'], ['J. R. R. Tolkien']);
    const confidence = Math.round((titleScore * 0.7 + authorScore * 0.3) * 100);
    expect(confidence).toBeGreaterThanOrEqual(FUZZY_ACCEPT_CONFIDENCE);
  });

  it('normalizedLevenshtein returns [0,1] and identical inputs -> 1', () => {
    expect(normalizedLevenshtein('tolkien', 'tolkien')).toBe(1);
    const partial = normalizedLevenshtein('tolkien', 'tolken');
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(partial).toBeLessThanOrEqual(1);
    expect(partial).toBeLessThan(1);
  });

  it('tokenOverlap returns [0,1] and identical multi-token inputs -> 1', () => {
    expect(tokenOverlap('the two towers', 'the two towers')).toBe(1);
    const partial = tokenOverlap('the two towers', 'the two kingdoms');
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(partial).toBeLessThanOrEqual(1);
    expect(partial).toBeLessThan(1);
  });

  it('normalizeName lowercases, strips punctuation/diacritics and collapses/trims whitespace', () => {
    expect(normalizeName('  J.R.R.   Tolkien  ')).toBe('j r r tolkien');
    expect(normalizeName('Émile Zola')).toBe('emile zola');
  });
});

describe('upstream contract: isbn-detect validators (ABS metadata.json persist path)', () => {
  it('isValidIsbn13: checksum-valid ISBN-13 -> true, checksum-invalid 13-digit -> false', () => {
    expect(isValidIsbn13('9780306406157')).toBe(true);
    // Same string with a broken final check digit.
    expect(isValidIsbn13('9780306406158')).toBe(false);
  });

  it('isValidIsbn10: checksum-valid ISBN-10 with trailing X -> true, invalid -> false', () => {
    // 080442957X is a canonical valid ISBN-10 whose check digit is X.
    expect(isValidIsbn10('080442957X')).toBe(true);
    expect(isValidIsbn10('0804429570')).toBe(false);
  });

  it('normalizeIsbn strips separators and uppercases the trailing x', () => {
    expect(isbnDetectNormalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(isbnDetectNormalizeIsbn('0-8044-2957-x')).toBe('080442957X');
  });
});

describe('upstream contract: ISBN normalizer cross-check (persist path vs match path)', () => {
  /**
   * THE CROSS-CHECK (highest value). ABS deliberately uses isbn-detect's normalizeIsbn on the
   * PERSIST path (abs-metadata.mapper.ts) and hardcover's exported normalizeIsbn on the MATCH
   * path (audiobookshelf.repository ISBN tier), and relies on them producing the IDENTICAL
   * normalized string so a book persisted under one key matches under the other. isbn-detect
   * uses [^0-9Xx]/g + toUpperCase; hardcover uses [^0-9X]/gi + toUpperCase. If a future
   * upstream merge changes EITHER character class or casing, this test catches the divergence
   * that would break ABS matching.
   *
   * Note the ONLY documented, benign difference: hardcover returns null when the result is
   * empty, isbn-detect returns ''. We assert equivalence on inputs that normalize to a
   * non-empty value (the only inputs that can ever match a book).
   */
  const cases = ['978-0-306-40615-7', '979 8 6024 07 815', '0-8044-2957-x', 'ISBN: 9780306406157', '  080442957X  '];

  for (const raw of cases) {
    it(`normalizes "${raw}" identically on both paths`, () => {
      const persist = isbnDetectNormalizeIsbn(raw);
      const match = hardcoverNormalizeIsbn(raw);
      expect(persist).not.toBe('');
      expect(match).not.toBeNull();
      expect(persist).toBe(match);
    });
  }
});

describe('upstream contract: ensureSafeUrl SSRF guard (ABS outbound requests)', () => {
  it('rejects a non-http(s) scheme', async () => {
    await expect(ensureSafeUrl('ftp://example.com/resource')).rejects.toThrow();
  });

  it('rejects loopback IP literal http://127.0.0.1 when local servers are not allowed', async () => {
    await expect(ensureSafeUrl('http://127.0.0.1/status')).rejects.toThrow();
  });

  it('rejects private IP literal http://10.0.0.1 when private hosts are not allowed', async () => {
    await expect(ensureSafeUrl('http://10.0.0.1/status')).rejects.toThrow();
  });

  it('rejects link-local metadata IP http://169.254.169.254 (cloud metadata SSRF vector)', async () => {
    await expect(ensureSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('allows a normal public https IP literal (no DNS needed)', async () => {
    // 8.8.8.8 is a public, non-private IP literal - ensureSafeUrl short-circuits the isIP path
    // and never performs DNS, so this stays hermetic while proving public hosts pass.
    const url = await ensureSafeUrl('https://8.8.8.8/api/libraries');
    expect(url.hostname).toBe('8.8.8.8');
    expect(url.protocol).toBe('https:');
  });
});

describe('upstream contract: timezone utils (ABS session/attempt date bucketing)', () => {
  it('toDateKeyInTimeZone: same instant near midnight yields different date keys per zone', () => {
    const instant = new Date('2026-07-10T23:30:00Z');
    expect(toDateKeyInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-07-10');
    expect(toDateKeyInTimeZone(instant, 'Europe/London')).toBe('2026-07-11');
  });

  it('resolveTimeZone: undefined -> fallback, valid zone passes through', () => {
    expect(resolveTimeZone(undefined, 'UTC')).toBe('UTC');
    expect(resolveTimeZone('America/Los_Angeles', 'UTC')).toBe('America/Los_Angeles');
    expect(resolveTimeZone('Not/AZone', 'UTC')).toBe('UTC');
  });
});

describe('upstream contract: reading daily-stats utils (ABS reading-log ingest)', () => {
  const singleDaySession: ReadingSessionDailyStatsInput = {
    startedAt: new Date('2026-07-10T10:00:00Z'),
    endedAt: new Date('2026-07-10T10:30:00Z'),
    durationSeconds: 1800,
    progressDelta: 0.1,
  };

  it('aggregateReadingSessionDailyStats: single-day session yields the segment shape ABS persists', () => {
    const segments = aggregateReadingSessionDailyStats([singleDaySession], 'UTC');
    expect(segments).toHaveLength(1);
    // The ABS repository reads back exactly these four fields when writing user_reading_daily_stats.
    expect(segments[0]).toEqual({
      day: '2026-07-10',
      readingSeconds: 1800,
      progressDelta: 0.1,
      sessionsCount: 1,
    });
  });

  it('aggregateReadingSessionDailyStats: a cross-midnight session splits across two day buckets, conserving seconds', () => {
    const crossMidnight: ReadingSessionDailyStatsInput = {
      startedAt: new Date('2026-07-10T23:30:00Z'),
      endedAt: new Date('2026-07-11T00:30:00Z'),
      durationSeconds: 3600,
      progressDelta: 0.2,
    };
    const segments = aggregateReadingSessionDailyStats([crossMidnight], 'UTC');
    expect(segments.map((s) => s.day)).toEqual(['2026-07-10', '2026-07-11']);
    const totalSeconds = segments.reduce((sum, s) => sum + s.readingSeconds, 0);
    expect(totalSeconds).toBe(3600);
    for (const segment of segments) {
      expect(segment).toHaveProperty('progressDelta');
      expect(segment).toHaveProperty('sessionsCount', 1);
    }
  });

  it('getReadingSessionDayKeys: returns the tz day keys a session touches', () => {
    expect(getReadingSessionDayKeys(singleDaySession, 'UTC')).toEqual(['2026-07-10']);
    const instant = new Date('2026-07-10T23:30:00Z');
    const laSession: ReadingSessionDailyStatsInput = {
      startedAt: instant,
      endedAt: new Date(instant.getTime() + 60_000),
      durationSeconds: 60,
      progressDelta: null,
    };
    expect(getReadingSessionDayKeys(laSession, 'America/Los_Angeles')).toEqual(['2026-07-10']);
    expect(getReadingSessionDayKeys(laSession, 'Europe/London')).toEqual(['2026-07-11']);
  });

  it('getDayRangeForDateKeys: single date key -> [startOfDay, startOfNextDay) half-open range', () => {
    const range = getDayRangeForDateKeys(['2026-07-10'], 'UTC');
    expect(range).not.toBeNull();
    expect(range!.start.toISOString()).toBe('2026-07-10T00:00:00.000Z');
    expect(range!.end.toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });
});

/**
 * ABS's path match tier (`audiobookshelf-match.utils.ts`) builds on these two: `pathMatchesPrefix`
 * decides whether a saved mapping covers an ABS item path at all, and `applyPathMappings` performs
 * the rewrite. ABS relies on three behaviours in particular, none of them visible in the signatures:
 * the unchanged-input passthrough (which is why coverage is checked separately before mapping),
 * longest-source-prefix-wins, and the silent skipping of a prefix that normalizes to empty.
 */
describe('upstream contract: planner path mapping helpers (ABS path match tier)', () => {
  it('applyPathMappings returns the input unchanged when no mapping matches', () => {
    const mappings = [{ sourcePrefix: '/audiobooks', targetPrefix: '/books' }];
    expect(applyPathMappings('/podcasts/Author/Title', mappings)).toBe('/podcasts/Author/Title');
    // A prefix that only matches as a string, not as a path boundary, is not a match either.
    expect(applyPathMappings('/audiobooks-archive/Author/Title', mappings)).toBe('/audiobooks-archive/Author/Title');
  });

  it('applyPathMappings rewrites a covered path and tolerates a trailing slash on either prefix', () => {
    expect(applyPathMappings('/audiobooks/Author/Title', [{ sourcePrefix: '/audiobooks', targetPrefix: '/books' }])).toBe('/books/Author/Title');
    expect(applyPathMappings('/audiobooks/Author/Title', [{ sourcePrefix: '/audiobooks/', targetPrefix: '/books/' }])).toBe('/books/Author/Title');
  });

  it('applyPathMappings: the longest matching source prefix wins, whatever the array order', () => {
    const broad = { sourcePrefix: '/audiobooks', targetPrefix: '/books' };
    const specific = { sourcePrefix: '/audiobooks/scifi', targetPrefix: '/media/scifi' };
    expect(applyPathMappings('/audiobooks/scifi/Author/Title', [broad, specific])).toBe('/media/scifi/Author/Title');
    expect(applyPathMappings('/audiobooks/scifi/Author/Title', [specific, broad])).toBe('/media/scifi/Author/Title');
    // The broad mapping still owns everything the specific one does not cover.
    expect(applyPathMappings('/audiobooks/fantasy/Author/Title', [broad, specific])).toBe('/books/fantasy/Author/Title');
  });

  it('applyPathMappings skips a mapping whose prefix normalizes to empty, returning the raw input', () => {
    // THE TRAP ABS GUARDS AGAINST: `/` matches every absolute path, but normalizes to '' here and is
    // skipped, so the caller gets back an untranslated ABS path that looks like a mapped one.
    expect(applyPathMappings('/audiobooks/Author/Title', [{ sourcePrefix: '/', targetPrefix: '/books' }])).toBe('/audiobooks/Author/Title');
    expect(applyPathMappings('/audiobooks/Author/Title', [{ sourcePrefix: '/audiobooks', targetPrefix: '/' }])).toBe('/audiobooks/Author/Title');
    expect(applyPathMappings('/audiobooks/Author/Title', [{ sourcePrefix: '', targetPrefix: '/books' }])).toBe('/audiobooks/Author/Title');
  });

  it('applyPathMappings: a null path stays null and an empty mapping list changes nothing', () => {
    expect(applyPathMappings(null, [{ sourcePrefix: '/audiobooks', targetPrefix: '/books' }])).toBeNull();
    expect(applyPathMappings('/audiobooks/Author/Title', [])).toBe('/audiobooks/Author/Title');
  });

  it('pathMatchesPrefix matches on a path boundary or an exact equality, never a bare string prefix', () => {
    expect(pathMatchesPrefix('/books/Author/Title', '/books')).toBe(true);
    expect(pathMatchesPrefix('/books', '/books')).toBe(true);
    expect(pathMatchesPrefix('/books-archive/Author', '/books')).toBe(false);
    expect(pathMatchesPrefix('/other/Author', '/books')).toBe(false);
  });

  it('pathMatchesPrefix does NOT normalize a trailing slash on the prefix (unlike applyPathMappings)', () => {
    // ABS canonicalizes its own prefixes before calling this precisely because of this asymmetry.
    expect(pathMatchesPrefix('/books/Author/Title', '/books/')).toBe(false);
    expect(pathMatchesPrefix('/books/', '/books/')).toBe(true);
  });

  it('pathMatchesPrefix treats "/" as matching every absolute path and no relative one', () => {
    expect(pathMatchesPrefix('/anything/at/all', '/')).toBe(true);
    expect(pathMatchesPrefix('/', '/')).toBe(true);
    expect(pathMatchesPrefix('relative/path', '/')).toBe(false);
  });
});

describe('upstream contract: isDecodableImage cover gate (ABS sidecar cover handler)', () => {
  // A real, minimal 1x1 PNG (independent bytes, not produced by the same encoder under test).
  const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  it('a real image buffer decodes -> true', async () => {
    await expect(isDecodableImage(VALID_PNG)).resolves.toBe(true);
  });

  it('a garbage/text buffer -> false', async () => {
    await expect(isDecodableImage(Buffer.from('this is not an image, just plain text'))).resolves.toBe(false);
  });

  it('an empty buffer -> false', async () => {
    await expect(isDecodableImage(Buffer.alloc(0))).resolves.toBe(false);
  });
});
