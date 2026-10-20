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

export type ShapeConflict = 'collection_part' | 'collection_file' | 'split_part' | 'language' | 'comic_format' | 'prose_format' | 'audio_only';

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
const TRAILING_BRACKETS_PATTERN = /\s*[([][^)\]]*[)\]]\s*$/;
const TRAILING_PART_PATTERN = /(?:^|[\s,:;-])(?:part|pt\.?)\s+(\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+of\s+\S+)?\s*$/i;

/** The part number a split volume names ("Words of Radiance, Part One", "(3 of 5)"), or null for a whole book. */
export function splitPartOf(title: string): string | null {
  const ofPart = OF_PART_PATTERN.exec(title);
  if (ofPart) return String(Number(ofPart[1]));
  let trimmed = title.trim();
  for (let previous = ''; previous !== trimmed; ) {
    previous = trimmed;
    trimmed = trimmed.replace(TRAILING_BRACKETS_PATTERN, '').trim();
  }
  const match = TRAILING_PART_PATTERN.exec(trimmed);
  if (!match) return null;
  const value = match[1].toLowerCase();
  return PART_WORDS[value] ?? String(Number(value));
}

function isEnglishLanguage(language: string): boolean {
  return /^(?:en|eng|english)(?:[-_\s].*)?$/i.test(language.trim());
}

function isGraphicWork(work: ClaimWork): boolean {
  return effectiveWorkKind(work) === 'graphic_novel' || GRAPHIC_NOVEL_TITLE_PATTERN.test(work.title);
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
  const fileCollection = COLLECTION_TITLE_PATTERN.test(candidate.title);
  if (workCollection !== fileCollection && !namedAfter(work.title, candidate.title, keys)) {
    return workCollection ? 'collection_part' : 'collection_file';
  }

  const workPart = splitPartOf(work.title) ?? (effectiveWorkKind(work) === 'split_part' ? '?' : null);
  const filePart = splitPartOf(candidate.title);
  if ((workPart === null) !== (filePart === null)) return 'split_part';
  if (workPart !== null && workPart !== '?' && workPart !== filePart) return 'split_part';

  if (work.flags.includes('foreign_language') && candidate.language && isEnglishLanguage(candidate.language)) return 'language';
  return null;
}

/** Why one file format of a book cannot back the work, or null. */
export function fileFormatConflict(work: ClaimWork, candidate: ClaimCandidate, format: string): ShapeConflict | null {
  const lower = format.toLowerCase();
  if (effectiveWorkKind(work) === 'dramatization') return isAudioFormat(lower) ? null : 'audio_only';
  if (isGraphicWork(work)) {
    const fixedLayoutEpub = (lower === 'epub' || lower === 'kepub') && candidate.fixedLayoutFormats?.has(format) === true;
    return isComicFormat(lower) || lower === 'pdf' || fixedLayoutEpub ? null : 'comic_format';
  }
  return isComicFormat(lower) ? 'prose_format' : null;
}

const TIER_POINTS = [40, 30, 20, 10];

const KIND_PENALTY: Record<string, number> = {
  collection: -35,
  anthology: -35,
  supplemental: -30,
  dramatization: -30,
  duplicate: -30,
  format_variant: -20,
  split_part: -10,
};

const FLAG_PENALTY: Record<string, number> = {
  foreign_language: -35,
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
  for (const flag of work.flags) score += FLAG_PENALTY[flag] ?? 0;
  const language = claim.candidate.language;
  if (language && !work.flags.includes('foreign_language') && !isEnglishLanguage(language) && !/^(?:und|mul|zxx)$/i.test(language.trim())) {
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

  while (pending.length > 0) {
    const proposals = new Map<string, { entry: AssignableWork<W, C>; format: string; claim: C; score: number }[]>();
    const stillPending: typeof pending = [];
    for (const item of pending) {
      const kind = item.entry.formatKind(item.format);
      const free = (item.entry.claimsByFormat.get(item.format) ?? []).filter((claim) => {
        const key = keyOf(claim.candidate.bookId, kind);
        return !holder.has(key) || holder.get(key) === item.entry.work;
      });
      const pick = choose(item.entry.work, free);
      if (!pick) continue;
      const key = keyOf(pick.candidate.bookId, kind);
      if (holder.get(key) === item.entry.work) {
        origins.get(item.entry.work)!.set(item.format, pick.candidate.bookId);
        continue;
      }
      const group = proposals.get(key) ?? [];
      group.push({ ...item, claim: pick, score: score(item.entry.work, pick) });
      proposals.set(key, group);
      stillPending.push(item);
    }

    const settled = new Set<(typeof pending)[number]>();
    for (const [key, group] of proposals) {
      const bestByWork = new Map<W, number>();
      for (const proposal of group) bestByWork.set(proposal.entry.work, Math.max(bestByWork.get(proposal.entry.work) ?? -Infinity, proposal.score));
      const ranked = [...bestByWork.entries()].sort((left, right) => right[1] - left[1]);
      if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < CLAIM_MARGIN) {
        holder.set(key, null);
        for (const proposal of group) {
          const list = contested.get(proposal.entry.work) ?? [];
          if (!list.includes(proposal.claim)) list.push(proposal.claim);
          contested.set(proposal.entry.work, list);
        }
        continue;
      }
      const winner = ranked[0][0];
      holder.set(key, winner);
      for (const proposal of group) {
        if (proposal.entry.work !== winner) continue;
        origins.get(winner)!.set(proposal.format, proposal.claim.candidate.bookId);
        settled.add(stillPending.find((item) => item.entry === proposal.entry && item.format === proposal.format)!);
      }
    }
    pending = stillPending.filter((item) => !settled.has(item));
  }
  return { origins, contested };
}
