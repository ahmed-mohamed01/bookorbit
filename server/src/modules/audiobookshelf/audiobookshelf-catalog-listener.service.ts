import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AchievementEventsService, ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED } from '../achievement/achievement-events.service';
import { UserService } from '../user/user.service';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfSyncService } from './audiobookshelf-sync.service';
import { isAbsSyncConfigured, isEligibleSyncUser } from './audiobookshelf-user.utils';
import { AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS } from './audiobookshelf.constants';

// A busy lock (another sync, or a push that outlasted the sync's wait) is retried rather than
// dropped, since the sync holding it may not reconcile. Bounded so a stuck lock cannot loop forever.
export const AUDIOBOOKSHELF_CATALOG_MATCH_MAX_RETRIES = 5;

/**
 * Auto-matches new books to Audiobookshelf. BookOrbit's scanner already emits
 * `library.catalog-changed` when a scan adds or removes books; this listener reconciles the ABS
 * inventory for that user (linking the new book) and, in the same run, polls its progress so its
 * reading state appears without waiting for the next scheduled poll.
 *
 * Subscribes to an existing BookOrbit event rather than hooking the scanner, so removing this plugin
 * leaves the scan flow untouched.
 */
@Injectable()
export class AudiobookshelfCatalogListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudiobookshelfCatalogListenerService.name);
  // Per-user debounce: a full scan emits many catalog-changed events; collapse them into one match.
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<number, number>();

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly repo: AudiobookshelfRepository,
    private readonly syncService: AudiobookshelfSyncService,
    private readonly userService: UserService,
  ) {}

  private readonly handleCatalogChanged = (payload: { userId: number; libraryId: number }): void => {
    this.scheduleMatch(payload.userId);
  };

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, this.handleCatalogChanged);
  }

  onModuleDestroy(): void {
    this.achievementEvents.removeListener(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, this.handleCatalogChanged);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.retries.clear();
  }

  private scheduleMatch(userId: number): void {
    const existing = this.timers.get(userId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      userId,
      setTimeout(() => {
        void this.runMatch(userId);
      }, AUDIOBOOKSHELF_CATALOG_MATCH_DEBOUNCE_MS),
    );
  }

  private async runMatch(userId: number): Promise<void> {
    this.timers.delete(userId);

    const settings = await this.repo.findSettings(userId).catch(() => null);
    if (!isAbsSyncConfigured(settings)) return;

    let user;
    try {
      user = await this.userService.findByIdWithPermissions(userId);
    } catch {
      return;
    }
    if (!user || !isEligibleSyncUser(user)) return;

    try {
      await this.syncService.sync(user, { reconcile: true });
      this.retries.delete(userId);
    } catch (err) {
      if (err instanceof ConflictException) {
        const attempt = (this.retries.get(userId) ?? 0) + 1;
        if (attempt <= AUDIOBOOKSHELF_CATALOG_MATCH_MAX_RETRIES) {
          this.retries.set(userId, attempt);
          this.scheduleMatch(userId);
          return;
        }
        this.retries.delete(userId);
        this.logger.warn(`[abs.catalog_match] [fail] userId=${userId} attempts=${attempt} - catalog-triggered match gave up: sync lock stayed busy`);
        return;
      }
      this.retries.delete(userId);
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[abs.catalog_match] [fail] userId=${userId} error="${error}" - catalog-triggered match failed`);
    }
  }
}
