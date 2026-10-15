import {
  WEB_SERIAL_SERIES_UNIT_KEY,
  webSerialSelectionUnitKey,
  planWebSerialMangaVolumes,
  parseWebSerialVolumeUnitKey,
  webSerialMangaVolumeOwned,
  type WebSerialChapterRange,
  type WebSerialPartialVolume,
  type WebSerialVolumePlan,
  type WebSerialKind,
  type WebSerialPackaging,
  type WebSerialSelection,
  type WebSerialUnit,
} from '@bookorbit/types'

/** Sequences are `^[0-9]+([.][0-9]+)?$`, so numeric order is the series order. */
export function compareSequences(a: string, b: string): number {
  return Number.parseFloat(a) - Number.parseFloat(b)
}

export function sortedSequences(units: readonly WebSerialUnit[]): string[] {
  const unique = [...new Set(units.map((unit) => unit.sequence))]
  return unique.sort(compareSequences)
}

export function sequenceOrdered(units: readonly WebSerialUnit[]): WebSerialUnit[] {
  return [...units].sort((a, b) => compareSequences(a.sequence, b.sequence))
}

const PLAIN_NUMBER = /^\d+(\.\d+)?$/

/**
 * The manga volumes already in the library, by the server's rule: a plain `vol:N` key owns volume N, and ranged `vol:N:a-b`
 * copies of the same volume own it while together they cover its numbered chapters (extras placed between them do not count).
 */
export function ownedVolumes(
  units: readonly WebSerialUnit[],
  volumeOf: (unit: WebSerialUnit) => string | null,
  importedGroupKeys: readonly string[],
): Set<string> {
  const volumes = new Set<string>()
  for (const key of importedGroupKeys) {
    const parsed = parseWebSerialVolumeUnitKey(key)
    if (parsed) volumes.add(parsed.volume)
  }
  if (volumes.size === 0) return new Set()
  const wanted = new Map<string, WebSerialChapterRange>()
  for (const unit of units) {
    const volume = volumeOf(unit)
    if (volume === null || !volumes.has(volume) || unit.positional || !PLAIN_NUMBER.test(unit.sequence)) continue
    const at = Number(unit.sequence)
    const seen = wanted.get(volume)
    wanted.set(volume, seen ? { from: Math.min(seen.from, at), to: Math.max(seen.to, at) } : { from: at, to: at })
  }
  return new Set([...volumes].filter((volume) => webSerialMangaVolumeOwned(importedGroupKeys, volume, wanted.get(volume) ?? null)))
}

export interface SerialRangeDraft {
  mode: 'all' | 'range'
  fromSequence: string
  toSequence: string
}

/** A reversed range is read the way it was meant, so the picker never produces an empty selection by order alone. */
export function normalizeRange(draft: SerialRangeDraft): { from: string; to: string } {
  return compareSequences(draft.fromSequence, draft.toSequence) <= 0
    ? { from: draft.fromSequence, to: draft.toSequence }
    : { from: draft.toSequence, to: draft.fromSequence }
}

export function unitsInSelection(units: readonly WebSerialUnit[], draft: SerialRangeDraft): WebSerialUnit[] {
  if (draft.mode === 'all') return [...units]
  if (!draft.fromSequence || !draft.toSequence) return []
  const { from, to } = normalizeRange(draft)
  return units.filter((unit) => compareSequences(unit.sequence, from) >= 0 && compareSequences(unit.sequence, to) <= 0)
}

export function rangeForUnits(units: readonly WebSerialUnit[]): Pick<SerialRangeDraft, 'fromSequence' | 'toSequence'> | null {
  const sequences = sortedSequences(units)
  if (sequences.length === 0) return null
  return { fromSequence: sequences[0] ?? '', toSequence: sequences[sequences.length - 1] ?? '' }
}

export function sequenceInRange(sequence: string, draft: SerialRangeDraft): boolean {
  if (draft.mode !== 'range' || !draft.fromSequence || !draft.toSequence) return false
  const { from, to } = normalizeRange(draft)
  return compareSequences(sequence, from) >= 0 && compareSequences(sequence, to) <= 0
}

export function buildSelection(draft: SerialRangeDraft): WebSerialSelection {
  if (draft.mode === 'all' || !draft.fromSequence || !draft.toSequence) return { mode: 'all' }
  const { from, to } = normalizeRange(draft)
  return { mode: 'range', fromSequence: from, toSequence: to }
}

/** The volume a manga chapter belongs to: the source's own naming wins, then the volume database. Never guessed. */
export function unitVolume(unit: WebSerialUnit, chapterVolumes: Readonly<Record<string, string>> | null | undefined): string | null {
  return unit.volume ?? chapterVolumes?.[unit.key] ?? null
}

/** The shared per-volume rule applied to the picker's selection; the server runs the same function on the same units. */
export function planVolumes(
  units: readonly WebSerialUnit[],
  draft: SerialRangeDraft,
  volumeOf: (unit: WebSerialUnit) => string | null,
): WebSerialVolumePlan {
  const planUnits = units.map((unit) => ({ key: unit.key, sequence: unit.sequence, volume: volumeOf(unit) }))
  if (draft.mode === 'all') return planWebSerialMangaVolumes(planUnits, { mode: 'all' })
  if (!draft.fromSequence || !draft.toSequence) return planWebSerialMangaVolumes(planUnits, { mode: 'keys', keys: new Set() })
  const { from, to } = normalizeRange(draft)
  return planWebSerialMangaVolumes(planUnits, { mode: 'range', fromSequence: from, toSequence: to })
}

/** The draft the server will actually download: a range widened to whole volumes. */
export function snappedDraft(draft: SerialRangeDraft, plan: WebSerialVolumePlan): SerialRangeDraft {
  return plan.snappedRange ? { mode: 'range', ...plan.snappedRange } : draft
}

export interface VolumePackagingNotice {
  volumes: number
  /** Chapters in no volume, which download as separate chapters. */
  outsideVolumes: WebSerialUnit[]
  /** Volumes only partly selected; their chapters download separately. */
  partialVolumes: WebSerialPartialVolume[]
  snappedRange: WebSerialVolumePlan['snappedRange']
}

export function describeVolumePlan(units: readonly WebSerialUnit[], plan: WebSerialVolumePlan): VolumePackagingNotice {
  const byKey = new Map(units.map((unit) => [unit.key, unit]))
  const outsideVolumes: WebSerialUnit[] = []
  let volumes = 0
  for (const entry of plan.entries) {
    if (entry.type === 'volume') volumes += 1
    else if (entry.volume === null) {
      const unit = byKey.get(entry.key)
      if (unit) outsideVolumes.push(unit)
    }
  }
  return { volumes, outsideVolumes, partialVolumes: plan.partialVolumes, snappedRange: plan.snappedRange }
}

export interface SerialSelectionSummary {
  /** Books that will land: one per selected unit, or a single book for a whole-series novel. */
  books: number
  /** Selected units the user already has, which are skipped when skipping is on. */
  alreadyHave: number
  /** Books that will actually be downloaded. */
  toDownload: number
  chapters: number
}

export function summarizeSelection(
  units: readonly WebSerialUnit[],
  draft: SerialRangeDraft,
  packaging: WebSerialPackaging,
  importedUnitKeys: readonly string[],
  skipImported: boolean,
  volumeOf?: (unit: WebSerialUnit) => string | null,
  importedGroupKeys: readonly string[] = [],
  kind: WebSerialKind = 'manga',
): SerialSelectionSummary {
  const selected = unitsInSelection(units, draft)
  const imported = new Set(importedUnitKeys)
  const groups = new Set(importedGroupKeys)
  const owns = (key: string, owned: ReadonlySet<string>) => skipImported && owned.has(key)
  const chapters = selected.reduce((sum, unit) => sum + unit.chapterCount, 0)

  if (packaging === 'series') {
    const first = selected[0]
    const last = selected[selected.length - 1]
    const key = kind === 'novel' ? WEB_SERIAL_SERIES_UNIT_KEY : first && last ? webSerialSelectionUnitKey(first.key, last.key) : null
    const owned = key !== null && owns(key, groups) ? 1 : 0
    const books = selected.length > 0 ? 1 : 0
    return { books, alreadyHave: owned, toDownload: books - owned, chapters }
  }

  if (packaging === 'volume' && volumeOf) {
    const plan = planVolumes(units, draft, volumeOf)
    const volumesOwned = ownedVolumes(units, volumeOf, importedGroupKeys)
    const byKey = new Map(units.map((unit) => [unit.key, unit]))
    let owned = 0
    let planned = 0
    for (const entry of plan.entries) {
      const memberKeys = entry.type === 'volume' ? entry.keys : [entry.key]
      planned += memberKeys.reduce((sum, key) => sum + (byKey.get(key)?.chapterCount ?? 0), 0)
      if (entry.type === 'volume' ? skipImported && volumesOwned.has(entry.volume) : owns(entry.key, imported)) owned += 1
    }
    const books = plan.entries.length
    return { books, alreadyHave: owned, toDownload: books - owned, chapters: planned }
  }

  const alreadyHave = skipImported ? selected.filter((unit) => imported.has(unit.key)).length : 0
  return { books: selected.length, alreadyHave, toDownload: selected.length - alreadyHave, chapters }
}
