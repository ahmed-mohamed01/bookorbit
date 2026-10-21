// A short log of what narration and its audio element did, kept across reloads so a stall that
// only happens with the app in the background can be read once the app is open again.
const STORAGE_KEY = 'bo:narration-trace'
const MAX_LINES = 600

let lines: string[] | null = null

function load(): string[] {
  if (lines) return lines
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    lines = Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === 'string') : []
  } catch {
    lines = []
  }
  return lines
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return String(value)
}

export function traceNarration(event: string, detail: Record<string, unknown> = {}) {
  const now = new Date()
  const time = now.toISOString().slice(11, 23)
  const visibility = typeof document === 'undefined' ? '?' : document.visibilityState
  const fields = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
  const all = load()
  all.push([time, visibility, event, ...fields].join(' '))
  if (all.length > MAX_LINES) all.splice(0, all.length - MAX_LINES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage can be full or blocked; the log still lives in memory.
  }
}

export function narrationTraceText(): string {
  const header = `${new Date().toISOString()} ${typeof navigator === 'undefined' ? '' : navigator.userAgent}`
  return [header, ...load()].join('\n')
}
