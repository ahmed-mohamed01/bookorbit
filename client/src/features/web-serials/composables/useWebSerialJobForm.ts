import { computed, ref, watch, type Ref } from 'vue'
import type {
  Library,
  WebSerialCapabilities,
  WebSerialJob,
  WebSerialMetadataOverride,
  WebSerialPackaging,
  WebSerialSeriesDetail,
  WebSerialUnit,
} from '@bookorbit/types'
import { i18n } from '@/i18n'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { createSerialJob, fetchCapabilities } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import { isSeriesLoading } from '../lib/seriesLoading'
import {
  buildSelection,
  compareSequences,
  rangeForUnits,
  sortedSequences,
  sequenceOrdered,
  unitVolume,
  planVolumes,
  snappedDraft,
  describeVolumePlan,
  summarizeSelection,
  unitsInSelection,
  type SerialRangeDraft,
} from '../lib/serialSelection'

const LAST_LIBRARY_KEY = 'bookorbit.webSerials.lastLibraryId'

/** Per user, so someone else signing in on the same browser does not start in the last user's library. */
function lastLibraryKey(userId: number): string {
  return `${LAST_LIBRARY_KEY}.${userId}`
}

function readLastLibraryId(userId: number | null): number | null {
  if (userId === null) return null
  try {
    const raw = window.localStorage.getItem(lastLibraryKey(userId))
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(parsed) ? parsed : null
  } catch {
    return null
  }
}

function rememberLibraryId(userId: number | null, id: number): void {
  if (userId === null) return
  try {
    window.localStorage.setItem(lastLibraryKey(userId), String(id))
  } catch {
    // Remembering the last library is a convenience; a blocked store just means picking again.
  }
}

/** A viewer cannot add books, so offering their library would only end in a rejection. */
export function canAddToLibrary(library: Pick<Library, 'type' | 'accessLevel'>): boolean {
  return library.type === 'books' && library.accessLevel !== 'viewer'
}

const KIND_FORMAT: Record<WebSerialSeriesDetail['kind'], string> = { manga: 'cbz', novel: 'epub' }

/** An empty list means the library takes every format. */
export function acceptsKind(library: Pick<Library, 'allowedFormats'>, kind: WebSerialSeriesDetail['kind'] | undefined): boolean {
  if (!kind || !library.allowedFormats?.length) return true
  return library.allowedFormats.includes(KIND_FORMAT[kind])
}

export interface WebSerialVolumeKnowledge {
  chapterVolumes: Ref<Record<string, string> | null>
  loading: Ref<boolean>
}

export function useWebSerialJobForm(
  detail: Ref<WebSerialSeriesDetail | null>,
  volumeKnowledge?: WebSerialVolumeKnowledge,
  userId: Ref<number | null> = ref(null),
) {
  const { libraries: allLibraries, loaded: librariesLoaded, fetchLibraries } = useLibraries()

  const packaging = ref<WebSerialPackaging>('chapter')
  const range = ref<SerialRangeDraft>({ mode: 'all', fromSequence: '', toSequence: '' })
  const libraryId = ref<number | null>(null)
  const folderId = ref<number | null>(null)
  // Untouched, the folder is left to the server so it can apply the admin's default folder.
  const folderChosen = ref(false)
  const capabilities = ref<WebSerialCapabilities | null>(null)
  const libraryChosen = ref(false)
  const submitting = ref(false)
  const error = ref<string | null>(null)
  const awaitingRangeEnd = ref(false)
  const rangeIncludesImportedGap = ref(false)

  const libraries = computed(() => allLibraries.value.filter((library) => canAddToLibrary(library) && acceptsKind(library, detail.value?.kind)))
  const folders = computed(() => libraries.value.find((library) => library.id === libraryId.value)?.folders ?? [])
  const units = computed(() => detail.value?.units ?? [])
  const sequences = computed(() => sortedSequences(units.value))
  const importedKeys = computed(() => detail.value?.importedUnitKeys ?? [])
  const packagingOptions = computed(() => detail.value?.packagingOptions ?? [])
  const choosesPackaging = computed(() => packagingOptions.value.length > 1)
  const isManga = computed(() => detail.value?.kind === 'manga')

  const isNovel = computed(() => detail.value?.kind === 'novel')

  function volumeOf(unit: WebSerialUnit): string | null {
    return unitVolume(unit, volumeKnowledge?.chapterVolumes.value)
  }

  // Per-volume manga widens a range to whole volumes, so the plan decides what is really selected.
  const volumePlan = computed(() =>
    isManga.value && packaging.value === 'volume' && units.value.length > 0 ? planVolumes(units.value, range.value, volumeOf) : null,
  )
  const effectiveRange = computed(() => (volumePlan.value ? snappedDraft(range.value, volumePlan.value) : range.value))
  const volumeNotice = computed(() => (volumePlan.value ? describeVolumePlan(units.value, volumePlan.value) : null))
  const selectedUnits = computed(() => unitsInSelection(units.value, effectiveRange.value))
  const summary = computed(() =>
    summarizeSelection(
      units.value,
      range.value,
      packaging.value,
      importedKeys.value,
      true,
      isManga.value ? volumeOf : undefined,
      detail.value?.importedGroupKeys ?? [],
      detail.value?.kind,
    ),
  )
  const volumeLoading = computed(() => isManga.value && (volumeKnowledge?.loading.value ?? false))
  const rawSelectedUnits = computed(() => unitsInSelection(units.value, range.value))
  const volumeKnownCount = computed(() => (isManga.value ? rawSelectedUnits.value.filter((unit) => volumeOf(unit) !== null).length : 0))
  const volumeUnavailable = computed(() => isManga.value && !volumeLoading.value && rawSelectedUnits.value.length > 0 && volumeKnownCount.value === 0)
  const chaptersWithoutVolume = computed(() => (isManga.value ? selectedUnits.value.length - volumeKnownCount.value : 0))
  const singleChapterCount = computed(() => (volumePlan.value ? volumePlan.value.entries.filter((entry) => entry.type === 'chapter').length : 0))
  const volumeSelectable = computed(() => !volumeLoading.value && !volumeUnavailable.value)
  const rangeComplete = computed(() => range.value.mode === 'range' && Boolean(range.value.fromSequence && range.value.toSequence))
  const nothingToDownload = computed(() => summary.value.books === 0 || summary.value.toDownload === 0)
  const canSubmit = computed(() => detail.value !== null && libraryId.value !== null && !nothingToDownload.value && !submitting.value)

  // The server files into the admin's folder when the library is their default one, so the picker starts there too.
  function defaultFolderId(library: Library | undefined): number | null {
    if (!library) return null
    const kind = detail.value?.kind
    const entry = kind ? capabilities.value?.[kind] : undefined
    const target = entry?.defaultLibraryId === library.id ? entry.targetFolderId : null
    return library.folders.find((folder) => folder.id === target)?.id ?? library.folders[0]?.id ?? null
  }

  function applyLibrary(id: number | null): void {
    libraryId.value = id
    folderId.value = defaultFolderId(libraries.value.find((library) => library.id === id))
    folderChosen.value = false
  }

  function pickDefaultLibrary(): void {
    const kind = detail.value?.kind
    const adminDefault = kind ? (capabilities.value?.[kind].defaultLibraryId ?? null) : null
    const remembered = readLastLibraryId(userId.value)
    const preferred =
      libraries.value.find((library) => library.id === adminDefault) ??
      libraries.value.find((library) => library.id === remembered) ??
      libraries.value[0] ??
      null
    applyLibrary(preferred?.id ?? null)
  }

  function reset(): void {
    const value = detail.value
    packaging.value = value?.defaultPackaging ?? 'chapter'
    const first = sequences.value[0] ?? ''
    const last = sequences.value[sequences.value.length - 1] ?? ''
    range.value = { mode: 'all', fromSequence: first, toSequence: last }
    awaitingRangeEnd.value = false
    rangeIncludesImportedGap.value = false
    error.value = null
    const stillValid = libraries.value.some((library) => library.id === libraryId.value)
    if (!libraryChosen.value || !stillValid) pickDefaultLibrary()
    else if (!folderChosen.value) folderId.value = defaultFolderId(libraries.value.find((library) => library.id === libraryId.value))
  }

  // One book for the series is built from every volume, so a range always means one book per volume.
  function setMode(mode: SerialRangeDraft['mode']): void {
    if (mode === range.value.mode) return
    if (mode === 'range') {
      range.value = { mode, fromSequence: '', toSequence: '' }
      awaitingRangeEnd.value = false
    } else {
      const bounds = rangeForUnits(units.value)
      range.value = { mode, fromSequence: bounds?.fromSequence ?? '', toSequence: bounds?.toSequence ?? '' }
      awaitingRangeEnd.value = false
    }
    rangeIncludesImportedGap.value = false
    if (mode === 'range' && isNovel.value && packaging.value === 'series' && packagingOptions.value.includes('volume')) packaging.value = 'volume'
  }

  function setFrom(sequence: string): void {
    const next = { ...range.value, fromSequence: sequence }
    if (next.toSequence && compareSequences(sequence, next.toSequence) > 0) next.toSequence = sequence
    range.value = next
    awaitingRangeEnd.value = !next.toSequence
    rangeIncludesImportedGap.value = false
  }

  function setTo(sequence: string): void {
    const next = { ...range.value, toSequence: sequence }
    if (next.fromSequence && compareSequences(sequence, next.fromSequence) < 0) next.fromSequence = sequence
    range.value = next
    awaitingRangeEnd.value = !next.fromSequence
    rangeIncludesImportedGap.value = false
  }

  function setPackaging(next: WebSerialPackaging): void {
    if (!packagingOptions.value.includes(next)) return
    if (next === 'volume' && isManga.value && !volumeSelectable.value) return
    packaging.value = next
    if (next === 'series' && isNovel.value) setMode('all')
  }

  function selectRangeUnit(sequence: string): void {
    if (range.value.mode !== 'range') setMode('range')
    if (!awaitingRangeEnd.value || !range.value.fromSequence || range.value.toSequence) {
      range.value = { mode: 'range', fromSequence: sequence, toSequence: '' }
      awaitingRangeEnd.value = true
    } else {
      const from = compareSequences(range.value.fromSequence, sequence) <= 0 ? range.value.fromSequence : sequence
      const to = compareSequences(range.value.fromSequence, sequence) <= 0 ? sequence : range.value.fromSequence
      range.value = { mode: 'range', fromSequence: from, toSequence: to }
      awaitingRangeEnd.value = false
    }
    rangeIncludesImportedGap.value = false
  }

  function applyRange(nextUnits: readonly (typeof units.value)[number][], trackImportedGaps = false): void {
    const bounds = rangeForUnits(nextUnits)
    if (!bounds) return
    range.value = { mode: 'range', ...bounds }
    awaitingRangeEnd.value = false
    rangeIncludesImportedGap.value =
      trackImportedGaps && unitsInSelection(units.value, range.value).some((unit) => importedKeys.value.includes(unit.key))
    if (isNovel.value && packaging.value === 'series' && packagingOptions.value.includes('volume')) packaging.value = 'volume'
  }

  function selectFirst(count = 10): void {
    applyRange(sequenceOrdered(units.value).slice(0, count))
  }

  function selectLatest(count = 10): void {
    applyRange(sequenceOrdered(units.value).slice(-count))
  }

  function selectNotImported(): void {
    const imported = new Set(importedKeys.value)
    applyRange(
      units.value.filter((unit) => !imported.has(unit.key)),
      true,
    )
  }

  function clearRange(): void {
    range.value = { mode: 'range', fromSequence: '', toSequence: '' }
    awaitingRangeEnd.value = false
    rangeIncludesImportedGap.value = false
  }

  function selectLibrary(id: number | null): void {
    applyLibrary(id)
    libraryChosen.value = true
  }

  function setFolder(id: number | null): void {
    folderId.value = id
    folderChosen.value = true
  }

  async function submit(metadata?: WebSerialMetadataOverride): Promise<WebSerialJob | null> {
    const value = detail.value
    if (!value || libraryId.value === null || !canSubmit.value) return null
    submitting.value = true
    error.value = null
    try {
      const job = await createSerialJob({
        seriesKey: value.seriesKey,
        packaging: packaging.value,
        selection: buildSelection(range.value),
        skipImported: true,
        libraryId: libraryId.value,
        folderId: folderChosen.value ? folderId.value : null,
        ...(metadata ? { metadata } : {}),
      })
      rememberLibraryId(userId.value, libraryId.value)
      return job
    } catch (cause) {
      error.value = isSeriesLoading(cause)
        ? i18n.global.t('webSerials.preview.seriesLoading', { source: value.sourceName })
        : messageOf(cause, 'webSerials.api.createJob')
      return null
    } finally {
      submitting.value = false
    }
  }

  watch(detail, reset, { immediate: true })
  // A selection with no known volume can no longer be packed per volume.
  watch(volumeUnavailable, (unavailable) => {
    if (unavailable && packaging.value === 'volume' && isManga.value) packaging.value = 'chapter'
  })
  // Only used to preselect the admin's library for each kind; a failure just keeps the fallback.
  void fetchCapabilities()
    .catch(() => null)
    .then((value) => {
      capabilities.value = value
      if (value && !libraryChosen.value) pickDefaultLibrary()
    })
  watch(librariesLoaded, () => {
    if (libraryId.value === null) pickDefaultLibrary()
  })

  return {
    libraries,
    folders,
    packaging,
    range,
    libraryId,
    folderId,
    submitting,
    error,
    sequences,
    selectedUnits,
    rangeComplete,
    rangeIncludesImportedGap,
    summary,
    effectiveRange,
    volumeNotice,
    singleChapterCount,
    nothingToDownload,
    canSubmit,
    choosesPackaging,
    isManga,
    volumeOf,
    volumeLoading,
    volumeUnavailable,
    chaptersWithoutVolume,
    fetchLibraries,
    selectLibrary,
    setFolder,
    setMode,
    setFrom,
    setTo,
    setPackaging,
    selectRangeUnit,
    selectFirst,
    selectLatest,
    selectNotImported,
    clearRange,
    submit,
  }
}
