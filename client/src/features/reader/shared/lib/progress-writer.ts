import { api } from '@/lib/api'

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
  const res = await api(`/api/v1/books/files/${fileId}/progress`)
  if (!res.ok) return null
  return parseProgressRecord((await res.json()) as Record<string, unknown>)
}

export interface ProgressSaverOptions {
  fileId: number
  isEnabled: () => boolean
  // Called at save time so the body reflects the latest state.
  buildRecord: () => ProgressRecord
  source: () => ProgressSource
}

// Debounces and serialises position saves for one file. Shared by the reader and by narration
// that outlives its reader, so both write the same record the same way.
export function createProgressSaver({ fileId, isEnabled, buildRecord, source }: ProgressSaverOptions) {
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
    const body = JSON.stringify({ ...buildRecord(), source: source() })
    try {
      const res = await api(`/api/v1/books/files/${fileId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      })
      if (!res.ok && (res.status >= 500 || res.status === 429)) dirty = true
    } catch {
      dirty = true
    } finally {
      saving = false
      if (dirty && !saveTimer) startSaveTimer(SAVE_RETRY_MS)
    }
  }

  return { schedule, noteNarration, cancelScheduled, flush, save }
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
