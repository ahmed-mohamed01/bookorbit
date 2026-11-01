import type { ReadAloudWorkerJob, ReadAloudWorkerRequest } from '@bookorbit/types';

import { NO_READ_ALOUD_HOOKS, type ReadAloudHooks } from './read-aloud-hooks';
import { ReadAloudLifecycleService } from './read-aloud-lifecycle.service';
import { ReadAloudWorkerService } from './read-aloud-worker.service';
import { COVERAGE, JOB_ID, jobRow, okHealth, OWNER, REPORT_TOTALS } from './test-helpers';

const FOREIGN_JOB_ID = '00000000-0000-4000-8000-0000000000aa';

function completedJob(): ReadAloudWorkerJob {
  return {
    jobId: JOB_ID,
    status: 'completed',
    stage: 'validating',
    progress: 100,
    stageDetail: null,
    errorCode: null,
    error: null,
    outputBytes: 10,
    events: [],
  };
}

function workerSetup(hooks?: ReadAloudHooks) {
  const claimed = jobRow({ status: 'processing', stage: 'preparing_audio', attemptCount: 1 });
  const jobs = {
    claimNext: vi.fn().mockResolvedValue(null),
    claimQueued: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(jobRow({ status: 'processing' })),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    advanceWorkerEventSeq: vi.fn().mockResolvedValue(undefined),
    beginPublishing: vi.fn().mockResolvedValue(jobRow({ status: 'processing', stage: 'publishing' })),
    complete: vi.fn().mockResolvedValue(jobRow({ status: 'completed', outputFileId: 555 })),
    fail: vi.fn().mockResolvedValue(jobRow({ status: 'failed' })),
  };
  const worker = {
    configured: true,
    healthState: vi.fn().mockResolvedValue(okHealth()),
    start: vi.fn().mockResolvedValue(completedJob()),
    status: vi.fn(),
    cancel: vi.fn().mockResolvedValue(completedJob()),
  };
  const baseRequest = {
    jobId: JOB_ID,
    epubPath: '/library/novel/novel.epub',
    audioPaths: ['/library/novel/01.mp3'],
    workDir: `/data/read-aloud/jobs/${JOB_ID}`,
  };
  const readAloud = { resolveProcessingContext: vi.fn().mockResolvedValue({ user: OWNER, request: baseRequest }) };
  const publisher = {
    withHeartbeat: vi.fn().mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
    validate: vi.fn().mockResolvedValue({ report: REPORT_TOTALS, coverage: COVERAGE, warnings: [], requiresReview: false, outputBytes: 10 }),
    publish: vi.fn().mockResolvedValue(555),
  };
  const workspace = { ensure: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
  const activity = { record: vi.fn().mockResolvedValue(undefined), recordWorkerEvents: vi.fn().mockResolvedValue(undefined) };
  const notifier = { pushUpdate: vi.fn().mockResolvedValue(undefined), notify: vi.fn().mockResolvedValue(undefined) };
  const service = new ReadAloudWorkerService(
    { maxOutputBytes: 1e9 } as never,
    jobs as never,
    worker as never,
    readAloud as never,
    publisher as never,
    workspace as never,
    activity as never,
    notifier as never,
    hooks,
  );
  const run = () => (service as unknown as { process(job: unknown, device: string): Promise<void> }).process(claimed, 'cpu');
  return { service, run, claimed, jobs, worker, publisher, baseRequest };
}

function lifecycleSetup(hooks?: ReadAloudHooks) {
  const jobs = {
    findReviewsToRemind: vi.fn().mockResolvedValue([]),
    expireReviews: vi.fn().mockResolvedValue([]),
    clearExpiredWorkWindows: vi.fn().mockResolvedValue(undefined),
    findJobIdsKeepingWork: vi.fn().mockResolvedValue(new Set<string>([JOB_ID])),
  };
  const workspace = { listJobIds: vi.fn().mockResolvedValue([JOB_ID, FOREIGN_JOB_ID]), remove: vi.fn().mockResolvedValue(undefined) };
  const service = new ReadAloudLifecycleService(jobs as never, workspace as never, {} as never, {} as never, {} as never, hooks);
  return { service, workspace };
}

function hooksMock(overrides: Partial<ReadAloudHooks> = {}): { [K in keyof ReadAloudHooks]: ReturnType<typeof vi.fn> } {
  return {
    ownsWorkerJob: vi.fn(overrides.ownsWorkerJob ?? NO_READ_ALOUD_HOOKS.ownsWorkerJob),
    keepWorkFolders: vi.fn(overrides.keepWorkFolders ?? NO_READ_ALOUD_HOOKS.keepWorkFolders),
    prepareRequest: vi.fn(overrides.prepareRequest ?? NO_READ_ALOUD_HOOKS.prepareRequest),
    onOutputValidated: vi.fn(overrides.onOutputValidated ?? NO_READ_ALOUD_HOOKS.onOutputValidated),
  };
}

describe('read-aloud hooks seam', () => {
  describe('defaults (no provider registered)', () => {
    it('are no-ops', async () => {
      const request = { jobId: JOB_ID } as ReadAloudWorkerRequest;
      await expect(NO_READ_ALOUD_HOOKS.ownsWorkerJob(JOB_ID)).resolves.toBe(false);
      await expect(NO_READ_ALOUD_HOOKS.keepWorkFolders()).resolves.toEqual([]);
      await expect(NO_READ_ALOUD_HOOKS.prepareRequest(jobRow(), request)).resolves.toBe(request);
      await expect(NO_READ_ALOUD_HOOKS.onOutputValidated(jobRow(), request)).resolves.toBeUndefined();
    });

    it('submits the upstream request unchanged and publishes', async () => {
      const t = workerSetup();
      await t.run();
      expect(t.worker.start).toHaveBeenCalledWith({ ...t.baseRequest, maxOutputBytes: 1e9 });
      expect(t.publisher.publish).toHaveBeenCalled();
    });

    it('removes every orphan folder', async () => {
      const t = lifecycleSetup();
      await t.service.sweep();
      expect(t.workspace.remove).toHaveBeenCalledWith(FOREIGN_JOB_ID);
      expect(t.workspace.remove).not.toHaveBeenCalledWith(JOB_ID);
    });
  });

  describe('with a provider', () => {
    it('submits the request prepareRequest returns and reports the validated output with it', async () => {
      const hooks = hooksMock({
        prepareRequest: (_job, request) => Promise.resolve({ ...request, rebuild: { indexEntry: 'index.epub' } } as ReadAloudWorkerRequest),
      });
      const t = workerSetup(hooks);
      await t.run();

      const prepared = { ...t.baseRequest, maxOutputBytes: 1e9, rebuild: { indexEntry: 'index.epub' } };
      expect(hooks.prepareRequest).toHaveBeenCalledWith(t.claimed, { ...t.baseRequest, maxOutputBytes: 1e9 });
      expect(t.worker.start).toHaveBeenCalledWith(prepared);
      expect(hooks.onOutputValidated).toHaveBeenCalledWith(t.claimed, prepared);
      expect(hooks.onOutputValidated.mock.invocationCallOrder[0]).toBeLessThan(t.publisher.publish.mock.invocationCallOrder[0]!);
    });

    it('keeps the job lease alive while the provider handles the validated output', async () => {
      let heartbeatOpen = false;
      const seen: boolean[] = [];
      const hooks = hooksMock({
        onOutputValidated: () => {
          seen.push(heartbeatOpen);
          return Promise.resolve();
        },
      });
      const t = workerSetup(hooks);
      t.publisher.withHeartbeat.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => {
        heartbeatOpen = true;
        try {
          return await fn();
        } finally {
          heartbeatOpen = false;
        }
      });
      await t.run();

      expect(seen).toEqual([true]);
    });

    it('neither adopts nor cancels a worker job the provider owns', async () => {
      const hooks = hooksMock({ ownsWorkerJob: (jobId) => Promise.resolve(jobId === FOREIGN_JOB_ID) });
      const t = workerSetup(hooks);
      t.worker.healthState.mockResolvedValue(okHealth({ activeJobId: FOREIGN_JOB_ID }));
      await t.service.tick();

      expect(hooks.ownsWorkerJob).toHaveBeenCalledWith(FOREIGN_JOB_ID);
      expect(t.jobs.findById).not.toHaveBeenCalled();
      expect(t.worker.cancel).not.toHaveBeenCalled();
      expect(t.jobs.claimNext).not.toHaveBeenCalled();
    });

    it('keeps the work folders the provider names', async () => {
      const t = lifecycleSetup(hooksMock({ keepWorkFolders: () => Promise.resolve([FOREIGN_JOB_ID]) }));
      await t.service.sweep();
      expect(t.workspace.remove).not.toHaveBeenCalled();
    });
  });
});
