import { Test } from '@nestjs/testing';

import { appConfig } from '../../config/config';
import { ChapterEditorService } from '../chapter-editor/chapter-editor.service';
import { AudioConvertConverterService } from './audio-convert-converter.service';
import { AudioConvertPipelineService } from './audio-convert-pipeline.service';
import { AudioConvertRepository } from './audio-convert.repository';
import type { AudioConvertJobRow, AudioConvertSettingsRow } from './schema/audio-convert.schema';

const settings = {
  id: 1,
  enabled: true,
  autoConvert: true,
  codec: 'auto',
  bitrate: '128k',
  channels: null,
  embedChapters: true,
  embedMetadata: true,
  backupDays: 14,
  updatedAt: new Date(),
  updatedByUserId: 3,
} satisfies AudioConvertSettingsRow;

function job(overrides: Partial<AudioConvertJobRow> = {}): AudioConvertJobRow {
  return {
    id: 'job-1',
    bookId: 9,
    libraryId: 2,
    userId: 3,
    trigger: 'auto',
    status: 'waiting',
    stage: 'metadata',
    progress: null,
    codec: 'auto',
    bitrate: '128k',
    channels: null,
    codecUsed: null,
    attempts: 0,
    nextStepAt: new Date(),
    stageStartedAt: null,
    errorCode: null,
    errorMessage: null,
    result: { warnings: [] },
    workPaths: null,
    backupPath: null,
    backupDeletedAt: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

const mp3 = (id: number) => ({
  id,
  absolutePath: `/b/${id}.mp3`,
  relPath: null,
  format: 'mp3',
  sizeBytes: 1,
  durationSeconds: 1,
  sortOrder: id,
  libraryFolderId: 1,
  ino: 1n,
});

async function setup() {
  const repo = {
    getSettings: vi.fn().mockResolvedValue(settings),
    clearWatch: vi.fn().mockResolvedValue(undefined),
    skipWaitingJobs: vi.fn().mockResolvedValue(0),
    quietWatchedBooks: vi.fn().mockResolvedValue([]),
    waitingJobsDue: vi.fn().mockResolvedValue([]),
    unwatch: vi.fn().mockResolvedValue(undefined),
    hasAnyJob: vi.fn().mockResolvedValue(false),
    findContentAudioFiles: vi.fn().mockResolvedValue([mp3(1), mp3(2)]),
    createJob: vi.fn().mockImplementation((values: Partial<AudioConvertJobRow>) => Promise.resolve(job(values))),
    findBook: vi.fn().mockResolvedValue({ bookId: 9, lastMetadataFetchAt: null }),
    metadataFetchState: vi.fn().mockResolvedValue('none'),
    requestMetadataFetch: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn().mockResolvedValue(job()),
    claimChapterLookup: vi.fn().mockResolvedValue(true),
  };
  const chapters = { bulkLookup: vi.fn().mockResolvedValue({ status: 'applied' }) };
  const converter = { plan: vi.fn().mockResolvedValue({ status: 'can_convert' }) };
  const module = await Test.createTestingModule({
    providers: [
      AudioConvertPipelineService,
      { provide: AudioConvertRepository, useValue: repo },
      { provide: ChapterEditorService, useValue: chapters },
      { provide: AudioConvertConverterService, useValue: converter },
      { provide: appConfig.KEY, useValue: { nodeEnv: 'test' } },
    ],
  }).compile();
  return { pipeline: module.get(AudioConvertPipelineService), repo, chapters, converter };
}

describe('AudioConvertPipelineService', () => {
  describe('admission', () => {
    it('admits a quiet all-MP3 book whose plan can convert', async () => {
      const { pipeline, repo } = await setup();
      repo.quietWatchedBooks.mockResolvedValue([{ bookId: 9, libraryId: 2 }]);
      await pipeline.admitQuietBooks(settings);
      expect(repo.unwatch).toHaveBeenCalledWith(9);
      expect(repo.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 9, status: 'waiting', stage: 'metadata', trigger: 'auto', userId: 3 }),
      );
    });

    it.each(['cannot', 'converted', 'waiting'] as const)('does not admit a book whose plan is %s', async (status) => {
      const { pipeline, repo, converter } = await setup();
      repo.quietWatchedBooks.mockResolvedValue([{ bookId: 9, libraryId: 2 }]);
      converter.plan.mockResolvedValue({ status });
      await pipeline.admitQuietBooks(settings);
      expect(repo.createJob).not.toHaveBeenCalled();
    });

    it('skips books that had a job before or are not all MP3', async () => {
      const { pipeline, repo } = await setup();
      repo.quietWatchedBooks.mockResolvedValue([
        { bookId: 9, libraryId: 2 },
        { bookId: 10, libraryId: 2 },
      ]);
      repo.hasAnyJob.mockImplementation((bookId: number) => Promise.resolve(bookId === 9));
      repo.findContentAudioFiles.mockResolvedValue([mp3(1), { ...mp3(2), format: 'm4b' }]);
      await pipeline.admitQuietBooks(settings);
      expect(repo.createJob).not.toHaveBeenCalled();
    });
  });

  describe('switch off', () => {
    it('skips waiting jobs when automatic conversion is turned off, instead of stranding them', async () => {
      const { pipeline, repo } = await setup();
      repo.getSettings.mockResolvedValue({ ...settings, autoConvert: false });
      await pipeline.tick();
      expect(repo.clearWatch).toHaveBeenCalled();
      expect(repo.skipWaitingJobs).toHaveBeenCalledWith('disabled');
      expect(repo.waitingJobsDue).not.toHaveBeenCalled();
    });

    it('only pauses waiting jobs while the tool itself is off', async () => {
      const { pipeline, repo } = await setup();
      repo.getSettings.mockResolvedValue({ ...settings, enabled: false });
      await pipeline.tick();
      expect(repo.skipWaitingJobs).not.toHaveBeenCalled();
    });
  });

  describe('metadata stage', () => {
    it('requests a fetch when none is queued, then waits', async () => {
      const { pipeline, repo } = await setup();
      await pipeline.step(job(), settings);
      expect(repo.requestMetadataFetch).toHaveBeenCalledWith(9);
      expect(repo.transition).toHaveBeenCalledWith('job-1', ['waiting'], expect.objectContaining({ stageStartedAt: expect.any(Date) }));
    });

    it('moves on at once when the book was fetched before and nothing is pending', async () => {
      const { pipeline, repo } = await setup();
      repo.findBook.mockResolvedValue({ bookId: 9, lastMetadataFetchAt: new Date(0) });
      await pipeline.step(job(), settings);
      expect(repo.requestMetadataFetch).not.toHaveBeenCalled();
      expect(repo.transition).toHaveBeenCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ stage: 'chapters', result: expect.objectContaining({ metadata: 'already_fetched' }) }),
      );
    });

    it('keeps waiting while the fetch is pending and gives up after a day', async () => {
      const { pipeline, repo } = await setup();
      repo.metadataFetchState.mockResolvedValue('pending');
      await pipeline.step(job({ stageStartedAt: new Date(Date.now() - 60_000) }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith('job-1', ['waiting'], { nextStepAt: expect.any(Date) });

      await pipeline.step(job({ stageStartedAt: new Date(Date.now() - 25 * 60 * 60_000) }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ stage: 'chapters', result: expect.objectContaining({ metadata: 'timed_out' }) }),
      );
    });

    it('records a fetched book and a failed fetch', async () => {
      const { pipeline, repo } = await setup();
      const started = new Date(Date.now() - 60_000);
      repo.findBook.mockResolvedValue({ bookId: 9, lastMetadataFetchAt: new Date() });
      await pipeline.step(job({ stageStartedAt: started }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ result: expect.objectContaining({ metadata: 'fetched' }) }),
      );

      repo.metadataFetchState.mockResolvedValue('failed');
      await pipeline.step(job({ stageStartedAt: started }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ result: expect.objectContaining({ metadata: 'failed' }) }),
      );
    });

    it('skips a job whose book is gone', async () => {
      const { pipeline, repo } = await setup();
      repo.findBook.mockResolvedValue(null);
      await pipeline.step(job(), settings);
      expect(repo.transition).toHaveBeenCalledWith('job-1', ['waiting'], expect.objectContaining({ status: 'skipped', errorCode: 'book_missing' }));
    });
  });

  describe('chapters stage', () => {
    it.each(['applied', 'review', 'not_found', 'skipped'] as const)('queues the job with outcome %s', async (status) => {
      const { pipeline, repo, chapters } = await setup();
      chapters.bulkLookup.mockResolvedValue({ status });
      await pipeline.step(job({ stage: 'chapters' }), settings);
      expect(chapters.bulkLookup).toHaveBeenCalledWith(9, 3);
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({
          status: 'queued',
          stage: 'ready',
          stageStartedAt: null,
          result: expect.objectContaining({ chaptersLookup: status }),
        }),
      );
    });

    it('holds the lookup so convert-now cannot race it, and does nothing when it cannot take it', async () => {
      const { pipeline, repo, chapters } = await setup();
      const order: string[] = [];
      repo.claimChapterLookup.mockImplementation(() => {
        order.push('claim');
        return Promise.resolve(true);
      });
      chapters.bulkLookup.mockImplementation(() => {
        order.push('lookup');
        return Promise.resolve({ status: 'applied' });
      });
      await pipeline.step(job({ stage: 'chapters' }), settings);
      expect(order).toEqual(['claim', 'lookup']);

      repo.claimChapterLookup.mockResolvedValue(false);
      chapters.bulkLookup.mockClear();
      repo.transition.mockClear();
      await pipeline.step(job({ stage: 'chapters' }), settings);
      expect(chapters.bulkLookup).not.toHaveBeenCalled();
      expect(repo.transition).not.toHaveBeenCalled();
    });

    it('retries a thrown lookup twice, then converts anyway', async () => {
      const { pipeline, repo, chapters } = await setup();
      chapters.bulkLookup.mockRejectedValue(new Error('provider down'));
      await pipeline.step(job({ stage: 'chapters', attempts: 0 }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith('job-1', ['waiting'], expect.objectContaining({ attempts: 1, stageStartedAt: null }));
      await pipeline.step(job({ stage: 'chapters', attempts: 1 }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith('job-1', ['waiting'], expect.objectContaining({ attempts: 2 }));
      await pipeline.step(job({ stage: 'chapters', attempts: 2 }), settings);
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ status: 'queued', result: expect.objectContaining({ chaptersLookup: 'failed' }) }),
      );
    });

    it('skips the lookup when no admin saved the settings', async () => {
      const { pipeline, repo, chapters } = await setup();
      await pipeline.step(job({ stage: 'chapters', userId: null }), { ...settings, updatedByUserId: null });
      expect(chapters.bulkLookup).not.toHaveBeenCalled();
      expect(repo.transition).toHaveBeenLastCalledWith(
        'job-1',
        ['waiting'],
        expect.objectContaining({ result: expect.objectContaining({ chaptersLookup: 'skipped' }) }),
      );
    });
  });
});
