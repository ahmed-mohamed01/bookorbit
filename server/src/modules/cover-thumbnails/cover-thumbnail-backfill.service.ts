import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type {
  CoverThumbnailBackfillCounts,
  CoverThumbnailBackfillOutcome,
  CoverThumbnailBackfillRun,
  CoverThumbnailBackfillState,
  CoverThumbnailBackfillTrigger,
} from '@bookorbit/types';
import { access } from 'fs/promises';

import { bookCoverSlotThumbnailPath } from '../../common/book-cover-storage';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import { CoverThumbnailBackfillRepository, type ThumbnailBackfillCursor } from './cover-thumbnail-backfill.repository';

export const THUMBNAIL_BACKFILL_STARTUP_DELAY_MS = 2 * 60 * 1000;
export const THUMBNAIL_BACKFILL_PAGE_SIZE = 500;
export const THUMBNAIL_BACKFILL_ENABLED_KEY = 'fork_cover_thumbnail_backfill_enabled';
export const THUMBNAIL_BACKFILL_LAST_RUN_KEY = 'fork_cover_thumbnail_backfill_last_run';
const THUMBNAIL_BACKFILL_CRON = '0 30 4 * * *';

type ActiveRun = CoverThumbnailBackfillCounts & { trigger: CoverThumbnailBackfillTrigger; startedAt: string; cancelled: boolean };

/**
 * Makes thumbnails that are missing beside a cover before a client asks for them, so a library
 * grid never waits on a resize of a large original. One slot at a time, so live requests keep the
 * repair slots.
 */
@Injectable()
export class CoverThumbnailBackfillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CoverThumbnailBackfillService.name);
  private readonly appDataPath: string;
  private startupTimer: NodeJS.Timeout | null = null;
  private active: ActiveRun | null = null;
  private activePromise: Promise<CoverThumbnailBackfillRun | null> | null = null;
  private destroyed = false;

  constructor(
    config: ConfigService,
    private readonly repository: CoverThumbnailBackfillRepository,
    private readonly store: BookCoverStore,
    private readonly appSettings: AppSettingsService,
  ) {
    this.appDataPath = config.getOrThrow<string>('storage.appDataPath');
  }

  onApplicationBootstrap(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runIfEnabled('startup');
    }, THUMBNAIL_BACKFILL_STARTUP_DELAY_MS);
    this.startupTimer.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.active) this.active.cancelled = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  @Cron(THUMBNAIL_BACKFILL_CRON)
  async runScheduled(): Promise<void> {
    await this.runIfEnabled('schedule');
  }

  async getState(): Promise<CoverThumbnailBackfillState> {
    const values = await this.appSettings.getValues([THUMBNAIL_BACKFILL_ENABLED_KEY, THUMBNAIL_BACKFILL_LAST_RUN_KEY]);
    const active = this.active;
    return {
      enabled: values.get(THUMBNAIL_BACKFILL_ENABLED_KEY) !== 'false',
      running: active
        ? {
            trigger: active.trigger,
            startedAt: active.startedAt,
            scanned: active.scanned,
            missing: active.missing,
            made: active.made,
            unresolved: active.unresolved,
          }
        : null,
      lastRun: parseLastRun(values.get(THUMBNAIL_BACKFILL_LAST_RUN_KEY)),
    };
  }

  /** Turning the switch off also stops a run that is going. */
  async setEnabled(user: RequestUser, enabled: boolean): Promise<CoverThumbnailBackfillState> {
    await this.appSettings.setValue(THUMBNAIL_BACKFILL_ENABLED_KEY, String(enabled));
    const stoppedRun = !enabled && this.active !== null;
    if (this.active && !enabled) this.active.cancelled = true;
    this.logger.log(
      `[cover.thumbnail_backfill_settings] [end] userId=${user.id} enabled=${enabled} stoppedRun=${stoppedRun} - backfill setting saved`,
    );
    return this.getState();
  }

  /** Starts a run in the background and returns at once; joins a run that is already going. */
  async startManual(user: RequestUser): Promise<CoverThumbnailBackfillState> {
    if (!this.active) {
      this.logger.log(`[cover.thumbnail_backfill_settings] [end] userId=${user.id} action=run_now - backfill run requested`);
      void this.run('manual');
    }
    return this.getState();
  }

  async run(trigger: CoverThumbnailBackfillTrigger): Promise<CoverThumbnailBackfillRun | null> {
    if (this.destroyed) return null;
    if (this.activePromise) return null;
    this.active = { trigger, startedAt: new Date().toISOString(), scanned: 0, missing: 0, made: 0, unresolved: 0, cancelled: false };
    this.activePromise = this.execute(this.active);
    try {
      return await this.activePromise;
    } finally {
      this.active = null;
      this.activePromise = null;
    }
  }

  private async runIfEnabled(trigger: CoverThumbnailBackfillTrigger): Promise<void> {
    try {
      if ((await this.appSettings.getValue(THUMBNAIL_BACKFILL_ENABLED_KEY)) === 'false') return;
    } catch (error) {
      this.logFail(trigger, Date.now(), null, error);
      return;
    }
    await this.run(trigger);
  }

  private async execute(active: ActiveRun): Promise<CoverThumbnailBackfillRun | null> {
    const startedAt = Date.now();
    this.logger.log(`[cover.thumbnail_backfill] [start] trigger=${active.trigger} - thumbnail backfill started`);
    try {
      let cursor: ThumbnailBackfillCursor | null = null;
      while (!active.cancelled) {
        const slots = await this.repository.servedSlotsAfter(cursor, THUMBNAIL_BACKFILL_PAGE_SIZE);
        for (const slot of slots) {
          if (active.cancelled) break;
          active.scanned++;
          if (await this.thumbnailExists(slot)) continue;
          active.missing++;
          if (await this.store.ensureSlotThumbnail(slot.bookId, slot.medium)) active.made++;
          else active.unresolved++;
        }
        if (slots.length < THUMBNAIL_BACKFILL_PAGE_SIZE) break;
        cursor = slots[slots.length - 1];
      }
      const outcome: CoverThumbnailBackfillOutcome = active.cancelled ? 'stopped' : 'completed';
      const run = await this.record(active, startedAt, outcome);
      this.logger.log(
        `[cover.thumbnail_backfill] [end] trigger=${active.trigger} durationMs=${run.durationMs} scanned=${run.scanned} missing=${run.missing} made=${run.made} unresolved=${run.unresolved} outcome=${outcome} - thumbnail backfill completed`,
      );
      return run;
    } catch (error) {
      this.logFail(active.trigger, startedAt, active, error);
      await this.record(active, startedAt, 'failed').catch(() => undefined);
      return null;
    }
  }

  private async record(active: ActiveRun, startedAt: number, outcome: CoverThumbnailBackfillOutcome): Promise<CoverThumbnailBackfillRun> {
    const run: CoverThumbnailBackfillRun = {
      trigger: active.trigger,
      outcome,
      startedAt: active.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      scanned: active.scanned,
      missing: active.missing,
      made: active.made,
      unresolved: active.unresolved,
    };
    await this.appSettings.setValue(THUMBNAIL_BACKFILL_LAST_RUN_KEY, JSON.stringify(run));
    return run;
  }

  private logFail(trigger: CoverThumbnailBackfillTrigger, startedAt: number, counts: CoverThumbnailBackfillCounts | null, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[cover.thumbnail_backfill] [fail] trigger=${trigger} durationMs=${Date.now() - startedAt} scanned=${counts?.scanned ?? 0} made=${counts?.made ?? 0} errorClass=${errorClass} error="${message}" - thumbnail backfill failed`,
    );
  }

  private async thumbnailExists(slot: ThumbnailBackfillCursor): Promise<boolean> {
    try {
      await access(bookCoverSlotThumbnailPath(this.appDataPath, slot.bookId, slot.medium));
      return true;
    } catch {
      return false;
    }
  }
}

function parseLastRun(raw: string | undefined): CoverThumbnailBackfillRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CoverThumbnailBackfillRun;
    return typeof parsed?.finishedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
