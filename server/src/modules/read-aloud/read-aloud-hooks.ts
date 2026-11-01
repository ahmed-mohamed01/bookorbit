import type { ReadAloudWorkerRequest } from '@bookorbit/types';

import type { ReadAloudJobRow } from '../../db/schema';

/**
 * Extension seam for the read-aloud worker dispatcher and its housekeeping.
 *
 * Another module may run its own jobs on the same worker and work root, and may adjust or observe
 * the read-aloud jobs this module runs. With no provider registered every hook is a no-op and the
 * dispatcher behaves exactly as it does without this seam.
 */
export const READ_ALOUD_HOOKS = Symbol('READ_ALOUD_HOOKS');

export interface ReadAloudHooks {
  /** True for a worker job another module owns, so the dispatcher neither adopts nor cancels it. */
  ownsWorkerJob(jobId: string): Promise<boolean>;
  /** Work folders (job ids) another module still needs, kept by the orphan folder sweep. */
  keepWorkFolders(): Promise<Iterable<string>>;
  /** Last chance to adjust a job's worker request before it is submitted. */
  prepareRequest(job: ReadAloudJobRow, request: ReadAloudWorkerRequest): Promise<ReadAloudWorkerRequest>;
  /** Called once the job's output validated, while its work folder still exists. Must not throw. */
  onOutputValidated(job: ReadAloudJobRow, request: ReadAloudWorkerRequest): Promise<void>;
}

export const NO_READ_ALOUD_HOOKS: ReadAloudHooks = {
  ownsWorkerJob: () => Promise.resolve(false),
  keepWorkFolders: () => Promise.resolve([]),
  prepareRequest: (_job, request) => Promise.resolve(request),
  onOutputValidated: () => Promise.resolve(),
};
