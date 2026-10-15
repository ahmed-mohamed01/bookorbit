import type { WebSerialJobCurrentUnit } from '@bookorbit/types';
import type {
  EngineConnection,
  EngineSeries,
  EngineUnitHandle,
  EngineUnitRunningProgress,
  EngineUnitSpec,
  WebSerialEngineClient,
} from './engines/web-serial-engine';
import type { WebSerialJobRow } from './schema/web-serials.schema';
import type { FailureReason } from './web-serials-failure.utils';

export const JOB_EVENT = 'web_serials.job';
export const ITEM_EVENT = 'web_serials.job_item';
export const ERROR_MAX_LENGTH = 300;

export interface ItemRemoteRef {
  unit?: EngineUnitSpec;
  handle?: EngineUnitHandle['remote'] | null;
  member?: { index: number; handle: EngineUnitHandle['remote'] } | null;
  attempts?: number;
  retryAt?: string;
  retryReason?: FailureReason;
}

export interface JobContext {
  job: WebSerialJobRow;
  client: WebSerialEngineClient;
  connection: EngineConnection;
  remoteId: string;
  series: EngineSeries;
  /** Aborted when the app shuts down or the job is cancelled, so an in-flight download stops at once. */
  signal: AbortSignal;
}

export type CurrentUnitMapper = (progress: EngineUnitRunningProgress) => WebSerialJobCurrentUnit;

/** What the job runner lends to the collaborators it hands work to, so their waits and clock stay the runner's own. */
export interface RunnerOps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  isStopping(): boolean;
  shouldStop(jobId: number): Promise<boolean>;
  writeCurrentUnit(jobId: number, current: WebSerialJobCurrentUnit | null): Promise<void>;
  waitForUnit(context: JobContext, handle: EngineUnitHandle, toCurrent: CurrentUnitMapper): Promise<boolean>;
  resolveTargetFolder(job: WebSerialJobRow): Promise<number>;
}

export class JobStopped extends Error {}

/** Item-level failure whose message is already safe to store and show. */
export class ItemFailure extends Error {
  constructor(
    message: string,
    readonly reason?: FailureReason,
  ) {
    super(message);
  }
}

export function unitNoun(job: Pick<WebSerialJobRow, 'kind' | 'packaging'>): string {
  if (job.packaging === 'series') return 'book';
  if (job.packaging === 'volume' || job.kind === 'novel') return 'volume';
  return 'chapter';
}

export function importingUnit(label: string): WebSerialJobCurrentUnit {
  return { label, stage: 'importing', chaptersDone: null, chaptersTotal: null, progress: null };
}
