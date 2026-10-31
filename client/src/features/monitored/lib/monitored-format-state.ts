import {
  MONITORED_ACQUISITION_STATES,
  type MonitoredAcquisitionState,
  type MonitoredFormat,
  type MonitorMode,
  type MonitoredReleaseStatus,
} from '@bookorbit/types'

export type { MonitoredAcquisitionState }
export type MonitoredFormatState = MonitoredAcquisitionState | 'available' | 'wanted' | 'off'

/** Reads a per-format state or a server-sent release status: the acquisition names are shared. */
export function isMonitoredAcquisitionState(state: MonitoredFormatState | MonitoredReleaseStatus): state is MonitoredAcquisitionState {
  return (MONITORED_ACQUISITION_STATES as readonly string[]).includes(state)
}

export function watchedFormats(modes: Partial<Record<MonitoredFormat, MonitorMode>>): MonitoredFormat[] {
  return (['ebook', 'audiobook'] as const).filter((format) => modes[format] !== 'off')
}
