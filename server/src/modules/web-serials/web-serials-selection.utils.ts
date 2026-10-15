import { BadRequestException } from '@nestjs/common';

import {
  WEB_SERIAL_SERIES_UNIT_KEY,
  webSerialSelectionUnitKey,
  webSerialVolumeUnitKey,
  planWebSerialMangaVolumes,
  type WebSerialPackaging,
  type WebSerialVolumePlanSelection,
  type WebSerialSelection,
  type WebSerialChapterRange,
} from '@bookorbit/types';
import type { EngineSeries, EngineUnitSpec } from './engines/web-serial-engine';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const PACKAGING_BY_KIND = {
  manga: ['chapter', 'volume', 'series'],
  novel: ['volume', 'series'],
} as const satisfies Record<string, readonly WebSerialPackaging[]>;

export function packagingAllowedFor(kind: 'manga' | 'novel', packaging: WebSerialPackaging): boolean {
  return (PACKAGING_BY_KIND[kind] as readonly WebSerialPackaging[]).includes(packaging);
}

function sequenceValue(sequence: string): number {
  return Number.parseFloat(sequence);
}

const SEQUENCE_PATTERN = /^[0-9]+([.][0-9]+)?$/;
const MAX_LIST_SEQUENCES = 5_000;

export function sequenceKey(sequence: string): string {
  const [integer = '', fraction = ''] = sequence.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

export interface RawWebSerialSelection {
  mode: WebSerialSelection['mode'];
  sequences?: string[];
  fromSequence?: string;
  toSequence?: string;
}

/** Narrows a request body's selection to the union the service works with, refusing a mode whose fields are missing. */
export function toWebSerialSelection(raw: RawWebSerialSelection): WebSerialSelection {
  if (raw.mode === 'all') return { mode: 'all' };
  if (raw.mode === 'list') {
    if (!raw.sequences) throw new BadRequestException(codedError('The selected chapter list is not valid', WebSerialErrorCode.SelectionInvalid));
    return { mode: 'list', sequences: raw.sequences };
  }
  if (raw.fromSequence === undefined || raw.toSequence === undefined)
    throw new BadRequestException(codedError('The selected range is not valid', WebSerialErrorCode.SelectionInvalid));
  return { mode: 'range', fromSequence: raw.fromSequence, toSequence: raw.toSequence };
}

export function assertValidSelection(selection: WebSerialSelection): void {
  if (selection.mode === 'list') {
    if (
      selection.sequences.length < 1 ||
      selection.sequences.length > MAX_LIST_SEQUENCES ||
      selection.sequences.some((sequence) => !SEQUENCE_PATTERN.test(sequence))
    ) {
      throw new BadRequestException(codedError('The selected chapter list is not valid', WebSerialErrorCode.SelectionInvalid));
    }
    return;
  }
  if (selection.mode !== 'range') return;
  const from = sequenceValue(selection.fromSequence);
  const to = sequenceValue(selection.toSequence);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new BadRequestException(codedError('The selected range is not valid', WebSerialErrorCode.SelectionInvalid));
  }
}

/**
 * The units a job covers. Grouped units retain the ordered source remotes so the runner can fetch
 * each member without consulting an external lookup again.
 */
export function selectUnits(
  series: EngineSeries,
  packaging: WebSerialPackaging,
  selection: WebSerialSelection,
  chapterVolumes: Record<string, string> | null = null,
): EngineUnitSpec[] {
  if (series.kind === 'manga' && packaging === 'volume') return groupMangaVolumes(series.units, selection, chapterVolumes, mayGrow(series));
  const selectedUnits =
    selection.mode === 'all'
      ? series.units
      : selection.mode === 'list'
        ? (() => {
            const sequences = new Set(selection.sequences.map(sequenceKey));
            return series.units.filter((unit) => sequences.has(sequenceKey(unit.sequence)));
          })()
        : series.units.filter((unit) => {
            const value = sequenceValue(unit.sequence);
            return value >= sequenceValue(selection.fromSequence) && value <= sequenceValue(selection.toSequence);
          });
  if (packaging === 'chapter') return selectedUnits.map((unit) => ({ ...unit, packaging }));
  if (packaging === 'volume') return selectedUnits.map((unit) => ({ ...unit, packaging }));
  if (selectedUnits.length === 0) return [];
  if (series.kind === 'manga') {
    const first = selectedUnits[0]!;
    const last = selectedUnits[selectedUnits.length - 1]!;
    return [
      {
        unitKey: webSerialSelectionUnitKey(first.unitKey, last.unitKey),
        label: selection.mode === 'all' ? series.title : `Chapters ${first.sequence}-${last.sequence}`,
        sequence: first.sequence,
        chapterCount: selectedUnits.length,
        publishedAt: null,
        packaging: 'series',
        remote: { chapters: selectedUnits.map((unit) => unit.remote) },
        chapterRange: chapterRangeOf(selectedUnits),
      },
    ];
  }
  return [
    {
      unitKey: WEB_SERIAL_SERIES_UNIT_KEY,
      label: series.title,
      sequence: '1',
      chapterCount: selectedUnits.reduce((sum, unit) => sum + unit.chapterCount, 0),
      publishedAt: null,
      packaging: 'series',
      remote: { volumes: selectedUnits.map((unit) => unit.remote) },
    },
  ];
}

/** A series that is not finished can still add chapters to its newest volume. */
function mayGrow(series: EngineSeries): boolean {
  return series.status !== 'completed' && series.status !== 'cancelled';
}

/** First and last chapter number of the members; extras without a number of their own only sit between them. */
export function chapterRangeOf(members: readonly EngineUnitSpec[]): WebSerialChapterRange | null {
  const numbers = members.flatMap((unit) => (unit.positional || !SEQUENCE_PATTERN.test(unit.sequence) ? [] : [Number(unit.sequence)]));
  if (numbers.length === 0) return null;
  return { from: Math.min(...numbers), to: Math.max(...numbers) };
}

function formatChapterRange(range: WebSerialChapterRange): string {
  return `${range.from}-${range.to}`;
}

function groupMangaVolumes(
  all: EngineUnitSpec[],
  selection: WebSerialSelection,
  chapterVolumes: Record<string, string> | null,
  growing: boolean,
): EngineUnitSpec[] {
  const volumeOf = (unit: EngineUnitSpec) => unit.volume ?? chapterVolumes?.[unit.unitKey] ?? null;
  const lastVolume = growing ? growingVolume(all, volumeOf) : null;
  const ordered = all;
  const byKey = new Map(ordered.map((unit) => [unit.unitKey, unit]));
  const listedSequences = selection.mode === 'list' ? new Set(selection.sequences.map(sequenceKey)) : null;
  const planSelection: WebSerialVolumePlanSelection = listedSequences
    ? { mode: 'keys', keys: new Set(ordered.filter((unit) => listedSequences.has(sequenceKey(unit.sequence))).map((unit) => unit.unitKey)) }
    : (selection as Exclude<WebSerialSelection, { mode: 'list' }>);
  const plan = planWebSerialMangaVolumes(
    ordered.map((unit) => ({ key: unit.unitKey, sequence: unit.sequence, volume: volumeOf(unit) })),
    planSelection,
  );
  return plan.entries.map((entry): EngineUnitSpec => {
    if (entry.type === 'chapter') return { ...byKey.get(entry.key)!, packaging: 'chapter' };
    const members = entry.keys.map((key) => byKey.get(key)!);
    const chapterRange = chapterRangeOf(members);
    const partial = entry.volume === lastVolume && chapterRange !== null;
    return {
      unitKey: webSerialVolumeUnitKey(entry.volume, partial ? formatChapterRange(chapterRange) : null),
      label: `Volume ${entry.volume}`,
      sequence: entry.volume,
      chapterCount: members.reduce((sum, unit) => sum + unit.chapterCount, 0),
      publishedAt: null,
      volume: entry.volume,
      packaging: 'volume',
      remote: { chapters: members.map((unit) => unit.remote) },
      chapterRange,
    };
  });
}

/** The volume that holds the newest chapter, if any: new chapters can still join it. A newer chapter outside it closes it. */
function growingVolume(all: readonly EngineUnitSpec[], volumeOf: (unit: EngineUnitSpec) => string | null): string | null {
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const unit = all[index]!;
    if (!unit.positional) return volumeOf(unit);
  }
  return null;
}
