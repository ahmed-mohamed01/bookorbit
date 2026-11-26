import type { ForkStoryGuideCut, ForkStoryGuidePayload, ForkStoryRecap, StoryGuideAnchor, StoryGuideLine } from '@bookorbit/types';

import { chapterIndexFromSpineStep, parseCfi } from '../position-converter/cfi.utils';
import { cfiPointToCollapsedCp, type ChapterDocument } from '../position-converter/position-converter.core';

const MIN_STRETCH_CHARS = 2000;
const MAX_STRETCH_CHARS = 12000;
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });

export async function placeCfi(
  cfi: string,
  chapter: (i: number) => Promise<ChapterDocument | null>,
): Promise<{ chapterIndex: number; offset: number | null } | null> {
  const chapterIndex = chapterIndexFromSpineStep(parseCfi(cfi)?.spineStep ?? null);
  if (chapterIndex === null) return null;

  const doc = await chapter(chapterIndex);
  const cp = doc ? cfiPointToCollapsedCp(doc, cfi) : null;
  // The converter counts code points, while both recap helpers slice UTF-16 strings.
  const offset = doc && cp !== null ? doc.index.extractCollapsed(0, cp).length : null;
  return { chapterIndex, offset };
}

type Placement = { chapterIndex: number; offset: number | null; text: string };

function quoteBeforeOffset(q: string, at: Placement): boolean {
  const quote = q.replace(/\s+/g, ' ').trim();
  const last = at.text.lastIndexOf(quote);
  return quote.length > 0 && at.offset !== null && last >= 0 && last + quote.length <= at.offset;
}

export function visibleSummaries(summaries: StoryGuideLine[], at: Placement, titleOf: (s: number) => string | null): ForkStoryRecap['previously'] {
  return summaries
    .filter(({ through }) => through.s < at.chapterIndex || (through.s === at.chapterIndex && 'q' in through && quoteBeforeOffset(through.q, at)))
    .map(({ through: { s }, text }) => ({ s, title: titleOf(s), text }));
}

function* guideAnchors(guide: ForkStoryGuidePayload): Generator<StoryGuideAnchor> {
  for (const entity of guide.entities) {
    for (const entry of [entity, ...entity.joins]) {
      for (const name of entry.names) yield name.at;
      for (const line of entry.lines) yield line.through;
      for (const profile of entry.profiles ?? []) yield profile.through;
    }
    for (const join of entity.joins) yield join.at;
  }

  for (const tie of guide.ties) {
    yield tie.at;
    yield* tie.quotes;
  }
  for (const link of guide.links ?? []) {
    yield link.at;
    if (link.until) yield link.until;
  }
  for (const summary of guide.summaries ?? []) yield summary.through;

  const chronicle = guide.chronicle;
  if (!chronicle) return;
  yield* Object.values(chronicle.joins ?? {});
  if (chronicle.covers) yield chronicle.covers;
  for (const notes of Object.values(chronicle.pairs ?? {})) {
    for (const note of notes) yield note.through;
  }
  for (const entry of Object.values(chronicle.entities)) {
    for (const line of entry.about) yield line.through;
    for (const line of entry.now ?? []) yield line.through;
    for (const note of entry.timeline) {
      yield note.at;
      yield note.through;
    }
    for (const snapshot of entry.abilities ?? []) {
      yield snapshot.through;
      for (const item of snapshot.items) yield item.since;
    }
  }
}

export function buildStoryGuideCut(guide: ForkStoryGuidePayload | undefined, at: Placement | null): ForkStoryGuideCut | null {
  if (!at) return null;
  const placedQuotes = new Set<string>();
  if (guide && at.offset !== null) {
    const checked = new Set<string>();
    for (const anchor of guideAnchors(guide)) {
      if (anchor.s !== at.chapterIndex || !('q' in anchor) || checked.has(anchor.q)) continue;
      checked.add(anchor.q);
      if (quoteBeforeOffset(anchor.q, at)) placedQuotes.add(anchor.q);
    }
  }
  return { s: at.chapterIndex, placedQuotes: [...placedQuotes] };
}

export async function pickStretch(
  chapters: (i: number) => Promise<string | null>,
  at: { chapterIndex: number; offset: number },
): Promise<string | null> {
  const current = await chapters(at.chapterIndex);
  if (current === null) return null;

  let stretch = current.slice(0, at.offset).trim();
  for (let index = at.chapterIndex - 1; index >= 0 && stretch.length < MIN_STRETCH_CHARS; index--) {
    const previous = (await chapters(index))?.trim();
    if (previous === undefined) break;
    if (previous) stretch = stretch ? `${previous}\n\n${stretch}` : previous;
  }

  if (stretch.length <= MAX_STRETCH_CHARS) return stretch || null;

  const cutoff = stretch.length - MAX_STRETCH_CHARS;
  const segment = sentences.segment(stretch).containing(cutoff);
  if (segment) {
    const start = segment.index === cutoff ? cutoff : segment.index + segment.segment.length;
    const suffix = stretch.slice(start).trimStart();
    if (suffix) return suffix;
  }

  // A sentence longer than the cap still needs a bounded excerpt.
  const splitsSurrogate = /[\uDC00-\uDFFF]/u.test(stretch[cutoff]);
  return stretch.slice(splitsSurrogate ? cutoff + 1 : cutoff).trimStart();
}
