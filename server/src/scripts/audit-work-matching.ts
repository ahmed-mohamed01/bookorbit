/**
 * Phase 0 audit for the works model: read-only. For every book in the user's libraries, finds the
 * best counterpart of each other variant type (ebook, audiobook, read-along) and the best duplicate
 * of the same type, scores them with the matcher the link panel uses, and buckets the result so the
 * thresholds can be checked against a real library before anything auto-links.
 *
 *   cd server && pnpm audit:work-matching -- --user 1 [--out audit.json] [--strong 0.92] [--weak 0.8]
 *
 * Never writes to the database. The report goes to stdout, the full candidate list to --out.
 */
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';

import { normalizeIsbn, normalizeName, scoreAuthors, scoreTitle, titleVolumeConflict } from '../common/utils/fuzzy-match.utils';
import { seriesVolumeConflict } from '../common/utils/series-volume.utils';

const AUDIO_FORMATS = new Set(['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac']);
const TEXT_FORMATS = new Set(['epub', 'kepub', 'mobi', 'azw3', 'azw', 'pdf', 'fb2', 'txt']);
const MIN_AUTHOR_SCORE = 0.75;
const DIFFERENT_WORK_WORDS = /\b(abridged|dramati[sz]ed|graphic novel|illustrated edition|excerpt|sampler|study guide|summary)\b/i;

type VariantType = 'text' | 'audio' | 'readAlong';
type Bucket = 'linked_ok' | 'linked_suspect' | 'conflict' | 'strong' | 'weak' | 'none' | 'different_work';

interface BookRow {
  id: number;
  libraryId: number;
  libraryName: string;
  title: string;
  subtitle: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  language: string | null;
  isbn: string | null;
  authors: string[];
  formats: string[];
  type: VariantType;
  readAlong: boolean;
}

interface Candidate {
  bookId: number;
  title: string;
  library: string;
  formats: string[];
  score: number;
  titleScore: number;
  authorScore: number;
  isbnMatch: boolean;
  volumeConflict: boolean;
  languageConflict: boolean;
}

interface Pairing {
  source: number;
  sourceTitle: string;
  sourceType: VariantType;
  targetType: VariantType | 'duplicate';
  bucket: Bucket;
  linkedTo: number | null;
  best: Candidate | null;
  reason: string;
}

interface Thresholds {
  strong: number;
  weak: number;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function typeOf(formats: string[], readAlong: boolean): VariantType {
  if (readAlong) return 'readAlong';
  if (formats.some((format) => AUDIO_FORMATS.has(format))) return 'audio';
  return 'text';
}

function workKey(book: BookRow): string {
  const author = book.authors[0] ? normalizeName(book.authors[0]).split(' ').slice(-1)[0] : '';
  return `${author}|${normalizeName(book.title).split(' ').slice(0, 2).join(' ')}`;
}

function score(source: BookRow, target: BookRow): Candidate {
  const placedSource = { title: source.title, seriesName: source.seriesName, seriesIndex: source.seriesIndex };
  const placedTarget = { title: target.title, seriesName: target.seriesName, seriesIndex: target.seriesIndex };
  const volumeConflict = titleVolumeConflict(source.title, target.title) || seriesVolumeConflict(placedSource, placedTarget);
  const isbnMatch = Boolean(source.isbn && target.isbn && source.isbn === target.isbn);
  const titleScore = volumeConflict ? 0 : scoreTitle(source.title, target.title);
  const authorScore = scoreAuthors(source.authors, target.authors);
  const languageConflict = Boolean(source.language && target.language && normalizeName(source.language) !== normalizeName(target.language));
  const comparable = source.authors.length > 0 && target.authors.length > 0;
  let total = comparable ? titleScore * 0.7 + authorScore * 0.3 : titleScore;
  if (isbnMatch) total = Math.max(total, 0.99);
  if (comparable && authorScore < MIN_AUTHOR_SCORE && !isbnMatch) total = 0;
  if (languageConflict) total = 0;
  return {
    bookId: target.id,
    title: target.title,
    library: target.libraryName,
    formats: target.formats,
    score: Number(total.toFixed(3)),
    titleScore: Number(titleScore.toFixed(3)),
    authorScore: Number(authorScore.toFixed(3)),
    isbnMatch,
    volumeConflict,
    languageConflict,
  };
}

async function main(): Promise<void> {
  const userId = Number(arg('user'));
  if (!Number.isInteger(userId)) throw new Error('--user <id> is required');
  const thresholds: Thresholds = { strong: Number(arg('strong', '0.92')), weak: Number(arg('weak', '0.8')) };
  const out = arg('out');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  try {
    const books = await loadBooks(client);
    const links = await loadLinks(client);
    const abs = await loadAbsStates(client, userId);
    const dismissed = await loadDismissals(client, userId);
    const attempts = await loadAttemptCounts(client, userId);

    const byKey = new Map<string, BookRow[]>();
    for (const book of books) {
      const key = workKey(book);
      const bucket = byKey.get(key) ?? [];
      bucket.push(book);
      byKey.set(key, bucket);
    }

    const pairings: Pairing[] = [];
    const claims = new Map<string, number[]>();
    for (const source of books) {
      // Blocking on author surname + first two title words keeps this O(n * bucket) instead of n^2.
      const pool = (byKey.get(workKey(source)) ?? []).filter((target) => target.id !== source.id);
      const targetTypes: (VariantType | 'duplicate')[] = ['text', 'audio', 'readAlong', 'duplicate'].filter((type) => type !== source.type) as (
        VariantType | 'duplicate'
      )[];
      for (const targetType of targetTypes) {
        const wanted = targetType === 'duplicate' ? source.type : targetType;
        const candidates = pool
          .filter((target) => target.type === wanted && !dismissed.has(pairKey(source.id, target.id)))
          .map((target) => score(source, target))
          .sort((left, right) => right.score - left.score);
        const best = candidates[0] ?? null;
        const linkedTo = targetType === 'duplicate' ? null : (links.get(source.id)?.[targetType] ?? null);
        pairings.push(classify(source, targetType, best, linkedTo, thresholds));
        if (best && best.score >= thresholds.strong && targetType !== 'duplicate') {
          const key = `${targetType}:${best.bookId}`;
          claims.set(key, [...(claims.get(key) ?? []), source.id]);
        }
      }
    }

    // One target claimed by two sources of the same type is a conflict unless they are duplicates
    // of each other (same type, strong mutual match), which the works model allows.
    for (const pairing of pairings) {
      if (pairing.bucket !== 'strong' || !pairing.best || pairing.targetType === 'duplicate') continue;
      const claimants = claims.get(`${pairing.targetType}:${pairing.best.bookId}`) ?? [];
      if (claimants.length <= 1) continue;
      const mutualDuplicates = claimants.every((id) =>
        pairings.some(
          (other) =>
            other.source === id &&
            other.targetType === 'duplicate' &&
            other.best &&
            claimants.includes(other.best.bookId) &&
            other.bucket === 'strong',
        ),
      );
      if (!mutualDuplicates) {
        pairing.bucket = 'conflict';
        pairing.reason = `also claimed by ${claimants.filter((id) => id !== pairing.source).join(', ')}`;
      }
    }

    report(books, pairings, abs, attempts, thresholds);
    if (out) {
      writeFileSync(out, JSON.stringify({ thresholds, pairings, abs: [...abs.values()] }, null, 2));
      console.log(`\nFull candidate list written to ${out}`);
    }
  } finally {
    await client.end();
  }
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function classify(source: BookRow, targetType: VariantType | 'duplicate', best: Candidate | null, linkedTo: number | null, t: Thresholds): Pairing {
  const base = { source: source.id, sourceTitle: source.title, sourceType: source.type, targetType, linkedTo, best };
  if (linkedTo !== null) {
    if (best && best.bookId === linkedTo && best.score >= t.weak) return { ...base, bucket: 'linked_ok', reason: `linked, score ${best.score}` };
    if (best && best.bookId === linkedTo) return { ...base, bucket: 'linked_suspect', reason: `linked but score only ${best.score}` };
    return {
      ...base,
      bucket: 'linked_suspect',
      reason: best ? `linked to ${linkedTo} but ${best.bookId} scores ${best.score}` : 'linked, no candidate found',
    };
  }
  if (!best) return { ...base, bucket: 'none', reason: 'no candidate in block' };
  if (DIFFERENT_WORK_WORDS.test(best.title) !== DIFFERENT_WORK_WORDS.test(source.title) || best.languageConflict) {
    return {
      ...base,
      bucket: 'different_work',
      reason: best.languageConflict ? 'language differs' : 'edition word differs (abridged, graphic novel...)',
    };
  }
  if (best.volumeConflict) return { ...base, bucket: 'different_work', reason: 'different volume of the series' };
  if (best.score >= t.strong)
    return { ...base, bucket: 'strong', reason: best.isbnMatch ? 'isbn match' : `title ${best.titleScore} author ${best.authorScore}` };
  if (best.score >= t.weak) return { ...base, bucket: 'weak', reason: `title ${best.titleScore} author ${best.authorScore}` };
  return { ...base, bucket: 'none', reason: `best only ${best.score}` };
}

function report(books: BookRow[], pairings: Pairing[], abs: Map<number, AbsState>, attempts: Map<number, AttemptCounts>, t: Thresholds): void {
  const count = (predicate: (pairing: Pairing) => boolean) => pairings.filter(predicate).length;
  const byType = (type: VariantType) => books.filter((book) => book.type === type).length;
  console.log(`Books: ${books.length} (text ${byType('text')}, audio ${byType('audio')}, read-along ${byType('readAlong')})`);
  console.log(`Thresholds: strong >= ${t.strong}, weak >= ${t.weak}\n`);

  const buckets: Bucket[] = ['linked_ok', 'linked_suspect', 'conflict', 'strong', 'weak', 'different_work', 'none'];
  const targets: (VariantType | 'duplicate')[] = ['text', 'audio', 'readAlong', 'duplicate'];
  console.log(['bucket'.padEnd(16), ...targets.map((target) => target.padStart(10))].join(''));
  for (const bucket of buckets) {
    const cells = targets.map((target) => String(count((pairing) => pairing.bucket === bucket && pairing.targetType === target)).padStart(10));
    console.log([bucket.padEnd(16), ...cells].join(''));
  }

  const show = (bucket: Bucket, limit: number) => {
    const rows = pairings.filter((pairing) => pairing.bucket === bucket);
    if (rows.length === 0) return;
    console.log(`\n${bucket} (${rows.length}, showing ${Math.min(limit, rows.length)}):`);
    for (const row of rows.slice(0, limit)) {
      const target = row.best
        ? `-> #${row.best.bookId} "${row.best.title}" [${row.best.formats.join(',')}] ${row.best.library} score=${row.best.score}`
        : '';
      console.log(`  #${row.source} "${row.sourceTitle}" (${row.sourceType} -> ${row.targetType}) ${target} :: ${row.reason}`);
    }
  };
  show('linked_suspect', 30);
  show('conflict', 30);
  show('weak', 40);
  show('strong', 15);

  const absLinked = [...abs.values()].filter((state) => state.bookId !== null);
  const absUnlinked = abs.size - absLinked.length;
  const lowConfidence = absLinked.filter((state) => state.matchConfidence !== null && state.matchConfidence < t.weak).length;
  console.log(
    `\nAudiobookshelf: ${abs.size} items, ${absLinked.length} linked, ${absUnlinked} unlinked, ${lowConfidence} linked below weak threshold, ${
      absLinked.filter((state) => state.needsReview).length
    } flagged needs_review`,
  );

  let migration2026 = 0;
  let absCovered = 0;
  for (const [bookId, counts] of attempts) {
    if (counts.migrationThisYear === 0) continue;
    migration2026 += counts.migrationThisYear;
    const book = books.find((candidate) => candidate.id === bookId);
    if (!book) continue;
    const linkedAudio = pairings.find(
      (pairing) => pairing.source === bookId && pairing.targetType === 'audio' && (pairing.bucket === 'linked_ok' || pairing.bucket === 'strong'),
    );
    const audioId = book.type === 'audio' ? bookId : (linkedAudio?.linkedTo ?? linkedAudio?.best?.bookId ?? null);
    if (audioId !== null && [...abs.values()].some((state) => state.bookId === audioId && state.finished)) absCovered += 1;
  }
  console.log(
    `Migration attempts ending this year: ${migration2026}; ${absCovered} of those books have an Audiobookshelf finish that would replace them`,
  );
}

async function loadBooks(client: Client): Promise<BookRow[]> {
  const result = await client.query<{
    id: number;
    libraryId: number;
    libraryName: string;
    title: string | null;
    subtitle: string | null;
    seriesName: string | null;
    seriesIndex: string | null;
    language: string | null;
    isbn13: string | null;
    isbn10: string | null;
    authors: string[] | null;
    formats: string[] | null;
    readAlong: boolean;
  }>(`
    select b.id, b.library_id as "libraryId", l.name as "libraryName",
           m.title, m.subtitle, m.series_name as "seriesName", m.series_index as "seriesIndex", m.language,
           m.isbn13, m.isbn10,
           (select array_agg(a.name order by ba.display_order) from book_authors ba join authors a on a.id = ba.author_id where ba.book_id = b.id) as authors,
           (select array_agg(distinct lower(f.format)) from book_files f where f.book_id = b.id and f.role = 'content' and f.format is not null) as formats,
           exists (select 1 from storyteller_read_along_builds rb where rb.output_book_id = b.id) as "readAlong"
    from books b
    join libraries l on l.id = b.library_id
    left join book_metadata m on m.book_id = b.id
    where b.status = 'present'
  `);
  return result.rows
    .filter((row) => row.formats && row.formats.length > 0)
    .map((row) => {
      const formats = (row.formats ?? []).filter((format) => AUDIO_FORMATS.has(format) || TEXT_FORMATS.has(format));
      return {
        id: row.id,
        libraryId: row.libraryId,
        libraryName: row.libraryName,
        title: row.title ?? '',
        subtitle: row.subtitle,
        seriesName: row.seriesName,
        seriesIndex: row.seriesIndex,
        language: row.language,
        isbn: normalizeIsbn(row.isbn13) ?? normalizeIsbn(row.isbn10),
        authors: row.authors ?? [],
        formats,
        type: typeOf(formats, row.readAlong),
        readAlong: row.readAlong,
      };
    });
}

type LinkMembers = Partial<Record<VariantType, number>>;

async function loadLinks(client: Client): Promise<Map<number, LinkMembers>> {
  const links = new Map<number, LinkMembers>();
  const exists = await client.query<{ name: string | null }>(`select to_regclass('public.book_edition_links')::text as name`);
  if (!exists.rows[0]?.name) return links;
  const result = await client.query<{ text: number | null; audio: number | null; readAlong: number | null }>(
    `select text_book_id as text, audio_book_id as audio, read_along_book_id as "readAlong" from book_edition_links`,
  );
  for (const row of result.rows) {
    const members: LinkMembers = {};
    if (row.text !== null) members.text = row.text;
    if (row.audio !== null) members.audio = row.audio;
    if (row.readAlong !== null) members.readAlong = row.readAlong;
    for (const id of Object.values(members)) links.set(id, members);
  }
  return links;
}

interface AbsState {
  absLibraryItemId: string;
  absTitle: string | null;
  bookId: number | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  needsReview: boolean;
  finished: boolean;
}

async function loadAbsStates(client: Client, userId: number): Promise<Map<string, AbsState>> {
  const states = new Map<string, AbsState>();
  const exists = await client.query<{ name: string | null }>(`select to_regclass('public.audiobookshelf_book_state')::text as name`);
  if (!exists.rows[0]?.name) return states;
  const result = await client.query<AbsState>(
    `
    select s.abs_library_item_id as "absLibraryItemId", s.abs_title as "absTitle", s.book_id as "bookId",
           s.match_method as "matchMethod", s.match_confidence as "matchConfidence", s.needs_review as "needsReview",
           exists (
             select 1 from reading_attempts ra
             where ra.user_id = s.user_id and ra.book_id = s.book_id and ra.origin = 'audiobookshelf' and ra.outcome = 'completed' and ra.deleted_at is null
           ) as finished
    from audiobookshelf_book_state s
    where s.user_id = $1 and s.manual_unlinked = false
  `,
    [userId],
  );
  for (const row of result.rows) states.set(row.absLibraryItemId, row);
  return states;
}

async function loadDismissals(client: Client, userId: number): Promise<Set<string>> {
  const result = await client.query<{ a: number; b: number }>(
    `select book_id_a as a, book_id_b as b from book_duplicate_dismissals where user_id = $1`,
    [userId],
  );
  return new Set(result.rows.map((row) => pairKey(row.a, row.b)));
}

interface AttemptCounts {
  migrationThisYear: number;
}

async function loadAttemptCounts(client: Client, userId: number): Promise<Map<number, AttemptCounts>> {
  const result = await client.query<{ bookId: number; migrationThisYear: string }>(
    `
    select book_id as "bookId", count(*) as "migrationThisYear"
    from reading_attempts
    where user_id = $1 and origin = 'migration' and outcome = 'completed' and deleted_at is null
      and ended_on >= date_trunc('year', current_date)
    group by book_id
  `,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.bookId, { migrationThisYear: Number(row.migrationThisYear) }]));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
