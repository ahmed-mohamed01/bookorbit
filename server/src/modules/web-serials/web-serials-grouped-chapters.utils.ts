import type { WebSerialKind } from '@bookorbit/types';
import type { EngineUnitSpec } from './engines/web-serial-engine';
import { ItemFailure } from './web-serials-runner.shared';

/** One chapter of a grouped manga unit, read once from the engine's untyped description. */
export interface GroupedChapterRef {
  raw: Record<string, unknown>;
  chapterId: string | null;
  sequence: string | null;
  label: string | null;
  publishedAt: string | null;
  /** An extra without a chapter number of its own. */
  positional: boolean;
}

export function isGroupedMangaUnit(kind: WebSerialKind, unit: EngineUnitSpec | undefined): boolean {
  return kind === 'manga' && Boolean(unit && Array.isArray(unit.remote['chapters']));
}

export function parseGroupedChapters(unit: EngineUnitSpec): GroupedChapterRef[] {
  const chapters = unit.remote['chapters'];
  if (!Array.isArray(chapters) || !chapters.every((chapter) => chapter && typeof chapter === 'object' && !Array.isArray(chapter))) {
    throw new ItemFailure('The grouped chapter description is invalid');
  }
  return (chapters as Array<Record<string, unknown>>).map((raw) => ({
    raw,
    chapterId: recordText(raw, 'chapterId'),
    sequence: recordText(raw, 'sequence'),
    label: recordText(raw, 'label'),
    publishedAt: recordText(raw, 'publishedAt'),
    positional: raw['positional'] === true,
  }));
}

export function memberUnitKey(chapter: GroupedChapterRef, itemUnitKey: string, index: number): string {
  return chapter.chapterId ?? `${itemUnitKey}:${index + 1}`;
}

export function memberSequence(chapter: GroupedChapterRef, index: number): string {
  return chapter.sequence ?? String(index + 1);
}

export function seriesRangeNumber(unit: EngineUnitSpec): string {
  const chapters = parseGroupedChapters(unit);
  const first = chapters[0]?.sequence ?? null;
  const last = chapters.at(-1)?.sequence ?? null;
  return first && last ? `${first}-${last}` : unit.sequence;
}

function recordText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
