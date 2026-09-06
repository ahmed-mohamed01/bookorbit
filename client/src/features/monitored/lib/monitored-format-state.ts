import {
  MONITORED_ACQUISITION_STATES,
  monitoredAcquisitionState,
  type MonitoredAcquisitionState,
  type MonitoredFormat,
  type MonitoredReleaseStatus,
  type MonitoredWork,
} from '@bookorbit/types'

export type { MonitoredAcquisitionState }
export type MonitoredFormatState = MonitoredAcquisitionState | 'available' | 'wanted' | 'off'

export function monitoredFormatState(
  work: MonitoredWork,
  format: MonitoredFormat,
  options: { monitored?: boolean; optimisticQueued?: boolean } = {},
): MonitoredFormatState {
  if (work.ownedFormats.includes(format) || work.matchedBookIds?.[format] != null) return 'available'
  if (options.optimisticQueued) return 'queued'
  const acquisition = monitoredAcquisitionState(work.requestStatuses?.[format])
  if (acquisition) return acquisition
  return options.monitored === false ? 'off' : 'wanted'
}

/** Reads a per-format state or a server-sent release status: the acquisition names are shared. */
export function isMonitoredAcquisitionState(state: MonitoredFormatState | MonitoredReleaseStatus): state is MonitoredAcquisitionState {
  return (MONITORED_ACQUISITION_STATES as readonly string[]).includes(state)
}

/**
 * What a format's action reads while its request is in flight. Only "queued" names the format,
 * because the later phases are about the file rather than what was asked for.
 */
export function monitoredPendingLabelKey(state: MonitoredFormatState, format: MonitoredFormat): string {
  if (isMonitoredAcquisitionState(state) && state !== 'queued') return `monitored.detail.badges.${state}`
  return `monitored.detail.${format}Queued`
}
