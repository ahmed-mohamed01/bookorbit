// Fork: Convert to M4B. Pure helpers shared by the tool, the book page and settings.
import {
  AUDIO_CONVERT_ACTIVE_STATUSES,
  AUDIO_CONVERT_DEFAULT_BACKUP_DAYS,
  isAudioFormat,
  type AudioConvertChannels,
  type AudioConvertEncoderOptions,
  type AudioConvertJob,
  type AudioConvertJobStage,
  type AudioConvertJobStatus,
  type AudioConvertSettings,
  type BookDetailFile,
} from '@bookorbit/types'

/**
 * Shown in the confirm dialog only until the saved defaults arrive. Never sent: the dialog sends
 * just the fields the user changed, and the server fills the rest from the saved settings.
 */
export const FALLBACK_ENCODER_OPTIONS: AudioConvertEncoderOptions = { codec: 'auto', bitrate: '128k', channels: null }
export const FALLBACK_BACKUP_DAYS = AUDIO_CONVERT_DEFAULT_BACKUP_DAYS

/** Polling cadence while a job is queued or running. */
export const AUDIO_CONVERT_POLL_MS = 2000
/** Polling cadence while only waiting jobs remain: the automatic pipeline can hold one for up to a day. */
export const AUDIO_CONVERT_WAITING_POLL_MS = 30_000
/** Query flag that opens the book's convert dialog on the Files tab (set by the ⋮ menus). */
export const AUDIO_CONVERT_OPEN_QUERY = 'convert'

const ACTIVE = new Set<AudioConvertJobStatus>(AUDIO_CONVERT_ACTIVE_STATUSES)

export function isJobActive(job: Pick<AudioConvertJob, 'status'> | null | undefined): boolean {
  return !!job && ACTIVE.has(job.status)
}

/** Queued or running: what the run bar follows. Waiting jobs belong to the automatic pipeline and can sit for minutes. */
export function isJobInFlight(job: Pick<AudioConvertJob, 'status'> | null | undefined): boolean {
  return !!job && (job.status === 'queued' || job.status === 'running')
}

const FINISHED = new Set<AudioConvertJobStatus>(['success', 'failed', 'skipped', 'cancelled'])

export function isJobFinished(job: Pick<AudioConvertJob, 'status'> | null | undefined): boolean {
  return !!job && FINISHED.has(job.status)
}

/** How long to wait before polling again for these jobs, or `null` when nothing is active. */
export function pollDelay(jobs: readonly Pick<AudioConvertJob, 'status'>[]): number | null {
  if (jobs.some(isJobInFlight)) return AUDIO_CONVERT_POLL_MS
  if (jobs.some((job) => job.status === 'waiting')) return AUDIO_CONVERT_WAITING_POLL_MS
  return null
}

/** `<select>` values are strings, so channels travel as `keep`, `1` or `2`. */
export type ChannelsValue = 'keep' | '1' | '2'

export function channelsToValue(channels: AudioConvertChannels): ChannelsValue {
  return channels === null ? 'keep' : channels === 1 ? '1' : '2'
}

export function channelsFromValue(value: string): AudioConvertChannels {
  return value === '1' ? 1 : value === '2' ? 2 : null
}

/** The settings page's editable fields, with channels as their `<select>` value. */
export interface AudioConvertSettingsForm {
  enabled: boolean
  autoConvert: boolean
  codec: AudioConvertSettings['codec']
  bitrate: AudioConvertSettings['bitrate']
  channels: ChannelsValue
  embedChapters: boolean
  embedMetadata: boolean
  backupDays: number
}

export function settingsToForm(settings: AudioConvertSettings): AudioConvertSettingsForm {
  return {
    enabled: settings.enabled,
    autoConvert: settings.autoConvert,
    codec: settings.codec,
    bitrate: settings.bitrate,
    channels: channelsToValue(settings.channels),
    embedChapters: settings.embedChapters,
    embedMetadata: settings.embedMetadata,
    backupDays: settings.backupDays,
  }
}

/**
 * The form after the saved settings change from `previous` to `next`: fields the user has not
 * edited (still equal to `previous`) take the new value, edited ones are kept.
 */
export function mergeSavedSettings(
  form: AudioConvertSettingsForm,
  previous: AudioConvertSettings | null,
  next: AudioConvertSettings,
): AudioConvertSettingsForm {
  const incoming = settingsToForm(next)
  if (!previous) return incoming
  const before = settingsToForm(previous)
  const merged: Record<string, unknown> = { ...form }
  for (const key of Object.keys(incoming) as (keyof AudioConvertSettingsForm)[]) {
    if (Object.is(form[key], before[key])) merged[key] = incoming[key]
  }
  return merged as unknown as AudioConvertSettingsForm
}

/** Message key for a job's current stage. */
export function stageKey(stage: AudioConvertJobStage | null): string {
  switch (stage) {
    case 'metadata':
      return 'audioConvert.stage.metadata'
    case 'chapters':
      return 'audioConvert.stage.chapters'
    case 'converting':
      return 'audioConvert.stage.converting'
    case 'swapping':
      return 'audioConvert.stage.swapping'
    default:
      return 'audioConvert.stage.ready'
  }
}

/** Where a waiting or running job sits in Fill metadata → Fetch chapters → Convert. */
export function pipelineIndex(stage: AudioConvertJobStage | null): number {
  if (stage === 'metadata') return 0
  if (stage === 'chapters') return 1
  return 2
}

/** `19:45:47` from milliseconds. Hours are not wrapped, so a 30-hour book reads `30:00:00`. */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-'
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Error codes the client has copy for; anything else falls back to the generic message. */
export const KNOWN_ERROR_CODES = new Set([
  'book_missing',
  'no_audio',
  'already_converted',
  'mixed_formats_with_m4b',
  'folder_not_writable',
  'low_disk',
  'probe_failed',
  'ffmpeg_failed',
  'verify_failed',
  'backup_failed',
  'swap_failed',
  'files_changed',
  'interrupted',
  'disabled',
])

export function errorKey(code: string | null | undefined): string {
  return code && KNOWN_ERROR_CODES.has(code) ? `audioConvert.error.${code}` : 'audioConvert.error.unknown'
}

/** A book whose audio is already one M4B or M4A file: the ⋮ menus have nothing to offer it. */
export function isAlreadyM4b(files: readonly Pick<BookDetailFile, 'format' | 'role'>[]): boolean {
  const audio = files.filter((file) => (file.role === 'content' || file.role === 'primary') && file.format !== null && isAudioFormat(file.format))
  return audio.length === 1 && ['m4b', 'm4a'].includes(audio[0]!.format!.toLowerCase())
}
