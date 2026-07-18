import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UserService } from '../user/user.service';
import { AudiobookshelfRepository, type AbsEnabledUser } from './audiobookshelf.repository';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';
import {
  AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS,
  AUDIOBOOKSHELF_DEEP_SCAN_INTERVAL_MS,
  AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY,
  AUDIOBOOKSHELF_SCHEDULER_CRON,
  AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS,
  AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE,
} from './audiobookshelf.constants';

/**
 * Per-user deep-scan decision. A user is deep-due when it has never been deep-scanned or its last scan
 * predates the deep interval, AND the current tick is this user's stagger slice. The slice
 * (`userId mod slices == tick mod slices`) spreads users across the interval's ticks so a never-scanned
 * cohort does not all deep-scan at once. The interval check tolerates one tick of clock jitter so the
 * user reliably becomes due when its slice next comes around.
 */
export function isDeepSessionScanDue(lastScanAt: Date | null, userId: number, now: number): boolean {
  const currentSlice = Math.floor(now / AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS) % AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS;
  if (userId % AUDIOBOOKSHELF_DEEP_SCAN_EVERY_N_RUNS !== currentSlice) return false;
  if (lastScanAt == null) return true;
  return now - lastScanAt.getTime() >= AUDIOBOOKSHELF_DEEP_SCAN_INTERVAL_MS - AUDIOBOOKSHELF_SCHEDULER_INTERVAL_MS;
}

@Injectable()
export class AudiobookshelfSyncSchedulerService {
  private readonly logger = new Logger(AudiobookshelfSyncSchedulerService.name);
  // Overlap guard: a single tick runs at a time. If the previous run is still in flight we skip the
  // tick rather than stacking runs (per-request timeouts in the client keep a slow ABS from wedging).
  private running = false;

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
    const now = Date.now();
    const startedAt = now;
    this.logger.log('[abs.scheduler] [start] - scheduled sync started');

    let usersProcessed = 0;
    let usersFailed = 0;
    let usersDeepScanned = 0;
    try {
      let afterUserId = 0;
      while (true) {
        const users = await this.repo.findEnabledConfiguredUsers(afterUserId, AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE);
        if (users.length === 0) break;
        afterUserId = users[users.length - 1]!.userId;

        for (const group of chunk(users, AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY)) {
          const outcomes = await Promise.all(group.map((user) => this.syncUser(user, now)));
          for (const outcome of outcomes) {
            if (outcome.result === 'processed') usersProcessed++;
            else if (outcome.result === 'failed') usersFailed++;
            if (outcome.deepScan) usersDeepScanned++;
          }
        }

        if (users.length < AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE) break;
      }

      this.logger.log(
        `[abs.scheduler] [end] durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} usersDeepScanned=${usersDeepScanned} - scheduled sync completed`,
      );
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[abs.scheduler] [fail] durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} errorClass=${errorClass} error="${error}" - scheduled sync failed`,
      );
    } finally {
      this.running = false;
    }
  }

  private async syncUser(enabledUser: AbsEnabledUser, now: number): Promise<{ result: 'processed' | 'failed' | 'skipped'; deepScan: boolean }> {
    const deepScan = isDeepSessionScanDue(enabledUser.lastDeepSessionScanAt, enabledUser.userId, now);

    let user: RequestUser | null;
    try {
      user = await this.userService.findByIdWithPermissions(enabledUser.userId);
    } catch {
      user = null;
    }
    if (!user || !user.active) return { result: 'skipped', deepScan: false };
    if (!user.isSuperuser && !user.permissions.includes(Permission.AudiobookshelfSync)) return { result: 'skipped', deepScan: false };

    try {
      // Reconcile the full inventory only on the per-user deep cadence; frequent ticks just poll progress.
      await this.syncService.sync(user, { deepSessions: deepScan, reconcile: deepScan });
      // Stamp the deep watermark only after a successful deep run so the next deep is one interval out.
      if (deepScan) {
        await this.repo.updateSettings(enabledUser.userId, { lastDeepSessionScanAt: new Date() });
      }
      return { result: 'processed', deepScan };
    } catch (err) {
      // Skip-and-continue on the per-user in-flight guard (a manual sync is already running) - not a
      // failure. Everything else is isolated per user (sync already records settings.lastSyncError)
      // so one user's failure never halts the loop.
      if (err instanceof ConflictException) return { result: 'skipped', deepScan: false };
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[abs.scheduler] [fail] userId=${enabledUser.userId} errorClass=${errorClass} error="${error}" - user sync failed`);
      return { result: 'failed', deepScan: false };
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
