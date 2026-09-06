import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import type { RequestUser } from '../../common/types/request-user';
import { UserService } from '../user/user.service';
import { chunk } from '../../common/utils/batch.utils';
import { AudiobookshelfRepository, type AbsEnabledUser } from './audiobookshelf.repository';
import { AudiobookshelfSyncService, type AudiobookshelfSyncOptions } from './audiobookshelf-sync.service';
import { describeError, isEligibleSyncUser } from './audiobookshelf-user.utils';
import {
  AUDIOBOOKSHELF_HOT_SCHEDULER_CRON,
  AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY,
  AUDIOBOOKSHELF_SCHEDULER_CRON,
  AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE,
  AUDIOBOOKSHELF_WARM_SESSION_INTERVAL_MS,
} from './audiobookshelf.constants';

@Injectable()
export class AudiobookshelfSyncSchedulerService {
  private readonly logger = new Logger(AudiobookshelfSyncSchedulerService.name);
  // Overlap guards: one full run and one hot run at a time. Separate flags so a slow full poll never
  // blocks the 30s hot tier (per-request client timeouts keep a slow ABS from wedging either).
  private running = false;
  private hotRunning = false;
  // Per-user timestamp of the last hot tick that carried warmSessions. Throttles session ingest on the
  // 30s hot tier to at most once per 90s per user (position still applies every hot tick).
  private readonly lastWarmSessionAt = new Map<number, number>();

  constructor(
    private readonly repo: AudiobookshelfRepository,
    private readonly syncService: AudiobookshelfSyncService,
    private readonly userService: UserService,
  ) {}

  // Full poll: matching-if-fresh, all progress, sessions. Every 15 minutes.
  @Cron(AUDIOBOOKSHELF_SCHEDULER_CRON)
  async runScheduledSync(): Promise<void> {
    if (this.running) {
      this.logger.log('[abs.scheduler] skipped=true - previous run still in flight');
      return;
    }
    this.running = true;
    try {
      await this.runForAllUsers('abs.scheduler', {});
    } finally {
      this.running = false;
    }
  }

  // Hot tier: near-live position for in-progress books only. Every 30 seconds at :15/:45 so it never
  // fires in the same second as the full poll. Separate overlap guard so a slow full poll never blocks
  // the hot tier and vice versa; the per-user in-flight guard in sync() keeps a hot tick and a full
  // tick for the same user from colliding.
  @Cron(AUDIOBOOKSHELF_HOT_SCHEDULER_CRON)
  async runHotSync(): Promise<void> {
    if (this.hotRunning) return;
    this.hotRunning = true;
    try {
      await this.runForAllUsers('abs.scheduler.hot', { hotInProgressOnly: true });
    } finally {
      this.hotRunning = false;
    }
  }

  private async runForAllUsers(event: string, options: AudiobookshelfSyncOptions): Promise<void> {
    const startedAt = Date.now();
    let usersProcessed = 0;
    let usersFailed = 0;
    try {
      let users = await this.repo.findEnabledConfiguredUsers(0, AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE);
      if (users.length === 0) return;

      const quiet = options.hotInProgressOnly === true;
      if (!quiet) this.logger.log(`[${event}] [start] - run started`);

      while (true) {
        for (const group of chunk(users, AUDIOBOOKSHELF_SCHEDULER_CONCURRENCY)) {
          const outcomes = await Promise.all(group.map((user) => this.syncUser(event, user, options)));
          for (const outcome of outcomes) {
            if (outcome.result === 'processed') usersProcessed++;
            else if (outcome.result === 'failed') usersFailed++;
          }
        }

        if (users.length < AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE) break;
        const afterUserId = users[users.length - 1]!.userId;
        users = await this.repo.findEnabledConfiguredUsers(afterUserId, AUDIOBOOKSHELF_SCHEDULER_USER_PAGE_SIZE);
        if (users.length === 0) break;
      }

      if (!quiet) {
        this.logger.log(
          `[${event}] [end] durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} - run completed`,
        );
      }
    } catch (err) {
      const { errorClass, error } = describeError(err);
      this.logger.error(
        `[${event}] [fail] durationMs=${Date.now() - startedAt} usersProcessed=${usersProcessed} usersFailed=${usersFailed} errorClass=${errorClass} error="${error}" - run failed`,
      );
    }
  }

  private async syncUser(
    event: string,
    enabledUser: AbsEnabledUser,
    options: AudiobookshelfSyncOptions,
  ): Promise<{ result: 'processed' | 'failed' | 'skipped' }> {
    let user: RequestUser | null;
    try {
      user = await this.userService.findByIdWithPermissions(enabledUser.userId);
    } catch {
      user = null;
    }
    if (!user || !isEligibleSyncUser(user)) return { result: 'skipped' };

    // On the hot tier, allow session ingest at most once per 90s per user. The full poll (non-hot)
    // already ingests sessions every 15 min, so it is left untouched.
    let effectiveOptions = options;
    if (options.hotInProgressOnly === true) {
      const now = Date.now();
      const warm = now - (this.lastWarmSessionAt.get(enabledUser.userId) ?? 0) >= AUDIOBOOKSHELF_WARM_SESSION_INTERVAL_MS;
      if (warm) {
        if (this.lastWarmSessionAt.size >= 10_000 && !this.lastWarmSessionAt.has(enabledUser.userId)) {
          // Entries older than the warm interval already evaluate to warm=true, so pruning them is
          // behavior-free; the map stays bounded by users warm-ingested within the last interval.
          for (const [userId, at] of this.lastWarmSessionAt) {
            if (now - at >= AUDIOBOOKSHELF_WARM_SESSION_INTERVAL_MS) this.lastWarmSessionAt.delete(userId);
          }
        }
        this.lastWarmSessionAt.set(enabledUser.userId, now);
      }
      effectiveOptions = { ...options, warmSessions: warm };
    }

    try {
      await this.syncService.sync(user, effectiveOptions);
      return { result: 'processed' };
    } catch (err) {
      // Skip-and-continue on the per-user in-flight guard (a manual/full sync is already running) - not
      // a failure. Everything else is isolated per user (sync already records settings.lastSyncError)
      // so one user's failure never halts the loop.
      if (err instanceof ConflictException) return { result: 'skipped' };
      const { errorClass, error } = describeError(err);
      this.logger.warn(`[${event}] [fail] userId=${enabledUser.userId} errorClass=${errorClass} error="${error}" - user sync failed`);
      return { result: 'failed' };
    }
  }
}
