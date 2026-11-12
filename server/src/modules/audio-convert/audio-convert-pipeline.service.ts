import { AUDIO_CONVERT_NEW_BOOK_QUIET_MINUTES, type AudioConvertChapterOutcome, type AudioConvertMetadataOutcome } from '@bookorbit/types';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { orderAudiobookTracks } from '../../common/utils/audiobook-chapters.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { appConfig } from '../../config/config';
import { ChapterEditorService } from '../chapter-editor/chapter-editor.service';
import { AudioConvertConverterService } from './audio-convert-converter.service';
import { AudioConvertRepository } from './audio-convert.repository';
import { errorClass, errorMessage } from './audio-convert.utils';
import type { AudioConvertJobRow, AudioConvertSettingsRow } from './schema/audio-convert.schema';

const TICK_MS = 30_000;
const STEP_POLL_MS = 30_000;
/** A metadata fetch that has not finished in a day is given up on; the book converts with what it has. */
const METADATA_TIMEOUT_MS = 24 * 60 * 60_000;
/** A queue row that vanished without a fetch being recorded is treated as failed after this long. */
const METADATA_VANISHED_MS = 5 * 60_000;
const CHAPTER_RETRY_MS = [60_000, 5 * 60_000];
/** How long one chapter lookup may hold its job; past this a crashed lookup is taken again. */
const CHAPTER_LOOKUP_LEASE_MS = 10 * 60_000;
const BATCH = 20;
const EVENT = 'audio_convert.pipeline';

/**
 * New MP3 books: once their files stop arriving, fill metadata, fetch chapters, then queue the
 * conversion. A book goes through this once; a skipped or failed run is not retried automatically.
 */
@Injectable()
export class AudioConvertPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioConvertPipelineService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: AudioConvertRepository,
    private readonly chapters: ChapterEditorService,
    private readonly converter: AudioConvertConverterService,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {}

  onModuleInit(): void {
    if (this.app.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const settings = await this.repo.getSettings();
      if (!settings.enabled || !settings.autoConvert) {
        // Turning the switch on later only affects books added after that.
        await this.repo.clearWatch();
        // With the switch off nothing would ever move a waiting job on; end them instead of leaving
        // them waiting forever. The tool being off only pauses them.
        if (!settings.autoConvert) {
          const skipped = await this.repo.skipWaitingJobs('disabled');
          if (skipped > 0)
            this.logger.log(
              `[${EVENT}] [end] durationMs=${Date.now() - startedAt} skipped=${skipped} - waiting books skipped, automatic conversion is off`,
            );
        }
        return;
      }
      await this.admitQuietBooks(settings);
      for (const job of await this.repo.waitingJobsDue(BATCH)) await this.step(job, settings);
    } catch (error) {
      this.logger.error(
        `[${EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - pipeline tick failed`,
      );
    } finally {
      this.running = false;
    }
  }

  async admitQuietBooks(settings: AudioConvertSettingsRow): Promise<void> {
    const books = await this.repo.quietWatchedBooks(AUDIO_CONVERT_NEW_BOOK_QUIET_MINUTES * 60_000, BATCH);
    for (const { bookId, libraryId } of books) {
      await this.repo.unwatch(bookId);
      if (await this.repo.hasAnyJob(bookId)) continue;
      const files = orderAudiobookTracks(await this.repo.findContentAudioFiles(bookId));
      if (files.length === 0 || !files.every((file) => (file.format ?? '').toLowerCase() === 'mp3')) continue;
      // Only a book the tool can actually convert enters the pipeline (probes, writable folder, disk room).
      if ((await this.converter.plan(bookId)).status !== 'can_convert') continue;
      const job = await this.repo.createJob({
        bookId,
        libraryId,
        userId: settings.updatedByUserId,
        trigger: 'auto',
        status: 'waiting',
        stage: 'metadata',
        codec: settings.codec,
        bitrate: settings.bitrate,
        channels: settings.channels,
        nextStepAt: new Date(),
        result: { warnings: [] },
      });
      if (job) this.logger.log(`[${EVENT}] [start] jobId=${job.id} bookId=${bookId} - new MP3 book entered the pipeline`);
    }
  }

  async step(job: AudioConvertJobRow, settings: AudioConvertSettingsRow): Promise<void> {
    if (job.stage === 'metadata') return this.metadataStep(job);
    if (job.stage === 'chapters') return this.chaptersStep(job, settings);
    await this.repo.transition(job.id, ['waiting'], { status: 'queued', stage: 'ready', nextStepAt: null });
  }

  private async metadataStep(job: AudioConvertJobRow): Promise<void> {
    const book = await this.repo.findBook(job.bookId);
    if (!book) {
      await this.repo.transition(job.id, ['waiting'], { status: 'skipped', stage: null, errorCode: 'book_missing', finishedAt: new Date() });
      return;
    }
    const state = await this.repo.metadataFetchState(job.bookId);
    const now = Date.now();
    const startedAt = job.stageStartedAt?.getTime() ?? null;
    let outcome: AudioConvertMetadataOutcome | null = null;

    if (startedAt === null) {
      if (state === 'none' && book.lastMetadataFetchAt) outcome = 'already_fetched';
      else {
        if (state === 'none') await this.repo.requestMetadataFetch(job.bookId);
        await this.repo.transition(job.id, ['waiting'], { stageStartedAt: new Date(), nextStepAt: new Date(now + STEP_POLL_MS) });
        return;
      }
    } else if (state === 'failed') outcome = 'failed';
    else if (state === 'pending') {
      if (now - startedAt > METADATA_TIMEOUT_MS) outcome = 'timed_out';
    } else if (book.lastMetadataFetchAt && book.lastMetadataFetchAt.getTime() >= startedAt - 1000) outcome = 'fetched';
    else if (now - startedAt > METADATA_VANISHED_MS) outcome = 'failed';

    if (!outcome) {
      await this.repo.transition(job.id, ['waiting'], { nextStepAt: new Date(now + STEP_POLL_MS) });
      return;
    }
    await this.repo.transition(job.id, ['waiting'], {
      stage: 'chapters',
      stageStartedAt: null,
      attempts: 0,
      nextStepAt: new Date(),
      result: { ...(job.result ?? {}), metadata: outcome },
    });
  }

  /**
   * The lookup holds the job (`claimChapterLookup`) while it runs, so "Convert now" is refused until it
   * has finished and the worker never converts while chapters are still being written.
   */
  private async chaptersStep(job: AudioConvertJobRow, settings: AudioConvertSettingsRow): Promise<void> {
    let outcome: AudioConvertChapterOutcome;
    const userId = job.userId ?? settings.updatedByUserId;
    if (!(await this.repo.claimChapterLookup(job.id, new Date(Date.now() + CHAPTER_LOOKUP_LEASE_MS)))) return;
    const startedAt = Date.now();
    if (userId === null) outcome = 'skipped';
    else {
      try {
        outcome = (await this.chapters.bulkLookup(job.bookId, userId)).status;
      } catch (error) {
        const delay = CHAPTER_RETRY_MS[job.attempts];
        if (delay !== undefined) {
          await this.repo.transition(job.id, ['waiting'], {
            attempts: job.attempts + 1,
            stageStartedAt: null,
            nextStepAt: new Date(Date.now() + delay),
          });
          return;
        }
        this.logger.error(
          `[${EVENT}] [fail] jobId=${job.id} bookId=${job.bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass(error)} error="${sanitizeLogValue(errorMessage(error))}" - chapter lookup failed, converting anyway`,
        );
        outcome = 'failed';
      }
    }
    await this.repo.transition(job.id, ['waiting'], {
      status: 'queued',
      stage: 'ready',
      attempts: 0,
      stageStartedAt: null,
      nextStepAt: null,
      result: { ...(job.result ?? {}), chaptersLookup: outcome },
    });
  }
}
