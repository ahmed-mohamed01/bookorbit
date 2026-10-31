import type { ReadingProgressWrite } from '@bookorbit/types'
import { api } from '@/lib/api'
import { fetchFileProgress } from '@/lib/reading-progress'

export type ProgressSource = 'text' | 'narration'

export interface ProgressRecord {
  cfi: string | null
  pageNumber: number | null
  percentage: number
  koboLocationSource: string | null
  koboLocationType: string | null
  koboLocationValue: string | null
  koboContentSourceProgressPercent: number | null
  koreaderProgress: string | null
  positionSeconds: number | null
  mediaOverlayFragment: string | null
  mediaOverlaySectionIndex: number | null
}

const TEXT_SAVE_DEBOUNCE_MS = 2_000
// Narration moves the position every sentence. Saving that often competes with the
// streamed audio for bandwidth on a weak link, so it is saved on an interval instead.
const NARRATION_SAVE_INTERVAL_MS = 15_000
const SAVE_TIMEOUT_MS = 10_000
const SAVE_RETRY_MS = 15_000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function normalizeFraction(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed === null ? null : clamp(parsed, 0, 1)
}

export function normalizePercentage(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed === null ? null : clamp(parsed, 0, 100)
}

export function normalizePageNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed === null || parsed < 0 ? null : parsed
}

export function parseProgressRecord(data: Record<string, unknown>): ProgressRecord {
  return {
    cfi: normalizeString(data.cfi),
    pageNumber: normalizePageNumber(data.pageNumber),
    percentage: normalizePercentage(data.percentage) ?? 0,
    koboLocationSource: normalizeString(data.koboLocationSource),
    koboLocationType: normalizeString(data.koboLocationType),
    koboLocationValue: normalizeString(data.koboLocationValue),
    koboContentSourceProgressPercent: normalizePercentage(data.koboContentSourceProgressPercent),
    koreaderProgress: normalizeString(data.koreaderProgress),
    positionSeconds: typeof data.positionSeconds === 'number' ? data.positionSeconds : null,
    mediaOverlayFragment: typeof data.mediaOverlayFragment === 'string' ? data.mediaOverlayFragment : null,
    mediaOverlaySectionIndex: typeof data.mediaOverlaySectionIndex === 'number' ? data.mediaOverlaySectionIndex : null,
  }
}

export async function fetchProgressRecord(fileId: number): Promise<ProgressRecord | null> {
  const data = await fetchFileProgress(fileId)
  return data ? parseProgressRecord(data) : null
}

export type TextProgressRecord = Omit<ProgressRecord, 'positionSeconds' | 'mediaOverlayFragment' | 'mediaOverlaySectionIndex'>

// The grouped write upstream's `saveReadingProgress` sends; built here so the save can carry a timeout.
function toProgressWrite(fileId: number, kind: ProgressSource, record: ProgressRecord | TextProgressRecord): ReadingProgressWrite {
  return {
    fileId,
    kind,
    percentage: record.percentage,
    text: { cfi: record.cfi, page: record.pageNumber },
    kobo: {
      source: record.koboLocationSource,
      type: record.koboLocationType,
      value: record.koboLocationValue,
      contentPercent: record.koboContentSourceProgressPercent,
    },
    koreader: record.koreaderProgress,
    ...('positionSeconds' in record
      ? { narration: { seconds: record.positionSeconds, fragment: record.mediaOverlayFragment, sectionIndex: record.mediaOverlaySectionIndex } }
      : {}),
  }
}

export interface ProgressSaverOptions {
  fileId: number
  isEnabled: () => boolean
  // Called at save time so the body reflects the latest state. A text save may leave the narration
  // fields out, so a page turn never rewrites a marker another device saved since.
  buildRecord: () => ProgressRecord | TextProgressRecord
  source: () => ProgressSource
  // False, or a promise of false, drops the save for a position the caller decided not to write.
  // Answering true without a promise keeps the request in the same tick as the timer.
  beforeSave?: () => boolean | Promise<boolean>
  onSaved?: (res: Response, record: ProgressRecord | TextProgressRecord) => void
}

// Debounces and serialises position saves for one file. Shared by the reader and by narration
// that outlives its reader, so both write the same record the same way.
export function createProgressSaver({ fileId, isEnabled, buildRecord, source, beforeSave, onSaved }: ProgressSaverOptions) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let saving = false
  let lastNarrationAt = 0

  function isNarrating() {
    return lastNarrationAt > 0 && Date.now() - lastNarrationAt < NARRATION_SAVE_INTERVAL_MS
  }

  function startSaveTimer(delayMs: number) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void save()
    }, delayMs)
  }

  function noteNarration() {
    lastNarrationAt = Date.now()
  }

  function cancelScheduled() {
    if (saveTimer) clearTimeout(saveTimer)
  }

  function discardPending() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    dirty = false
  }

  function isBusy() {
    return saveTimer !== null || saving
  }

  // Text moves are debounced. While narration runs, a pending save is kept rather than
  // pushed back, so the position is saved once per interval with its latest value.
  function schedule() {
    if (!isEnabled()) return
    dirty = true
    if (saveTimer && isNarrating()) return
    startSaveTimer(isNarrating() ? NARRATION_SAVE_INTERVAL_MS : TEXT_SAVE_DEBOUNCE_MS)
  }

  // Saves a pending position now, e.g. when narration pauses or stops.
  function flush() {
    if (!dirty) return
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void save()
  }

  // One save runs at a time; a change made meanwhile is saved once it finishes. A failed
  // save stays dirty and is retried later instead of surfacing an error.
  async function save() {
    if (!isEnabled()) return
    if (saving) {
      dirty = true
      return
    }
    saving = true
    dirty = false
    try {
      const proceed = beforeSave?.()
      if (proceed !== undefined && proceed !== true && !(await proceed)) return
      const record = buildRecord()
      const res = await api('/api/v1/reading-progress', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes: [toProgressWrite(fileId, source(), record)] }),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      })
      if (!res.ok && (res.status >= 500 || res.status === 429)) dirty = true
      else if (res.ok) onSaved?.(res, record)
    } catch {
      dirty = true
    } finally {
      saving = false
      if (dirty && !saveTimer) startSaveTimer(SAVE_RETRY_MS)
    }
  }

  return { schedule, noteNarration, cancelScheduled, discardPending, isBusy, flush, save }
}

export interface NarrationProgressWriter {
  load: () => Promise<void>
  setMediaOverlayProgress: (fragment: string, sectionIndex: number) => void
  flush: () => void
}

// Writes narration progress for a file with no reader open. The whole record is saved, so the
// existing text position is loaded first or it would be overwritten.
export function createNarrationProgressWriter(fileId: number, trackingEnabled: boolean): NarrationProgressWriter {
  let record: ProgressRecord = parseProgressRecord({})
  const saver = createProgressSaver({
    fileId,
    isEnabled: () => trackingEnabled,
    buildRecord: () => record,
    source: () => 'narration',
  })

  return {
    async load() {
      if (!trackingEnabled) return
      record = (await fetchProgressRecord(fileId)) ?? record
    },
    setMediaOverlayProgress(fragment, sectionIndex) {
      record = { ...record, mediaOverlayFragment: fragment, mediaOverlaySectionIndex: sectionIndex, positionSeconds: null }
      saver.noteNarration()
      saver.schedule()
    },
    flush: saver.flush,
  }
}
