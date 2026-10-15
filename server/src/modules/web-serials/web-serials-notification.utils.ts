import { NotificationType } from '@bookorbit/types';
import type { NotificationPatch } from '../notification/notification.service';

export type WebSerialOutcome = 'completed' | 'completed_with_gaps' | 'failed';

export const WEB_SERIAL_QUEUE_URL = '/web-serials/queue';

const TITLE_MAX_LENGTH = 180;

export interface WebSerialOutcomeInput {
  jobId: number;
  title: string;
  /** What one unit of the job is: chapter, volume or book. */
  noun: string;
  outcome: WebSerialOutcome;
  message: string | null;
  imported: number;
  libraryName: string | null;
}

export function webSerialNotificationGroupKey(jobId: number): string {
  return `web-serial-job:${jobId}`;
}

export function buildWebSerialOutcomeNotification(input: WebSerialOutcomeInput): { groupKey: string; patch: NotificationPatch } {
  const title = input.title.length > TITLE_MAX_LENGTH ? `${input.title.slice(0, TITLE_MAX_LENGTH - 1)}...` : input.title;
  const added = `${input.imported} ${input.noun}${input.imported === 1 ? '' : 's'} added${input.libraryName ? ` to ${input.libraryName}` : ''}.`;
  const patch: NotificationPatch = {
    completed: {
      type: NotificationType.WebSerialCompleted,
      title: `${title} is in your library`,
      message: added,
    },
    completed_with_gaps: {
      type: NotificationType.WebSerialCompletedWithGaps,
      title: `${title} was added with gaps`,
      message: input.message ?? added,
    },
    failed: {
      type: NotificationType.WebSerialFailed,
      title: `${title} could not be downloaded`,
      message: input.message ?? undefined,
    },
  }[input.outcome] as NotificationPatch;
  return { groupKey: webSerialNotificationGroupKey(input.jobId), patch: { ...patch, actionUrl: WEB_SERIAL_QUEUE_URL, meta: { jobId: input.jobId } } };
}
