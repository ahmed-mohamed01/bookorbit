import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookMetadataLockService } from '../book-metadata-lock/book-metadata-lock.service';
import { MetadataService } from '../metadata/metadata.service';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { describeError } from './web-serials-log.utils';
import { WebSerialsSchemaBootstrapService } from './web-serials-schema-bootstrap.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsRepository } from './web-serials.repository';

const BACKFILL_EVENT = 'web_serials.illustrator_backfill';
const BATCH_SIZE = 100;
const LOOKUP_PAUSE_MS = 500;
const MATCH_KEY_PREFIX = 'mb:';

export type IllustratorBackfillOutcome = 'done' | 'already_done' | 'lookup_disabled' | 'interrupted' | 'failed';

/**
 * Books filed before light novels carried their illustrators (and manga filed without artists) get the artists of their
 * MangaBaka series once per install. A run the breaker or a shutdown cuts short is not marked done, so the next boot resumes.
 */
@Injectable()
export class WebSerialsIllustratorBackfillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebSerialsIllustratorBackfillService.name);
  private readonly controller = new AbortController();

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly bootstrap: WebSerialsSchemaBootstrapService,
    private readonly settings: WebSerialsSettingsService,
    private readonly lookup: WebSerialsLookupService,
    private readonly metadata: MetadataService,
    private readonly locks: BookMetadataLockService,
  ) {}

  onApplicationBootstrap(): void {
    void this.run();
  }

  onModuleDestroy(): void {
    this.controller.abort();
  }

  /** Overridden in tests: the pause between two MangaBaka lookups. */
  protected sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async run(): Promise<IllustratorBackfillOutcome> {
    const startedAt = Date.now();
    const signal = this.controller.signal;
    let booksChecked = 0;
    let booksUpdated = 0;
    let lookups = 0;
    let lookupsFailed = 0;
    try {
      await this.bootstrap.ready;
      if (await this.repo.isIllustratorBackfillDone()) return 'already_done';
      if (!(await this.settings.getSettings()).lookup.enabled) return 'lookup_disabled';

      this.logger.log(`[${BACKFILL_EVENT}] [start] batchSize=${BATCH_SIZE} - illustrator backfill started`);
      const artistsByMatchId = new Map<string, string[]>();
      let afterBookId = 0;
      let interrupted = false;

      batches: for (;;) {
        const rows = await this.repo.findIllustratorBackfillBooks(afterBookId, BATCH_SIZE);
        if (rows.length === 0) break;
        afterBookId = rows[rows.length - 1]!.bookId;
        booksChecked += rows.length;

        const missing = rows.filter((row) => !row.hasPencillers);
        if (missing.length === 0) continue;
        const locked = await this.locks.getBookIdsWithLockedField(
          missing.map((row) => row.bookId),
          'comicPencillers',
        );

        for (const row of missing) {
          if (locked.has(row.bookId)) continue;
          const matchId = row.matchKey.slice(MATCH_KEY_PREFIX.length);
          let artists = artistsByMatchId.get(matchId);
          if (artists === undefined) {
            if (signal.aborted || this.lookup.isPaused()) {
              interrupted = true;
              break batches;
            }
            if (lookups > 0) await this.sleep(LOOKUP_PAUSE_MS, signal);
            lookups += 1;
            const match = await this.lookup.getMatch(matchId, row.kind);
            if (!match) lookupsFailed += 1;
            artists = match?.artists ?? [];
            artistsByMatchId.set(matchId, artists);
          }
          if (artists.length === 0 || (await this.repo.bookHasPencillers(row.bookId))) continue;
          await this.metadata.upsertComicMetadata(row.bookId, { pencillers: artists });
          booksUpdated += 1;
        }
      }

      if (!interrupted) await this.repo.markIllustratorBackfillDone();
      this.logger.log(
        `[${BACKFILL_EVENT}] [end] durationMs=${Date.now() - startedAt} booksChecked=${booksChecked} booksUpdated=${booksUpdated} lookups=${lookups} lookupsFailed=${lookupsFailed} completed=${!interrupted} - illustrator backfill finished`,
      );
      return interrupted ? 'interrupted' : 'done';
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${BACKFILL_EVENT}] [fail] durationMs=${Date.now() - startedAt} booksChecked=${booksChecked} booksUpdated=${booksUpdated} lookupsFailed=${lookupsFailed} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - illustrator backfill failed`,
      );
      return 'failed';
    }
  }
}
