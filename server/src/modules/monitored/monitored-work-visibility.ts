import type { MonitoredWork } from '@bookorbit/types';

export function isWorkVisible(work: MonitoredWork): boolean {
  if (work.userVisibility === 'hidden') return false;
  if (work.userVisibility === 'visible') return true;
  return work.verdict === 'verified' && work.flags.length === 0;
}
