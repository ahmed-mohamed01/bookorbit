import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { OverlaySourceCandidate, OverlaySourceResolver } from '../book/overlay-source-provider';
import type { EpubDomSourceResolver } from '../position-converter/epub-dom-source-provider';
import { EDITION_SYNC_INDEX_FORMAT, EDITION_SYNC_RESOLVER_CACHE_MS } from './edition-sync.constants';
import { resolveEditionSyncDecision, resolveEditionSyncSettings } from './edition-sync-policy';
import { checkEditionSyncSources } from './edition-sync-source-check';
import { EditionSyncRepository } from './edition-sync.repository';

type CachedSource =
  { expiresAt: number; indexFileId: number | null; indexPath: string | null } | { expiresAt: number; indexFileId: null; indexPath: null; off: true };

const MAX_CACHE_ENTRIES = 5_000;

/**
 * Offers a book's ready timing index as its media-overlay source for users who have sync on.
 * Upstream asks only when the book has no read-along EPUB, after its own read-aloud sync mode check.
 */
@Injectable()
export class EditionSyncOverlaySourceService implements OverlaySourceResolver, EpubDomSourceResolver {
  private readonly logger = new Logger(EditionSyncOverlaySourceService.name);
  private cacheVersion = 0;
  private readonly cache = new Map<string, CachedSource>();

  constructor(private readonly repo: EditionSyncRepository) {}

  async resolveOverlaySource<T extends OverlaySourceCandidate>(userId: number, bookId: number, files: readonly T[]): Promise<T | null> {
    const startedAt = Date.now();
    const indexFiles = files.filter((file) => file.format === EDITION_SYNC_INDEX_FORMAT);
    if (indexFiles.length === 0) return null;
    try {
      const source = await this.lookup(userId, bookId);
      if ('off' in source) return null;
      const file =
        indexFiles.find((candidate) => candidate.id === source.indexFileId) ??
        indexFiles.find((candidate) => candidate.absolutePath === source.indexPath);
      return file ? { ...file, mediaOverlayAvailable: true } : null;
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      this.logger.warn(
        `[edition_sync.overlay_source] [fail] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - overlay source lookup failed`,
      );
      return null;
    }
  }

  async resolveEpubDomSource(
    _bookFileId: number,
    file: { absolutePath: string; format: string | null },
  ): Promise<{ absolutePath: string; format: 'epub' } | null> {
    return Promise.resolve(file.format === EDITION_SYNC_INDEX_FORMAT ? { absolutePath: file.absolutePath, format: 'epub' } : null);
  }

  /** Drops cached decisions after a settings or toggle change; no book id drops all of the user's. */
  invalidate(userId?: number, bookId?: number): void {
    if (userId === undefined) {
      this.cacheVersion++;
      this.cache.clear();
      return;
    }
    if (bookId !== undefined) {
      this.cache.delete(`${userId}:${bookId}`);
      return;
    }
    const prefix = `${userId}:`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  /** Drops every user's cached decision for a book whose index changed. */
  invalidateBook(bookId: number): void {
    const suffix = `:${bookId}`;
    for (const key of this.cache.keys()) if (key.endsWith(suffix)) this.cache.delete(key);
  }

  private async lookup(userId: number, bookId: number): Promise<CachedSource> {
    const version = this.cacheVersion;
    const key = `${userId}:${bookId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached;

    const [inputs, hasPermission, serverEnabled] = await Promise.all([
      this.repo.findResolverInputs(userId, bookId),
      this.repo.userHasEditionSyncPermission(userId),
      this.repo.isServerEnabled(),
    ]);
    const settings = resolveEditionSyncSettings({
      serverEnabled,
      hasPermission,
      enabled: inputs.settings?.enabled ?? true,
      bookSyncMode: inputs.settings?.bookSyncMode ?? 'all_eligible',
    });
    // Eligibility is implied: upstream only asks when there is no read-along, and the index exists.
    const decision = resolveEditionSyncDecision({ settings, eligible: true, override: inputs.override });
    const expiresAt = now + EDITION_SYNC_RESOLVER_CACHE_MS;
    let valid = false;
    if (decision.syncEnabled && inputs.index?.status === 'ready') {
      const verification = await checkEditionSyncSources(this.repo, bookId, inputs.index);
      valid = verification.valid;
      if (!verification.valid) {
        if (verification.canCheckContent) await this.repo.flagRecheck(bookId);
        else await this.repo.markStale(bookId, verification.reason);
        this.invalidateBook(bookId);
      } else if (inputs.index.invalidatedAt) await this.repo.clearRecheck(bookId);
    }
    const entry: CachedSource =
      valid && inputs.index
        ? { expiresAt, indexFileId: inputs.index.indexFileId, indexPath: inputs.index.indexPath }
        : { expiresAt, indexFileId: null, indexPath: null, off: true };
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.evictExpired(now);
    if (version !== this.cacheVersion) return this.lookup(userId, bookId);
    this.cache.set(key, entry);
    return entry;
  }

  private evictExpired(now: number): void {
    for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key);
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
  }
}
