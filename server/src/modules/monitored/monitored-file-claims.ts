import { isAudioFormat, isComicFormat, type MonitoredFormat, type MonitoredWork } from '@bookorbit/types';

import { COLLECTION_TITLE_PATTERN, GRAPHIC_NOVEL_TITLE_PATTERN } from './reconcile/work-shape';

/**
 * Which library file belongs to which catalog work.
 *
 * Every work picks its best library book on its own, so without this pass one file was owned by
 * several works at once: a "Stormlight Archive Bundle" and the real "Words of Radiance" both held
 * the Words of Radiance epub, and a Spanish Steelheart held the English Steelheart files. Here:
 *
 * - a pair whose shapes cannot be the same book (a bundle and one of its parts, a split part and the
 *   whole book, a comic and a reflowable epub) is never considered at all;
 * - every remaining automatic claim is scored, and each book's format goes to one work only;
 * - a work that loses a book falls through to its next best one.
 *
 * Manual links never pass through here, so the owner can still point one file at several works.
 */

export interface ClaimCandidate {
  bookId: number;
  title: string;
  titleKey: string;
  seriesName: string | null;
  seriesIndex: string | null;
  publishedYear: number | null;
  formats: Set<string>;
  language?: string | null;
  fixedLayoutFormats?: Set<string>;
}

export interface ScoredClaimInput {
  candidate: ClaimCandidate;
  tier: number;
}

export type ClaimWork = Pick<MonitoredWork, 'title' | 'seriesName' | 'seriesIndex' | 'releaseYear' | 'flags' | 'kind' | 'userKind'>;

export type ShapeConflict =
  'collection_part' | 'collection_file' | 'split_part' | 'language' | 'dramatized_file' | 'comic_format' | 'prose_format' | 'audio_only';

/** The two title spellings each side can be named by, so the gates can tell "named after" from "contains". */
export interface TitleKeyReader {
  (title: string, options: { withColonFront: boolean }): string[];
}

/** The work's kind as the owner left it: their mark when they set one, else the reconciler's. */
export function effectiveWorkKind(work: Pick<MonitoredWork, 'kind' | 'userKind'>): string | null {
  if (work.userKind === 'book') return null;
  return work.userKind ?? work.kind ?? null;
}

const PART_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

const OF_PART_PATTERN = /\(\s*(\d+)\s+of\s+\d+\s*\)/i;
const BRACKETED_PART_PATTERN = /[([]\s*(?:part|pt\.?)\s+(\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+of\s+[^)\]]+)?\s*[)\]]/i;
const TRAILING_BRACKETS_PATTERN = /\s*[([][^)\]]*[)\]]\s*$/;
const TRAILING_PART_PATTERN = /(?:^|[\s,:;-])(?:part|pt\.?)\s+(\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+of\s+\S+)?\s*$/i;

/** The part number a split volume names ("Words of Radiance, Part One", "(3 of 5)"), or null for a whole book. */
export function splitPartOf(title: string): string | null {
  const ofPart = OF_PART_PATTERN.exec(title);
  if (ofPart) return String(Number(ofPart[1]));
  const bracketed = BRACKETED_PART_PATTERN.exec(title);
  if (bracketed) return partNumber(bracketed[1]);
  let trimmed = title.trim();
  for (let previous = ''; previous !== trimmed;) {
    previous = trimmed;
    trimmed = trimmed.replace(TRAILING_BRACKETS_PATTERN, '').trim();
  }
  const match = TRAILING_PART_PATTERN.exec(trimmed);
  return match ? partNumber(match[1]) : null;
}

function partNumber(raw: string): string {
  const value = raw.toLowerCase();
  return PART_WORDS[value] ?? String(Number(value));
}

/** What a file's language tag says: English, another language, or nothing usable (missing, undetermined, mixed). */
export function fileLanguage(language: string | null | undefined): 'english' | 'other' | 'unknown' {
  const tags = (language ?? '')
    .split(/[,;/|]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag && !/^(?:und|mul|zxx)$/i.test(tag));
  if (tags.length === 0) return 'unknown';
  const english = tags.map((tag) => /^(?:en|eng|english)(?:[-_].*)?$/i.test(tag));
  if (english.every(Boolean)) return 'english';
  if (!english.some(Boolean)) return 'other';
  return 'unknown';
}

function languageFits(work: ClaimWork, candidate: ClaimCandidate): boolean {
  const language = fileLanguage(candidate.language);
  if (language === 'unknown') return true;
  return work.flags.includes('foreign_language') ? language === 'other' : language === 'english';
}

/**
 * The claims whose file is in the work's language, when there are any. The per-work pick knows
 * nothing of language, so without this an English work beside a Spanish and an English copy of its
 * book would take whichever copy had the lower id.
 */
export function preferLanguageFit<C extends ScoredClaimInput>(work: ClaimWork, claims: C[]): C[] {
  const fitting = claims.filter((claim) => languageFits(work, claim.candidate));
  return fitting.length > 0 ? fitting : claims;
}

function isGraphicWork(work: ClaimWork): boolean {
  if (work.userKind === 'book') return false;
  return effectiveWorkKind(work) === 'graphic_novel' || GRAPHIC_NOVEL_TITLE_PATTERN.test(work.title);
}

const DRAMATIZED_FILE_PATTERN = /dramatized adaptation|graphic ?audio/i;

/** A title naming one numbered book of a series ("The Grisha Trilogy Book 1") is that book, not the set. */
const SINGLE_SERIES_BOOK_PATTERN = /(?:\bbook|\bbk\.?|#|\bvol(?:ume)?\.?)\s*\d+(?:\.\d+)?\s*[)\]]?\s*$/i;

function looksLikeCollectionFile(title: string): boolean {
  return COLLECTION_TITLE_PATTERN.test(title) && !SINGLE_SERIES_BOOK_PATTERN.test(title);
}

function isCollectionWork(work: ClaimWork): boolean {
  const kind = effectiveWorkKind(work);
  return kind === 'collection' || kind === 'anthology';
}

/**
 * True when one title is named after the other: a full title on one side equals the full title or
 * the text before the colon on the other. "Arcanum Unbounded" names "Arcanum Unbounded: The Cosmere
 * Collection"; "Words of Radiance" does not name "The Stormlight Archive Bundle: Words of Radiance
 * Part One, ...", it only sits inside it.
 */
export function namedAfter(workTitle: string, fileTitle: string, keys: TitleKeyReader): boolean {
  const intersects = (left: string[], right: string[]) => {
    const set = new Set(right);
    return left.some((key) => set.has(key));
  };
  return (
    intersects(keys(workTitle, { withColonFront: true }), keys(fileTitle, { withColonFront: false })) ||
    intersects(keys(workTitle, { withColonFront: false }), keys(fileTitle, { withColonFront: true }))
  );
}

/**
 * Why a work and a library book cannot be the same thing whatever their titles say, or null. These
 * only fire on what the book actually shows: a file with no language tag or no collection wording is
 * left to the score.
 */
export function bookShapeConflict(work: ClaimWork, candidate: ClaimCandidate, keys: TitleKeyReader): ShapeConflict | null {
  const workCollection = isCollectionWork(work);
  const fileCollection = looksLikeCollectionFile(candidate.title);
  if (workCollection !== fileCollection && !namedAfter(work.title, candidate.title, keys)) {
    return workCollection ? 'collection_part' : 'collection_file';
  }

  const workPart = splitPartOf(work.title) ?? (effectiveWorkKind(work) === 'split_part' ? '?' : null);
  const filePart = splitPartOf(candidate.title);
  if ((workPart === null) !== (filePart === null)) return 'split_part';
  if (workPart !== null && workPart !== '?' && workPart !== filePart) return 'split_part';

  if (work.flags.includes('foreign_language') && fileLanguage(candidate.language) === 'english') return 'language';
  if (effectiveWorkKind(work) !== 'dramatization' && DRAMATIZED_FILE_PATTERN.test(candidate.title)) return 'dramatized_file';
  return null;
}

/** Why one file format of a book cannot back the work, or null. */
export function fileFormatConflict(work: ClaimWork, candidate: ClaimCandidate, format: string): ShapeConflict | null {
  const lower = format.toLowerCase();
  if (effectiveWorkKind(work) === 'dramatization') return isAudioFormat(lower) ? null : 'audio_only';
  if (isGraphicWork(work)) {
    if (isAudioFormat(lower)) return null;
    const fixedLayoutEpub = (lower === 'epub' || lower === 'kepub') && candidate.fixedLayoutFormats?.has(format) === true;
    return isComicFormat(lower) || lower === 'pdf' || fixedLayoutEpub ? null : 'comic_format';
  }
  return isComicFormat(lower) ? 'prose_format' : null;
}

const TIER_POINTS = [40, 30, 20, 10];

// Collections and dramatizations carry no penalty here: the gates already keep them on files of
// their own shape, and on such a file they are the rightful owner, not a lesser claimant.
const KIND_PENALTY: Record<string, number> = {
  supplemental: -30,
  duplicate: -30,
  format_variant: -20,
  split_part: -10,
};

const FLAG_PENALTY: Record<string, number> = {
  wrong_contributor: -25,
  placeholder: -20,
};

export interface ClaimScoreContext {
  exactTitle: boolean;
  sameSeriesSlot: boolean;
}

/**
 * How strongly a work's claim on a book holds up against another work's claim on the same book. The
 * evidence points say how the book was found; the penalties only matter in a contest, so a bundle or
 * a translation that is the only claimant still keeps its file.
 */
export function scoreClaim(work: ClaimWork, claim: ScoredClaimInput, context: ClaimScoreContext): number {
  let score = TIER_POINTS[claim.tier] ?? 0;
  if (context.exactTitle) score += 15;
  if (context.sameSeriesSlot) score += 15;
  const year = claim.candidate.publishedYear;
  if (work.releaseYear != null && year != null && Math.abs(year - work.releaseYear) <= 1) score += 5;
  const kind = effectiveWorkKind(work);
  if (kind) score += KIND_PENALTY[kind] ?? 0;
  if (kind === 'dramatization' && !DRAMATIZED_FILE_PATTERN.test(claim.candidate.title)) score -= 30;
  for (const flag of work.flags) score += FLAG_PENALTY[flag] ?? 0;
  // A translation only gives way to the original when the file says nothing of its language.
  const language = fileLanguage(claim.candidate.language);
  if (work.flags.includes('foreign_language')) {
    if (language === 'unknown') score -= 35;
  } else if (language === 'other') {
    score -= 25;
  }
  return score;
}

/** How far ahead the winner of a contested book has to be; closer than this and neither work owns it. */
export const CLAIM_MARGIN = 10;

export interface AssignableWork<W, C extends ScoredClaimInput> {
  work: W;
  formatKind: (format: string) => MonitoredFormat;
  /** Every format string this work can claim, with the claims allowed to back it. */
  claimsByFormat: Map<string, C[]>;
  /** Format kinds the owner linked by hand: the link decides, so the matcher does not compete for them. */
  skipKinds: ReadonlySet<MonitoredFormat>;
}

export interface AssignmentResult<W, C> {
  origins: Map<W, Map<string, number>>;
  /** Claims nobody won because two works scored within the margin, per work. */
  contested: Map<W, C[]>;
}

/**
 * Hands each book's format to one work. Works pick their own best book first (`choose`, which keeps
 * the existing namesake rules); a book several works picked goes to the highest score when it leads
 * by the margin, and to nobody when it does not. Losers pick again among the books still free, so a
 * bundle that loses Words of Radiance can still take a file that really is the bundle.
 *
 * `taken` carries books other works hold that this pass cannot see, keyed `bookId|kind`.
 */
export function assignExclusiveClaims<W, C extends ScoredClaimInput>(
  entries: AssignableWork<W, C>[],
  choose: (work: W, claims: C[]) => C | null,
  score: (work: W, claim: C) => number,
  taken: ReadonlySet<string> = new Set(),
): AssignmentResult<W, C> {
  const holder = new Map<string, W | null>([...taken].map((key) => [key, null]));
  const origins = new Map<W, Map<string, number>>(entries.map((entry) => [entry.work, new Map()]));
  const contested = new Map<W, C[]>();
  const keyOf = (bookId: number, kind: MonitoredFormat) => `${bookId}|${kind}`;

  let pending = entries.flatMap((entry) =>
    [...entry.claimsByFormat.keys()].filter((format) => !entry.skipKinds.has(entry.formatKind(format))).map((format) => ({ entry, format })),
  );

  // A work keeps one book per format kind: its epub and its mobi come from the same book, so the
  // stored match (one book id per kind) is the whole of what the work holds.
  const heldKind = new Map<W, Map<MonitoredFormat, number>>();
  type Proposal = { item: (typeof pending)[number]; claim: C; score: number };

  while (pending.length > 0) {
    const picks: Proposal[] = [];
    for (const item of pending) {
      const kind = item.entry.formatKind(item.format);
      const heldBook = heldKind.get(item.entry.work)?.get(kind);
      const free = (item.entry.claimsByFormat.get(item.format) ?? []).filter((claim) => {
        if (heldBook !== undefined) return claim.candidate.bookId === heldBook;
        const key = keyOf(claim.candidate.bookId, kind);
        return !holder.has(key) || holder.get(key) === item.entry.work;
      });
      const pick = choose(item.entry.work, free);
      if (!pick) continue;
      if (heldBook !== undefined) {
        origins.get(item.entry.work)!.set(item.format, heldBook);
        continue;
      }
      picks.push({ item, claim: pick, score: score(item.entry.work, pick) });
    }

    // One book per work and kind goes forward each round; the work's other formats of that kind
    // wait and pick again, limited to the book it ends up holding.
    const leadByWorkKind = new Map<string, Proposal>();
    const workIndex = new Map<W, number>(entries.map((entry, index) => [entry.work, index]));
    for (const proposal of picks) {
      const slot = `${workIndex.get(proposal.item.entry.work)}|${proposal.item.entry.formatKind(proposal.item.format)}`;
      const lead = leadByWorkKind.get(slot);
      if (!lead || proposal.score > lead.score || (proposal.score === lead.score && proposal.claim.candidate.bookId < lead.claim.candidate.bookId)) {
        leadByWorkKind.set(slot, proposal);
      }
    }
    const proposals = new Map<string, Proposal[]>();
    const stillPending: typeof pending = [];
    for (const proposal of picks) {
      stillPending.push(proposal.item);
      const kind = proposal.item.entry.formatKind(proposal.item.format);
      const lead = leadByWorkKind.get(`${workIndex.get(proposal.item.entry.work)}|${kind}`)!;
      if (lead.claim.candidate.bookId !== proposal.claim.candidate.bookId) continue;
      const key = keyOf(proposal.claim.candidate.bookId, kind);
      proposals.set(key, [...(proposals.get(key) ?? []), proposal]);
    }

    const settled = new Set<(typeof pending)[number]>();
    for (const [key, group] of proposals) {
      const bestByWork = new Map<W, number>();
      for (const proposal of group) {
        bestByWork.set(proposal.item.entry.work, Math.max(bestByWork.get(proposal.item.entry.work) ?? -Infinity, proposal.score));
      }
      const ranked = [...bestByWork.entries()].sort((left, right) => right[1] - left[1]);
      if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < CLAIM_MARGIN) {
        holder.set(key, null);
        for (const proposal of group) {
          const list = contested.get(proposal.item.entry.work) ?? [];
          if (!list.includes(proposal.claim)) list.push(proposal.claim);
          contested.set(proposal.item.entry.work, list);
        }
        continue;
      }
      const winner = ranked[0][0];
      holder.set(key, winner);
      for (const proposal of group) {
        if (proposal.item.entry.work !== winner) continue;
        const kind = proposal.item.entry.formatKind(proposal.item.format);
        const held = heldKind.get(winner) ?? new Map<MonitoredFormat, number>();
        held.set(kind, proposal.claim.candidate.bookId);
        heldKind.set(winner, held);
        origins.get(winner)!.set(proposal.item.format, proposal.claim.candidate.bookId);
        settled.add(proposal.item);
      }
    }
    pending = stillPending.filter((item) => !settled.has(item));
  }
  return { origins, contested };
}
