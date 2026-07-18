import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UserService } from '../user/user.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';
import {
  AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS,
  AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY,
  AUDIOBOOKSHELF_SCHEDULER_CRON,
  AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE,
} from './audiobookshelf.constants';

@Injectable()
export class AudiobookshelfSyncSchedulerService {
  private readonly logger = new Logger(AudiobookshelfSyncSchedulerService.name);
  // Overlap guard: a single tick runs at a time. If the previous run is still in flight we skip the
  // tick rather than stacking runs (per-request timeouts in the client keep a slow ABS from wedging).
  private running = false;
  // Executed-run counter driving the deep-scan cadence. Incremented only when a tick actually runs,
  // so overlap-skipped ticks do not drift the cadence.
  private runCount = 0;

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly syncService: AudiobookshelfSyncService,
    private readonly userService: UserService,
  ) {}

  @Cron(AUDIOBOOKSHELF_SCHEDULER_CRON)
  async runScheduledSync(): Promise<void> {
    if (this.running) {
      this.logger.log('[abs.scheduler] [start] skipped=true - previous run still in flight');
      return;
    }
    this.running = true;
    this.runCount++;
    const deepScan = this.runCount % AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS === 0;
    const startedAt = Date.now();
    this.logger.log(`[abs.scheduler] [start] runCount=${this.runCount} deepScan=${deepScan} - scheduled sync started`);

    let usersProcessed = 0;
    let usersFailed = 0;
    try {
      let afterUserId = 0;
      while (true) {
        const userIds = await this.repo.findEnabledConfiguredUserIds(afterUserId, AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE);
        if (userIds.length === 0) break;
        afterUserId = userIds[userIds.length - 1]!;

        for (const group of chunk(userIds, AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY)) {
          const outcomes = await Promise.all(group.map((userId) => this.syncUser(userId, deepScan)));
          for (const outcome of outcomes) {
            if (outcome === 'processed') usersProcessed++;
            else if (outcome === 'failed') usersFailed++;
          }
        }

        if (userIds.length < AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE) break;
      }

      this.logger.log(
        `[abs.scheduler] [end] runCount=${this.runCount} deepScan=${deepScan} durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} - scheduled sync completed`,
      );
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[abs.scheduler] [fail] runCount=${this.runCount} durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} errorClass=${errorClass} error="${error}" - scheduled sync failed`,
      );
    } finally {
      this.running = false;
    }
  }

  private async syncUser(userId: number, deepScan: boolean): Promise<'processed' | 'failed' | 'skipped'> {
    let user: RequestUser | null;
    try {
      user = await this.userService.findByIdWithPermissions(userId);
    } catch {
      user = null;
    }
    if (!user || !user.active) return 'skipped';
    if (!user.isSuperuser && !user.permissions.includes(Permission.AudiobookshelfSync)) return 'skipped';

    try {
      // Reconcile the full inventory only on the slow deep cadence; frequent ticks just poll progress.
      await this.syncService.sync(user, { deepSessions: deepScan, reconcile: deepScan });
      return 'processed';
    } catch (err) {
      // Skip-and-continue on the per-user in-flight guard (a manual sync is already running) - not a
      // failure. Everything else is isolated per user (sync already records settings.lastSyncError)
      // so one user's failure never halts the loop.
      if (err instanceof ConflictException) return 'skipped';
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[abs.scheduler] [fail] userId=${userId} errorClass=${errorClass} error="${error}" - user sync failed`);
      return 'failed';
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
