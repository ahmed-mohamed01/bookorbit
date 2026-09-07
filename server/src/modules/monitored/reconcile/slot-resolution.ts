import { normalizeText } from './observation-matcher';
import { COLLECTION_TITLE_PATTERN, DRAMATIZED_ADAPTATION_PATTERN } from './work-shape';
import type { MergedWork, Observation } from './observation.types';

/**
 * Slot-aware Hardcover filtering. Title matching is structurally blind to translations with entirely
 * different titles, repackaged omnibuses and rows carrying the series in the title, so the strongest
 * available signal is used instead: there cannot be two Book 1s in one series.
 *
 * Indices, not works, are returned. The caller keeps `merged`, `verdicts` and `previousWorks`
 * positionally aligned, so a filtered array would silently desynchronise them.
 */
export interface SlotResolutionResult {
  /** Drop these before verdicts are assigned; they are never persisted. */
  rejected: Set<number>;
  /** Keep these but demote them to the review tray, where the user can promote them back. */
  hidden: Set<number>;
  /** Short machine-readable reason per decided index, for logging. */
  reasons: Map<number, string>;
}

const HARDCOVER_LIVE_STATUS_ID = 1;
const HARDCOVER_AUTHOR_ROLE_ID = 1;
const CATEGORY_GRAPHIC_NOVEL = 4;
const CATEGORY_COLLECTION = 8;
const CATEGORY_WEB_NOVEL = 9;
const CATEGORY_LIGHT_NOVEL = 10;
/** Hardcover's default "Book" category, which carries no format claim of its own. */
const CATEGORY_BOOK = 1;

// A collection holding no series slot has to earn its place in the default list. Losers only go to
// the review tray and are promotable, so the bar starts high rather than guessing a precise cutoff.
const COLLECTION_READERSHIP_FLOOR = 50;

// Never a primary work: a dramatised retelling, or one instalment of a split audio serialisation.

// Localised repackaging words. A Spanish trilogy collection carries none of the English bundle
// vocabulary, escaped every existing filter, and won a series slot outright.
const FOREIGN_BUNDLE_PATTERN = /\b(trilog[ií]a|trilogia|trilogie|colecci[oó]n|coleccion|cole[cç][aã]o|colecao|sammlung|samling|int[eé]grale)\b/i;

// The shapes that can only ever be repackaging, whatever else the row carries.
const REPACKAGING_TITLE_PATTERN = /\b(box(?:ed)? ?set|complete series|books?\s*\d+\s*[-–—]\s*\d+|\d+[- ]books?\b|trilogy|duology)\b/i;

// The words above plus the ones that can legitimately head a real book: `Arcanum Unbounded: The
// Cosmere Collection` is the canonical home of several Cosmere novellas. A match therefore only
// routes the row into the collection ladder below, and never rejects it on its own.

/** "The Way of Kings, Part 1", "Wind and Truth, Part 2" - one work sold as two physical volumes. */
/**
 * Publisher boilerplate naming the FORM of the work rather than the work. Two kinds occur, and they
 * have to be told apart because only one of them transfers between authors:
 *
 * - genre boilerplate - "A LitRPG Adventure" rides on 45 different books across the validation set,
 *   "A Progression Fantasy Epic" on 14. The genre word is what makes it recognisable anywhere.
 * - series boilerplate - "A Mistborn Novel", "A Cosmere Novel", "A Stormlight Archive Novella",
 *   "A Completionist Chronicles Short Story". These only ever appear for one author, so the series
 *   name is read from that author's own vocabulary rather than hardcoded.
 *
 * A bare article plus a form word is NOT boilerplate: it strips the real titles "It'll Be An
 * Adventure" and "Failed Hot Dog Story". The only exception is "A Novel"/"A Novella", which carry no
 * identity at all. Anything with a digit, a volume/position word or a repackaging word is refused
 * outright, since those ARE the identity of the book.
 */
const BOILERPLATE_FORM_WORD =
  '(?:short stor(?:y|ies)|novell?as?|novels?|volumes?|comics?|books?|sagas?|tales?|epics?|adventures?|stor(?:y|ies)|romans?)';
const BOILERPLATE_TAIL_PATTERN = new RegExp(`\\s(?:a|an|the|una|un|ein|eine)\\s+((?:[a-z]{2,}\\s+){0,3})(${BOILERPLATE_FORM_WORD})\\s*$`);
/** With no qualifier at all, only these say nothing about which book this is. */
const IDENTITY_FREE_FORM_WORD = /^novell?as?$|^novels?$/;
/** Genre words are author-independent, so unlike a series name they can be listed. */
const GENRE_WORD_PATTERN =
  /\b(?:litrpg|gamelit|isekai|xianxia|wuxia|cultivation|progression|dungeon|portal|grimdark|steampunk|cyberpunk|dystopian|apocalyptic|epic|urban|paranormal|historical|romantic|science|space)\b/;
const IDENTITY_WORD_PATTERN =
  /\d|\b(?:vol|volume|book|part|one|two|three|four|five|six|seven|eight|nine|ten|complete|omnibus|boxed|box|set|bundle|trilogy|duology|annotated|annotations|sampler|sneak|preview|edition|graphic)\b/;
const MAX_BOILERPLATE_TAILS = 3;

const MULTI_AUTHOR_ANTHOLOGY_CREDITS = 5;
const MIN_SERIES_NAME_LENGTH = 4;
const SERIES_NAME_NUMBER_SUFFIX = '(?:\\s+(?:book|vol|volume)?\\s*(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten))?';

/** Matches a whole-word occurrence of the series name plus any number glued to it. */
function seriesNameStripper(canonicalName: string): RegExp {
  return new RegExp(`(?:^|\\s)${canonicalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${SERIES_NAME_NUMBER_SUFFIX}(?=\\s|$)`);
}

const SUBTITLE_SEPARATOR_PATTERN = /[:\u2014\u2013]/;
/**
 * A parallel re-edition of prose the author already published. Hardcover's category is unreliable
 * here - `The Primal Hunter (Light Novel), Vol. 2` is tagged plain Book - but the parenthesised
 * label in the title or the series name is put there by librarians for exactly this purpose. Graphic
 * novels are deliberately absent: those are separate works, handled by the prose-rival test below.
 */
const FORMAT_VARIANT_LABEL_PATTERN = /\((?:light|web)\s+novel\b[^)]*\)|\(manga\b[^)]*\)/i;
const SPLIT_PART_PATTERN = /^(?<parent>.*\S)[,:]?\s*\(?\bpart\s+(?:\d{1,2}|one|two|three|four|five|six)\b\)?\s*$/i;

const SERIES_LEADING_ARTICLE_PATTERN = /^(?:the|a|an) /;
const SERIES_GENERIC_TAIL_PATTERN = / (?:saga|series|cycle|trilogy|sequence)$/;

/** B1 rejects a row on its own record rather than on its place in the catalog. */
const STRUCTURAL_REJECT_REASONS = new Set(['status', 'contributor_role', 'adaptation', 'foreign_bundle']);

// ---------------------------------------------------------------------------
// Raw Hardcover field access
// ---------------------------------------------------------------------------

/**
 * The fields below reach us on `Observation.raw` (the raw Hardcover book) rather than as typed
 * `Observation` fields, the same escape hatch `compilation` already uses. Fixtures captured before
 * the GraphQL selection grew do not carry them, so absent always means "unknown" and never rejects.
 */
interface HardcoverSignals {
  statusIds: number[];
  roleIds: number[];
  categoryId: number | null;
  usersRead: number;
  editions: number;
  pages: number;
  /** Author-role credits on the best-read row, NOT unioned across the cluster - see readSignals. */
  authorCredits: number;
  seriesIds: Map<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Hardcover editions of one work, strongest first, so the dominant edition defines its identity. */
function hardcoverObservations(work: MergedWork): Observation[] {
  return work.observations
    .filter((observation) => observation.source === 'hardcover')
    .sort((left, right) => right.popularity - left.popularity || left.id.localeCompare(right.id));
}

/** Hardcover leaves `contribution` null for the author and names every other role ("Reader"...). */
function countAuthorCredits(cachedContributors: unknown): number {
  const credits = new Set<string>();
  for (const entry of Array.isArray(cachedContributors) ? cachedContributors : []) {
    const record = asRecord(entry);
    const role = record.contribution;
    if (role != null && !(typeof role === 'string' && /^author/i.test(role))) continue;
    const author = asRecord(record.author);
    const id = asNumber(author.id);
    const name = typeof author.name === 'string' ? author.name : null;
    const key = id != null ? `id:${id}` : name ? `name:${name}` : null;
    if (key) credits.add(key);
  }
  return credits.size;
}

function readSignals(work: MergedWork): HardcoverSignals {
  const observations = hardcoverObservations(work);
  const statusIds: number[] = [];
  const roleIds: number[] = [];
  const categoryIds: number[] = [];
  const seriesIds = new Map<string, number>();
  let usersRead = 0;
  let editions = 0;
  let pages = 0;
  let authorCredits = 0;
  let bestReadUsers = -1;

  for (const observation of observations) {
    const raw = asRecord(observation.raw);
    const status = asNumber(asRecord(raw.book_status).id);
    if (status != null) statusIds.push(status);
    const role = asNumber(raw.contributor_role_id);
    if (role != null) roleIds.push(role);
    const category = asNumber(raw.book_category_id);
    if (category != null) categoryIds.push(category);
    usersRead = Math.max(usersRead, asNumber(raw.users_read_count) ?? 0);
    editions = Math.max(editions, asNumber(raw.editions_count) ?? 0);
    pages = Math.max(pages, asNumber(raw.pages) ?? 0);
    // Author credits are read off ONE representative row - the best-read edition - never unioned
    // across the cluster. Every translation credits its own translator as an author, so a union
    // pushes major novels into anthology territory: The Alloy of Law reaches 11 that way.
    const users = asNumber(raw.users_count) ?? 0;
    if (users > bestReadUsers) {
      bestReadUsers = users;
      authorCredits = countAuthorCredits(raw.cached_contributors);
    }
    for (const entry of Array.isArray(raw.book_series) ? raw.book_series : []) {
      const series = asRecord(asRecord(entry).series);
      const id = asNumber(series.id);
      const name = typeof series.name === 'string' ? series.name : null;
      if (id == null || !name?.trim()) continue;
      const key = seriesNameKey(name);
      if (key && !seriesIds.has(key)) seriesIds.set(key, id);
    }
  }

  return { statusIds, roleIds, categoryId: categoryIds[0] ?? null, usersRead, editions, pages, authorCredits, seriesIds };
}

/** Live unless Hardcover says otherwise: Deleted(3), Deduped(4) and To Review(2) are not books. */
function isStatusOk(signals: HardcoverSignals): boolean {
  return signals.statusIds.length === 0 || signals.statusIds.includes(HARDCOVER_LIVE_STATUS_ID);
}

/** By role id, not the role string, so the check survives Hardcover's localised role names. */
function isAuthorRole(signals: HardcoverSignals): boolean {
  return signals.roleIds.length === 0 || signals.roleIds.includes(HARDCOVER_AUTHOR_ROLE_ID);
}

// ---------------------------------------------------------------------------
// Series names and slots
// ---------------------------------------------------------------------------

/** Collapse punctuation and "versus" so Hardcover's two spellings of one series share a key. */
function seriesNameKey(name: string): string {
  return normalizeText(name).replace(/\bversus\b/g, 'vs');
}

/**
 * The form a title-derived guess is matched against: a leading article and ONE trailing generic noun
 * carry no identity, but everything else does. A colon-qualified sub-series is a DIFFERENT series -
 * `Mistborn: Ghostbloods` must never answer to a bare "Mistborn" guess - so the rest of the name is
 * kept whole and never matched by word containment.
 */
function canonicalSeriesName(name: string): string {
  return normalizeText(name).replace(SERIES_LEADING_ARTICLE_PATTERN, '').replace(SERIES_GENERIC_TAIL_PATTERN, '').trim();
}

/**
 * Number('') is 0, so a blank index would invent a shared slot 0 that unrelated books land in. A
 * missing index is unknown, never zero.
 */
function numericPosition(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '' || /[-–—,]/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * INTEGER positions from 1 up. Fractional slots are where librarians park novellas, interquels and
 * anthology pieces: `Mountain Masters #1.5` holds two different contributions and `Shikar #0.5`
 * holds two volumes of one anthology, so contesting them produces wrong rejections. Position 0 is
 * the same parking spot for a work merely related to a series, and every one of the 8 contested
 * zero slots across the validation set pits unrelated anthologies against each other - four separate
 * Unfettered volumes at `Annwn Cycle #0`, six anthologies and magazines at `Tales of the Apt #0`.
 */
function integerPosition(value: string | null | undefined): number | null {
  const parsed = numericPosition(value);
  return parsed != null && Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

interface SeriesEntry {
  name: string;
  index: string | null;
}

function seriesEntries(work: MergedWork): SeriesEntry[] {
  const entries: SeriesEntry[] = [...(work.seriesMemberships ?? [])];
  if (work.seriesName) entries.push({ name: work.seriesName, index: work.seriesIndex });
  return entries.filter((entry) => Boolean(entry.name?.trim()));
}

/** A membership at ANY position, fractional included. B3a's guard turns on this, B2 does not. */
function holdsAnySeriesPosition(work: MergedWork): boolean {
  return seriesEntries(work).some((entry) => numericPosition(entry.index) != null);
}

function hasAnySeriesMembership(work: MergedWork): boolean {
  return seriesEntries(work).length > 0;
}

interface SlotClaim {
  work: number;
  slot: string;
  seriesKey: string;
  position: number;
  fromTitle: boolean;
}

// ---------------------------------------------------------------------------
// Title-derived slot claims (B3)
// ---------------------------------------------------------------------------

const TITLE_CLAIM_PATTERNS: RegExp[] = [
  // prefix: "Mistborn 1 - The Final Empire"
  /^(?<series>.+?)[\s,:.\-–—]+(?:book\s*)?(?<position>\d{1,3})\s*[:\-–—]\s+(?<rest>.{3,})$/i,
  // paren: "Rise of the Living Forge (Book 2)"
  /^(?<series>.+?)\s*\((?:book|vol\.?|volume)\s*(?<position>\d{1,3})\)\s*$/i,
  // suffix: "Into the Labyrinth: Mage Errant Book 1"
  /^.+?:\s*(?<series>.+?),?\s+book\s+(?<position>\d{1,3})\s*$/i,
];

/**
 * `Mistborn (Era 2) - Book 1 - The Alloy of Law` names its series with an era qualifier the vocabulary
 * has no entry for. Dropping the parenthetical lets it resolve; the era offset is not modelled, so it
 * lands on Saga #1 rather than Wax & Wayne #1. The row is junk either way, so the rejection is right
 * and only the attribution is wrong: never use the assigned slot for anything but that decision.
 */
function seriesGuess(raw: string): string {
  return canonicalSeriesName(raw.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' '));
}

interface TitleClaim {
  guess: string;
  position: number;
}

function parseTitleClaim(title: string): TitleClaim | null {
  for (const pattern of TITLE_CLAIM_PATTERNS) {
    const groups = pattern.exec(title)?.groups;
    if (!groups) continue;
    const guess = seriesGuess(groups.series ?? '');
    const position = integerPosition(groups.position ?? null);
    if (guess.length < 3 || position == null) continue;
    return { guess, position };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claimant ranking (B2)
// ---------------------------------------------------------------------------

interface Claimant {
  fromTitle: boolean;
  collection: boolean;
  readership: number;
  quality: number;
  editions: number;
  tieBreak: string;
}

function readership(work: MergedWork, signals: HardcoverSignals): number {
  // users_count is the established readership signal; users_read_count only stands in for it on rows
  // where Hardcover reports one and not the other.
  return Math.max(work.popularity.hardcover ?? 0, signals.usersRead);
}

/** How complete Hardcover's record of this book is, used only to separate equally-read claimants. */
function dataQuality(work: MergedWork, signals: HardcoverSignals): number {
  return (work.cover ? 1 : 0) + (work.hasDesc ? 1 : 0) + (signals.pages > 0 ? 1 : 0) + (signals.editions > 1 ? 1 : 0);
}

/**
 * The last tiebreak, and it must not depend on array order or two runs over the same catalog could
 * disagree. `providerWorkIds.hardcover` is a slug ("oathbringer"), never a number, so it is compared
 * as text; the title is the fallback for a work that somehow carries no Hardcover id.
 */
function tieBreak(work: MergedWork): string {
  return work.providerWorkIds.hardcover ?? work.title;
}

/**
 * Real series metadata first, then readership, then data quality, then a stable text tiebreak. A row whose claim was only
 * parsed from its title is missing the metadata the winner has, and that absence is itself a losing
 * signal; it costs nothing on today's data and protects the case where a junk row out-polls the
 * canonical one. Collection-ness sits above readership because B4 requires a collection to lose its
 * slot to a non-collection work whatever the readership - that is what drops the repackaged omnibuses
 * (White Sand Omnibus, Legion: The Many Lives, The First Law Trilogy), all of them high-signal rows.
 */
function compareClaimants(left: Claimant, right: Claimant): number {
  if (left.fromTitle !== right.fromTitle) return left.fromTitle ? 1 : -1;
  if (left.collection !== right.collection) return left.collection ? 1 : -1;
  return (
    right.readership - left.readership ||
    right.quality - left.quality ||
    right.editions - left.editions ||
    left.tieBreak.localeCompare(right.tieBreak)
  );
}

// ---------------------------------------------------------------------------
// Other per-work signals
// ---------------------------------------------------------------------------

/**
 * A work titled after the very series it sits in is describing the whole series rather than one entry
 * in it - `The First Law Trilogy`, `The Hyperion Cantos`, `Worth the Candle`. Two guards keep this
 * honest. Self-naming alone means nothing, since `Skyward`, `Legion` and `Children of Time` are all
 * self-named real books, so it only ever corroborates `compilation`. And the series must be long
 * enough to be worth compiling: in a one- or two-entry series the self-named row is usually the
 * canonical edition and its rival is a retitling or a single issue, so calling it a collection would
 * hand the slot to the weaker row - `The Living Dead` losing to `Zombies`, `The Expanse: Origins`
 * losing to `The Expanse Origins: James Holden`.
 */
const COMPILABLE_SERIES_LENGTH = 3;

function namesItsOwnSeries(work: MergedWork, isCompilableSeries: (name: string) => boolean): boolean {
  const title = canonicalSeriesName(work.title);
  if (title.length < 3) return false;
  return seriesEntries(work).some((entry) => canonicalSeriesName(entry.name) === title && isCompilableSeries(entry.name));
}

/**
 * `compilation` alone is set on both `Axiom` (genuinely Artorian's Archives #1) and `Arcanum
 * Unbounded`, so it only counts when corroborated by the category, a bundle title, the absence of any
 * series position, or the work being named after a series long enough to compile.
 */
function isCollection(work: MergedWork, signals: HardcoverSignals, isCompilableSeries: (name: string) => boolean): boolean {
  if (signals.categoryId === CATEGORY_COLLECTION) return true;
  if (COLLECTION_TITLE_PATTERN.test(work.title)) return true;
  if (!work.compilationFlag) return false;
  return !holdsAnySeriesPosition(work) || namesItsOwnSeries(work, isCompilableSeries);
}

/**
 * A dated upcoming release. Six of the 23 upcoming books across the validation set have a readership
 * of 3 or less and one has none at all, so this branch is exempt from every popularity, quality,
 * cover and readership test below.
 */
function isDatedFuture(work: MergedWork, today: string): boolean {
  const value = work.ebookReleaseDate ?? work.audioReleaseDate;
  if (value == null) return false;
  if (work.unreleased) return true;
  return value.length > 4 ? value >= today : Number(value) >= Number(today.slice(0, 4));
}

/**
 * Everything before the first subtitle separator. Only ever compared inside B3a's guard - see
 * resolveSlots. An em or en dash is used exactly where a colon would be by the same low-quality rows
 * that B3a exists to catch: `Enemy A(n)t the Gates - Chrysalis 5`, `Upping the Ante - Chrysalis,
 * Book 2`, `The Primal Hunter 10 - A LitRPG Adventure`. Treating only the colon as a separator lets
 * every one of them through.
 */
function preColonTitle(title: string, isKnownSeriesName: (text: string) => boolean = () => false): string {
  return stripFormBoilerplate(normalizeText(title.split(SUBTITLE_SEPARATOR_PATTERN)[0]), isKnownSeriesName);
}

/**
 * Repeatedly drops a trailing form phrase. Only ever used to build a duplicate-matching key inside a
 * guarded rule - never to rewrite a title, and never as a general normalisation.
 */
function stripFormBoilerplate(normalized: string, isKnownSeriesName: (text: string) => boolean): string {
  let title = normalized;
  for (let pass = 0; pass < MAX_BOILERPLATE_TAILS; pass++) {
    const match = BOILERPLATE_TAIL_PATTERN.exec(title);
    if (!match || IDENTITY_WORD_PATTERN.test(match[0])) break;
    const qualifier = match[1].trim();
    const qualifies = qualifier ? GENRE_WORD_PATTERN.test(qualifier) || isKnownSeriesName(qualifier) : IDENTITY_FREE_FORM_WORD.test(match[2]);
    if (!qualifies) break;
    const next = title.slice(0, title.length - match[0].length).trim();
    if (next.length < MIN_SERIES_NAME_LENGTH) break;
    title = next;
  }
  return title;
}

// ---------------------------------------------------------------------------

export function resolveSlots(works: MergedWork[], today: string): SlotResolutionResult {
  const rejected = new Set<number>();
  const hidden = new Set<number>();
  const reasons = new Map<number, string>();

  const reject = (index: number, reason: string): void => {
    if (rejected.has(index)) return;
    rejected.add(index);
    reasons.set(index, reason);
  };
  const hide = (index: number, reason: string): void => {
    if (rejected.has(index) || hidden.has(index)) return;
    hidden.add(index);
    reasons.set(index, reason);
  };

  const signals = works.map(readSignals);
  const statusOk = works.map((_, index) => isStatusOk(signals[index]));
  const datedFuture = works.map((work) => isDatedFuture(work, today));

  // Series ids are the stable identity; a normalised name is the fallback where Hardcover omits one.
  const seriesIdByName = new Map<string, number>();
  for (const signal of signals) {
    for (const [name, id] of signal.seriesIds) if (!seriesIdByName.has(name)) seriesIdByName.set(name, id);
  }
  const seriesKeyOf = (name: string): string => {
    const key = seriesNameKey(name);
    const id = seriesIdByName.get(key);
    return id != null ? `id:${id}` : `name:${key}`;
  };

  const occupiedSlots = new Map<string, Set<number>>();
  works.forEach((work, index) => {
    if (!statusOk[index]) return;
    for (const entry of seriesEntries(work)) {
      const position = integerPosition(entry.index);
      if (position == null) continue;
      const key = seriesKeyOf(entry.name);
      const bucket = occupiedSlots.get(key);
      if (bucket) bucket.add(position);
      else occupiedSlots.set(key, new Set([position]));
    }
  });
  const isCompilableSeries = (name: string): boolean => {
    const key = seriesKeyOf(name);
    return key != null && (occupiedSlots.get(key)?.size ?? 0) >= COMPILABLE_SERIES_LENGTH;
  };

  const collections = works.map((work, index) => isCollection(work, signals[index], isCompilableSeries));

  // B1 - hard rejects on the row's own record.
  works.forEach((work, index) => {
    if (!statusOk[index]) reject(index, 'status');
    else if (!isAuthorRole(signals[index])) reject(index, 'contributor_role');
    else if (DRAMATIZED_ADAPTATION_PATTERN.test(work.title)) reject(index, 'adaptation');
    else if (FOREIGN_BUNDLE_PATTERN.test(work.title)) reject(index, 'foreign_bundle');
  });

  // Deliberately no language rule here. assignVerdict already flags a non-Latin title or an
  // all-foreign edition set as `foreign_language`, which hides the work while leaving the owner able
  // to promote it. Rejecting the same rows outright would be redundant and would silently take that
  // choice away. Translations still lose their series slot to the canonical edition below, which is
  // what actually removes them from the default list.

  // B2 - metadata claims. Every (series, position) is an independent contest, so a work holding three
  // slots contests and wins each of them separately.
  const claims: SlotClaim[] = [];
  const metadataSlots = new Map<string, number[]>();
  works.forEach((work, index) => {
    const seen = new Set<string>();
    for (const entry of seriesEntries(work)) {
      const position = integerPosition(entry.index);
      if (position == null) continue;
      const seriesKey = seriesKeyOf(entry.name);
      const slot = `${seriesKey}#${position}`;
      if (seen.has(slot)) continue;
      seen.add(slot);
      claims.push({ work: index, slot, seriesKey, position, fromTitle: false });
      const placed = metadataSlots.get(slot);
      if (placed) placed.push(index);
      else metadataSlots.set(slot, [index]);
    }
  });

  // B3 rule 1 - the series-name vocabulary is built from ALL status-OK rows, BEFORE any filtering.
  // Bundle-filtering the only member of a series erases that series name, and the title parser then
  // stops matching it.
  const vocabulary = new Map<string, Set<string>>();
  const seriesSize = new Map<string, number>();
  works.forEach((work, index) => {
    if (!statusOk[index]) return;
    for (const entry of seriesEntries(work)) {
      const canonical = canonicalSeriesName(entry.name);
      if (canonical.length < 3) continue;
      const seriesKey = seriesKeyOf(entry.name);
      const bucket = vocabulary.get(canonical);
      if (bucket) bucket.add(seriesKey);
      else vocabulary.set(canonical, new Set([seriesKey]));
      seriesSize.set(seriesKey, (seriesSize.get(seriesKey) ?? 0) + 1);
    }
  });

  const slotStrength = (slot: string): number =>
    (metadataSlots.get(slot) ?? []).reduce((best, index) => Math.max(best, readership(works[index], signals[index])), -1);

  works.forEach((work, index) => {
    if (hasAnySeriesMembership(work)) return;
    const parsed = parseTitleClaim(work.title);
    if (!parsed) return;
    // B3 rule 2 - the guess must equal a whole vocabulary entry, never be contained in one.
    const candidates = [...(vocabulary.get(parsed.guess) ?? [])];
    if (candidates.length === 0) return;
    // Several real series can share a canonical name ("Mistborn" and "The Mistborn Saga"). The one
    // whose existing holder at this position is strongest is the series the row is really claiming.
    const seriesKey = candidates.sort(
      (left, right) =>
        slotStrength(`${right}#${parsed.position}`) - slotStrength(`${left}#${parsed.position}`) ||
        (seriesSize.get(right) ?? 0) - (seriesSize.get(left) ?? 0) ||
        left.localeCompare(right),
    )[0];
    claims.push({ work: index, slot: `${seriesKey}#${parsed.position}`, seriesKey, position: parsed.position, fromTitle: true });
  });

  const claimantOf = (claim: SlotClaim): Claimant => ({
    fromTitle: claim.fromTitle,
    collection: collections[claim.work],
    readership: readership(works[claim.work], signals[claim.work]),
    quality: dataQuality(works[claim.work], signals[claim.work]),
    editions: signals[claim.work].editions,
    tieBreak: tieBreak(works[claim.work]),
  });

  // Contests are decided over the surviving rows only: a deleted or misattributed row must not beat
  // a live one, nor count as the rival that makes a slot contested.
  const contests = new Map<string, SlotClaim[]>();
  for (const claim of claims) {
    if (rejected.has(claim.work)) continue;
    const bucket = contests.get(claim.slot);
    if (bucket) bucket.push(claim);
    else contests.set(claim.slot, [claim]);
  }

  const holdsSlot = new Set<number>();
  for (const bucket of contests.values()) {
    const winner = bucket.reduce((best, claim) => (compareClaimants(claimantOf(claim), claimantOf(best)) < 0 ? claim : best));
    holdsSlot.add(winner.work);
    // Losing any slot means the work is a duplicate of the winner. Of 85 books losing a slot across
    // the validation set, exactly one also held another slot outright, and that one was a duplicate
    // anyway - so there is no ratio guard here, and no rescue for a loser that won elsewhere.
    for (const claim of bucket) {
      if (claim.work !== winner.work) reject(claim.work, collections[claim.work] ? 'collection_slot_loser' : 'slot_loser');
    }
  }

  // B3a - a row with NO series membership at all whose pre-colon title exactly equals that of a row
  // holding a series slot is a duplicate of it, whatever the readership ratio. Subtitles are NEVER
  // dropped as a general normalisation: doing so merges The Final Empire with Secret History, the
  // three Legion novellas with each other, and all five Unintended Cultivator volumes. Every one of
  // those groups consists of rows that all carry series metadata, so none of them can be a challenger
  // here. Equality only, never containment: containment absorbs "Trouble on Paradise" into "Paradise"
  // and "The Way of Kings Prime" into "The Way of Kings", which are different books.
  // A pre-colon title claimed by two or more surviving works is not a book title at all - it is a
  // series or imprint name, and everything identifying the individual book lives in the subtitle.
  // `Mistborn:` fronts The Final Empire, Secret History and Collected Tales; `The Year's Best Science
  // Fiction:` fronts five different annuals; `Halo:` fronts Cryptum, Primordium and Silentium. Only a
  // pre-colon title that exactly one work claims can anchor an absorption.
  // "A Mistborn Novel" is boilerplate for Sanderson and meaningless anywhere else, so the series half
  // of the pattern is read from this author's own vocabulary rather than hardcoded. A trailing series
  // name qualifies too: "A Texas Reckoners Novel" ends in the known series "Reckoners".
  const seriesNames = [...vocabulary.keys()].filter((name) => name.length >= MIN_SERIES_NAME_LENGTH);
  const isKnownSeriesName = (text: string): boolean => seriesNames.some((name) => text === name || text.endsWith(` ${name}`));
  const anchorCounts = new Map<string, number>();
  works.forEach((work, index) => {
    if (rejected.has(index) || !holdsAnySeriesPosition(work)) return;
    const title = preColonTitle(work.title, isKnownSeriesName);
    anchorCounts.set(title, (anchorCounts.get(title) ?? 0) + 1);
  });
  works.forEach((work, index) => {
    if (rejected.has(index) || hasAnySeriesMembership(work)) return;
    const title = preColonTitle(work.title, isKnownSeriesName);
    if (title.length >= 3 && anchorCounts.get(title) === 1) reject(index, 'series_less_duplicate');
  });

  // B3b - a series-less row that is just "<Series> <Book title> <genre boilerplate>". Stripping the
  // series name (and any number glued to it) leaves the real book's title, which identifies what the
  // row duplicates: `Chrysalis The Antventure Begins A LitRPG Adventure` is `The Antventure Begins`.
  //
  // The guard that makes this safe is that the series must NOT name its books after itself. In
  // `The Primal Hunter`, `Beware of Chicken` and `Rise of the Living Forge` the position IS the
  // title, so stripping the series name off a legitimate `The Primal Hunter 2` would leave "2" and
  // match nothing - or worse, match a sibling. Across the validation set this guard blocks 67
  // candidate matches and lets through 4, every one a genuine duplicate.
  const slotMembers = new Map<string, number[]>();
  works.forEach((work, index) => {
    if (rejected.has(index)) return;
    for (const entry of seriesEntries(work)) {
      if (integerPosition(entry.index) == null) continue;
      const key = canonicalSeriesName(entry.name);
      const bucket = slotMembers.get(key);
      if (bucket) bucket.push(index);
      else slotMembers.set(key, [index]);
    }
  });
  // Both the stripper regex and the "does this series name its books after itself" test depend only
  // on the series, so they are built once per series rather than once per (work, series) pair.
  const normalizedTitles = works.map((work) => normalizeText(work.title));
  const candidateSeries = [...slotMembers]
    .filter(([key, members]) => key.length >= MIN_SERIES_NAME_LENGTH && !members.some((member) => normalizedTitles[member].startsWith(key)))
    .map(([key, members]) => ({ key, members, stripper: seriesNameStripper(key) }));
  works.forEach((work, index) => {
    if (rejected.has(index) || hasAnySeriesMembership(work)) return;
    const title = normalizedTitles[index];
    for (const { members, stripper } of candidateSeries) {
      if (!stripper.test(title)) continue;
      const rest = title.replace(stripper, ' ').replace(/\s+/g, ' ').trim();
      if (rest.length < MIN_SERIES_NAME_LENGTH) continue;
      const anchor = members.find((member) => {
        const anchorTitle = normalizedTitles[member];
        return rest === anchorTitle || rest.startsWith(`${anchorTitle} `);
      });
      if (anchor != null) {
        reject(index, 'series_prefixed_duplicate');
        return;
      }
    }
  });

  // Split editions. A physically split volume titled "<X>, Part N" duplicates <X> when <X> itself
  // survives with more than twice the readership. Position cannot be the key: these sit at fractional
  // positions (Wind and Truth, Part 1 is Stormlight #5.1) AND at their parent's integer position (The
  // Well of Ascension, Part 1 sits at #2), and the slot contest above deliberately ignores fractional
  // positions. The >2x guard is what stops two comparably-read books that merely share a suffix from
  // collapsing into one.
  const strongestByCore = new Map<string, number>();
  works.forEach((work, index) => {
    if (rejected.has(index)) return;
    const key = normalizeText(work.title);
    const best = strongestByCore.get(key);
    if (best == null || readership(works[best], signals[best]) < readership(work, signals[index])) strongestByCore.set(key, index);
  });
  works.forEach((work, index) => {
    if (rejected.has(index)) return;
    const parent = SPLIT_PART_PATTERN.exec(work.title)?.groups?.parent?.trim();
    if (!parent) return;
    const candidate = strongestByCore.get(normalizeText(parent));
    if (candidate == null || candidate === index) return;
    if (readership(works[candidate], signals[candidate]) > 2 * readership(work, signals[index])) reject(index, 'split_edition');
  });

  // B4 - collections, in this order. Signal applied before slot status would accept every repackaged
  // omnibus, all of which are well read.
  works.forEach((work, index) => {
    if (!collections[index] || rejected.has(index)) return;
    if (holdsSlot.has(index)) return;
    if (REPACKAGING_TITLE_PATTERN.test(work.title)) {
      hide(index, 'collection_repackaging');
      return;
    }
    if (datedFuture[index]) return;
    if (readership(work, signals[index]) >= COLLECTION_READERSHIP_FLOOR && work.cover && work.hasDesc) return;
    hide(index, 'collection_weak');
  });

  // B5 - format variants are hidden, never dropped. Hardcover tags inconsistently WITHIN a series
  // (Mark of the Fool vols 1-3 are Light Novel, vol 4 is plain Book with no series metadata at all),
  // so the tag propagates to siblings whose own category claims nothing. Vol 4's membership comes
  // from its B3 title claim.
  const formatSeries = new Set<string>();
  for (const claim of claims) {
    const category = signals[claim.work].categoryId;
    if (category === CATEGORY_WEB_NOVEL || category === CATEGORY_LIGHT_NOVEL) formatSeries.add(claim.seriesKey);
  }
  const claimedSeries = new Map<number, Set<string>>();
  for (const claim of claims) {
    const bucket = claimedSeries.get(claim.work);
    if (bucket) bucket.add(claim.seriesKey);
    else claimedSeries.set(claim.work, new Set([claim.seriesKey]));
  }
  // The label must be on the work's OWN title. Reading it off a series name instead hides the prose
  // book that Hardcover also filed under the light-novel series - `The Path of Ascension` #1 itself.
  const labelledFormatVariant = (work: MergedWork): boolean => FORMAT_VARIANT_LABEL_PATTERN.test(work.title);
  works.forEach((work, index) => {
    const category = signals[index].categoryId;
    if (category === CATEGORY_WEB_NOVEL || category === CATEGORY_LIGHT_NOVEL || labelledFormatVariant(work)) {
      hide(index, 'format_variant');
      return;
    }
    if (category === CATEGORY_GRAPHIC_NOVEL) return;
    if (category != null && category !== CATEGORY_BOOK) return;
    const claimed = claimedSeries.get(index);
    if (claimed && [...claimed].some((seriesKey) => formatSeries.has(seriesKey))) hide(index, 'format_variant');
  });

  // B6 - a book credited to a crowd of authors is a multi-author anthology, magazine issue or
  // sampler, not a new book by the monitored author. The counts separate cleanly on one representative
  // row: real books sit at 0-2 credits and every anthology in the validation set at 5 or more, with
  // nothing genuine in between. It is HIDDEN rather than dropped, because these do carry original
  // short fiction by the author and the owner can promote them.
  works.forEach((_, index) => {
    if (signals[index].authorCredits >= MULTI_AUTHOR_ANTHOLOGY_CREDITS) hide(index, 'multi_author_anthology');
  });

  // Graphic novels are never dropped by a catalog-shape rule: White Sand Vol. 1/2/3 and Dark One
  // Vol. 1 were published as graphic novels with no prose edition at all, so a slot, collection or
  // duplicate judgement must not erase them. B1's structural rejects still stand - a deleted row or
  // another author's book is not rescued by its format.
  //
  // Whether the survivor is also HIDDEN turns on one question: does a prose work claim the same slot?
  // If so the comic is an adaptation of that novel and belongs in the review tray. If every claimant
  // of its slots is itself a graphic novel, the comic IS the work and hiding it would leave the owner
  // no edition at all. Hardcover tags inconsistently within one comic series - Red Rising: Sons of
  // Ares has issues at Graphic Novel and issues at plain Book - so a category-only rule shows an
  // arbitrary two issues out of eight.
  // The prose rival has to be one that SURVIVES. `White Sand, Book One` is a u=1 row that already lost
  // the slot, and counting it would make White Sand Vol. 1 look like an adaptation of it.
  const adaptsProse = new Set<number>();
  for (const bucket of contests.values()) {
    const live = bucket.filter((claim) => !rejected.has(claim.work));
    if (!live.some((claim) => signals[claim.work].categoryId !== CATEGORY_GRAPHIC_NOVEL)) continue;
    for (const claim of live) if (signals[claim.work].categoryId === CATEGORY_GRAPHIC_NOVEL) adaptsProse.add(claim.work);
  }
  works.forEach((_, index) => {
    if (signals[index].categoryId !== CATEGORY_GRAPHIC_NOVEL) return;
    const reason = reasons.get(index);
    if (rejected.has(index) && reason != null && STRUCTURAL_REJECT_REASONS.has(reason)) return;
    const lifted = rejected.delete(index);
    const alreadyHidden = hidden.has(index);
    if (!lifted && !adaptsProse.has(index) && !alreadyHidden) return;
    hidden.add(index);
    // Keep whatever actually made the call. A comic hidden as a multi-author anthology is still
    // hidden for that reason; overwriting it with a bare `graphic_novel` loses the real cause.
    reasons.set(index, (lifted || alreadyHidden) && reason ? `graphic_novel:${reason}` : 'graphic_novel');
  });

  return { rejected, hidden, reasons };
}
