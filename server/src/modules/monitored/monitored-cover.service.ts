import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'fs/promises';
import { join } from 'path';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { storageConfig } from '../../config/config';
import { CoverService } from '../cover/cover.service';
import { generateThumbnail } from '../metadata/lib/cover';

const CACHE_DIR_NAME = 'monitored-covers';
const CACHE_SWEEP_THRESHOLD = 5000;
const CACHE_SWEEP_TARGET = 4500;
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MISSES = 30;
// Extend this allowlist when a new bibliography provider begins supplying cover URLs.
const COVER_HOST_ALLOWLIST = new Set([
  'assets.hardcover.app',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images.amazon.com',
  'm.media-amazon.com',
]);

export function selectCacheEvictions(entries: Array<{ path: string; mtimeMs: number }>): Array<{ path: string; mtimeMs: number }> {
  return [...entries]
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, Math.max(0, entries.length - CACHE_SWEEP_TARGET));
}

export interface MonitoredCoverImage {
  buffer: Buffer;
  contentType: string;
}

/**
 * Disk-cached, card-sized covers for monitored works.
 *
 * Monitored catalog covers are external provider URLs (e.g. Hardcover CDN).
 * Serving them through the generic cover proxy refetches the full-resolution
 * original from the remote origin on every request, which makes the monitored
 * grids pop in one card at a time. This service fetches once (reusing the
 * proxy's SSRF/timeout/size safeguards), resizes to the same dimensions as
 * library thumbnails, and persists the result on disk keyed by URL hash.
 */
@Injectable()
export class MonitoredCoverService {
  private readonly logger = new Logger(MonitoredCoverService.name);
  private readonly cacheDir: string;
  private readonly inflight = new Map<string, Promise<MonitoredCoverImage>>();
  private readonly missesByUser = new Map<number, { startedAt: number; count: number }>();
  private sweep: Promise<void> | null = null;
  private sweepRequested = false;

  constructor(
    private readonly coverService: CoverService,
    @Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>,
  ) {
    this.cacheDir = join(storage.appDataPath, CACHE_DIR_NAME);
  }

  async getCover(url: string, userId: number): Promise<MonitoredCoverImage> {
    this.assertAllowedUrl(url);
    const key = createHash('sha256').update(url).digest('hex');
    const cachePath = join(this.cacheDir, `${key}.jpg`);

    try {
      // Only resized JPEGs are ever persisted, so the cached content type is fixed.
      const buffer = await readFile(cachePath);
      const touchStartedAt = Date.now();
      const now = new Date();
      void utimes(cachePath, now, now).catch((error: unknown) => this.logTouchFailure(cachePath, touchStartedAt, error));
      return { buffer, contentType: 'image/jpeg' };
    } catch {
      // Cache miss, so fetch the image.
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    this.consumeMiss(userId);
    const task = this.fetchAndCache(url, cachePath).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async fetchAndCache(url: string, cachePath: string): Promise<MonitoredCoverImage> {
    const startedAt = Date.now();
    const { buffer, contentType } = await this.coverService.proxyImage(url);

    try {
      const thumbnail = await generateThumbnail(buffer);
      await this.persist(cachePath, thumbnail);
      this.logger.debug(
        `[monitored.cover_cache] [end] durationMs=${Date.now() - startedAt} outcome=fetched sourceBytes=${buffer.length} thumbnailBytes=${thumbnail.length} - fetched and cached monitored cover`,
      );
      return { buffer: thumbnail, contentType: 'image/jpeg' };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.cover_cache] [end] durationMs=${Date.now() - startedAt} outcome=fallback sourceBytes=${buffer.length} errorClass=${errorClass} error="${message}" - cover resize failed, serving original uncached`,
      );
      return { buffer, contentType };
    }
  }

  private async persist(cachePath: string, bytes: Buffer): Promise<void> {
    const startedAt = Date.now();
    // Write via a unique temp file + rename so concurrent workers never serve
    // a partially written cover; failures degrade to uncached serving.
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, cachePath);
      this.sweepRequested = true;
      if (!this.sweep) {
        const sweepStartedAt = Date.now();
        const sweep = this.runSweepQueue();
        this.sweep = sweep;
        void sweep.catch((error: unknown) => this.logSweepFailure(sweepStartedAt, error));
      }
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.cover_cache] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" path="${sanitizeLogValue(cachePath)}" - cover cache write failed`,
      );
    }
  }

  private async runSweepQueue(): Promise<void> {
    try {
      while (this.sweepRequested) {
        this.sweepRequested = false;
        await this.sweepCache();
      }
    } finally {
      this.sweep = null;
    }
  }

  private async sweepCache(): Promise<void> {
    const names = await readdir(this.cacheDir);
    const jpegNames = names.filter((name) => name.endsWith('.jpg'));
    const tempNames = names.filter((name) => name.endsWith('.tmp'));
    const tempEntries = await Promise.all(
      tempNames.map(async (name) => {
        const path = join(this.cacheDir, name);
        return { path, mtimeMs: (await stat(path)).mtimeMs };
      }),
    );
    const staleTemps = tempEntries.filter((entry) => Date.now() - entry.mtimeMs > TEMP_FILE_MAX_AGE_MS);
    if (jpegNames.length <= CACHE_SWEEP_THRESHOLD && !staleTemps.length) return;
    const entries =
      jpegNames.length > CACHE_SWEEP_THRESHOLD
        ? await Promise.all(
            jpegNames.map(async (name) => {
              const path = join(this.cacheDir, name);
              return { path, mtimeMs: (await stat(path)).mtimeMs };
            }),
          )
        : [];
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.cover_cache.sweep] [start] entries=${entries.length} staleTemps=${staleTemps.length} target=${CACHE_SWEEP_TARGET} - cover cache sweep started`,
    );
    const removals = entries.length > CACHE_SWEEP_THRESHOLD ? selectCacheEvictions(entries) : [];
    await Promise.all([...removals, ...staleTemps].map((entry) => unlink(entry.path)));
    this.logger.log(
      `[monitored.cover_cache.sweep] [end] durationMs=${Date.now() - startedAt} entries=${entries.length} deleted=${removals.length} staleTempsDeleted=${staleTemps.length} remaining=${entries.length - removals.length} - cover cache sweep completed`,
    );
  }

  private assertAllowedUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Invalid monitored cover URL');
    }
    if (url.protocol !== 'https:' || !COVER_HOST_ALLOWLIST.has(url.hostname.toLowerCase())) {
      throw new BadRequestException('Monitored cover host is not allowed');
    }
  }

  private consumeMiss(userId: number): void {
    const now = Date.now();
    const current = this.missesByUser.get(userId);
    if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
      this.missesByUser.set(userId, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= RATE_LIMIT_MISSES) {
      throw new HttpException('Too many monitored cover fetches; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
    }
    current.count += 1;
  }

  private logSweepFailure(startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.cover_cache.sweep] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - cover cache sweep failed`,
    );
  }

  private logTouchFailure(cachePath: string, startedAt: number, error: unknown): void {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.cover_cache.touch] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" path="${sanitizeLogValue(cachePath)}" - cover cache touch failed`,
    );
  }
}
