import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { bookCoverSlotThumbnailPath } from '../../common/book-cover-storage';
import type { RequestUser } from '../../common/types/request-user';
import type { AppSettingsService } from '../app-settings/app-settings.service';
import type { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import type { CoverThumbnailBackfillRepository, ThumbnailBackfillCursor } from './cover-thumbnail-backfill.repository';
import {
  CoverThumbnailBackfillService,
  THUMBNAIL_BACKFILL_ENABLED_KEY,
  THUMBNAIL_BACKFILL_LAST_RUN_KEY,
  THUMBNAIL_BACKFILL_PAGE_SIZE,
  THUMBNAIL_BACKFILL_STARTUP_DELAY_MS,
} from './cover-thumbnail-backfill.service';

const admin = { id: 1 } as RequestUser;

describe('CoverThumbnailBackfillService', () => {
  let appDataPath: string;
  let slots: ThumbnailBackfillCursor[];
  let settings: Map<string, string>;
  let servedSlotsAfter: Mock<CoverThumbnailBackfillRepository['servedSlotsAfter']>;
  let ensureSlotThumbnail: Mock<BookCoverStore['ensureSlotThumbnail']>;
  let service: CoverThumbnailBackfillService;

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'thumbnail-backfill-'));
    slots = [];
    settings = new Map();
    servedSlotsAfter = vi.fn<CoverThumbnailBackfillRepository['servedSlotsAfter']>((cursor, limit) => {
      const start = cursor ? slots.findIndex((slot) => slot.bookId === cursor.bookId && slot.medium === cursor.medium) + 1 : 0;
      return Promise.resolve(slots.slice(start, start + limit));
    });
    ensureSlotThumbnail = vi.fn<BookCoverStore['ensureSlotThumbnail']>((bookId, medium) =>
      Promise.resolve(bookCoverSlotThumbnailPath(appDataPath, bookId, medium)),
    );
    const appSettings = {
      getValue: vi.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
      getValues: vi.fn((keys: string[]) => Promise.resolve(new Map(keys.filter((key) => settings.has(key)).map((key) => [key, settings.get(key)!])))),
      setValue: vi.fn((key: string, value: string) => {
        settings.set(key, value);
        return Promise.resolve();
      }),
    };
    service = new CoverThumbnailBackfillService(
      { getOrThrow: () => appDataPath } as unknown as ConfigService,
      { servedSlotsAfter, countServedSlots: () => Promise.resolve(slots.length) } as unknown as CoverThumbnailBackfillRepository,
      { ensureSlotThumbnail } as unknown as BookCoverStore,
      appSettings as unknown as AppSettingsService,
    );
  });

  afterEach(async () => {
    service.onModuleDestroy();
    vi.useRealTimers();
    await rm(appDataPath, { recursive: true, force: true });
  });

  async function writeThumbnail(slot: ThumbnailBackfillCursor): Promise<void> {
    const path = bookCoverSlotThumbnailPath(appDataPath, slot.bookId, slot.medium);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'thumb');
  }

  function blockFirstRepair(): () => void {
    let release!: () => void;
    ensureSlotThumbnail.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve('made'))));
    return () => release();
  }

  it('makes only the thumbnails that are missing, through the store repair path', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 1, medium: 'audio' },
      { bookId: 2, medium: 'ebook' },
    ];
    await writeThumbnail(slots[0]);

    const result = await service.run('manual');

    expect(ensureSlotThumbnail.mock.calls).toEqual([
      [1, 'audio'],
      [2, 'ebook'],
    ]);
    expect(result).toMatchObject({ outcome: 'completed', scanned: 3, missing: 2, made: 2, unresolved: 0 });
  });

  it('counts a slot the store could not repair as unresolved and keeps going', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 2, medium: 'ebook' },
    ];
    ensureSlotThumbnail.mockResolvedValueOnce(null);

    expect(await service.run('manual')).toMatchObject({ scanned: 2, missing: 2, made: 1, unresolved: 1 });
  });

  it('walks every page with a keyset cursor', async () => {
    slots = Array.from({ length: THUMBNAIL_BACKFILL_PAGE_SIZE + 3 }, (_, index) => ({ bookId: index + 1, medium: 'ebook' as const }));

    const result = await service.run('manual');

    expect(result?.scanned).toBe(THUMBNAIL_BACKFILL_PAGE_SIZE + 3);
    expect(servedSlotsAfter).toHaveBeenCalledTimes(2);
    expect(servedSlotsAfter.mock.calls[1][0]).toEqual({ bookId: THUMBNAIL_BACKFILL_PAGE_SIZE, medium: 'ebook' });
  });

  it('repairs one slot at a time', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 2, medium: 'ebook' },
      { bookId: 3, medium: 'ebook' },
    ];
    let active = 0;
    let peak = 0;
    ensureSlotThumbnail.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return 'made';
    });

    await service.run('manual');

    expect(peak).toBe(1);
  });

  it('stores the last run so the settings page can show it after a restart', async () => {
    slots = [{ bookId: 1, medium: 'ebook' }];

    await service.run('manual');

    const state = await service.getState();
    expect(state.running).toBeNull();
    expect(state.lastRun).toMatchObject({ trigger: 'manual', outcome: 'completed', scanned: 1, missing: 1, made: 1 });
    expect(JSON.parse(settings.get(THUMBNAIL_BACKFILL_LAST_RUN_KEY)!)).toEqual(state.lastRun);
  });

  it('records a failed run and returns null instead of throwing', async () => {
    servedSlotsAfter.mockRejectedValueOnce(new Error('db down'));

    expect(await service.run('manual')).toBeNull();
    expect((await service.getState()).lastRun).toMatchObject({ outcome: 'failed' });
  });

  it('is on by default and skips start-up and scheduled runs once switched off', async () => {
    slots = [{ bookId: 1, medium: 'ebook' }];
    expect((await service.getState()).enabled).toBe(true);

    await service.setEnabled(admin, false);
    await service.runScheduled();

    expect(settings.get(THUMBNAIL_BACKFILL_ENABLED_KEY)).toBe('false');
    expect((await service.getState()).enabled).toBe(false);
    expect(servedSlotsAfter).not.toHaveBeenCalled();
  });

  it('runs on request even when the switch is off, and reports progress while it runs', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 2, medium: 'ebook' },
    ];
    await service.setEnabled(admin, false);
    const release = blockFirstRepair();

    expect((await service.startManual(admin)).running?.trigger).toBe('manual');
    await vi.waitFor(() => expect(ensureSlotThumbnail).toHaveBeenCalledTimes(1));

    expect((await service.getState()).running).toMatchObject({ trigger: 'manual', scanned: 1, missing: 1, made: 0 });
    release();
    await vi.waitFor(async () => expect((await service.getState()).lastRun).toMatchObject({ outcome: 'completed', made: 2 }));
  });

  it('joins a run that is already going instead of starting another', async () => {
    slots = [{ bookId: 1, medium: 'ebook' }];
    const release = blockFirstRepair();

    const first = service.run('schedule');
    await vi.waitFor(() => expect(ensureSlotThumbnail).toHaveBeenCalledTimes(1));
    expect((await service.startManual(admin)).running?.trigger).toBe('schedule');
    expect(await service.run('manual')).toBeNull();
    release();

    expect(await first).toMatchObject({ made: 1 });
    expect(servedSlotsAfter).toHaveBeenCalledTimes(1);
  });

  it('stops a run that is going when the switch is turned off', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 2, medium: 'ebook' },
    ];
    const release = blockFirstRepair();

    const run = service.run('manual');
    await vi.waitFor(() => expect(ensureSlotThumbnail).toHaveBeenCalledTimes(1));
    await service.setEnabled(admin, false);
    release();

    expect(await run).toMatchObject({ outcome: 'stopped', scanned: 1, made: 1 });
    expect(ensureSlotThumbnail).toHaveBeenCalledTimes(1);
  });

  it('stops a run on request without turning the switch off', async () => {
    slots = [
      { bookId: 1, medium: 'ebook' },
      { bookId: 2, medium: 'ebook' },
    ];
    const release = blockFirstRepair();

    const run = service.run('manual');
    await vi.waitFor(() => expect(ensureSlotThumbnail).toHaveBeenCalledTimes(1));
    expect((await service.getState()).running).toMatchObject({ total: 2, scanned: 1 });
    expect(service.stopRun(admin)).toBe(true);
    expect(service.stopRun(admin)).toBe(false);
    release();

    expect(await run).toMatchObject({ outcome: 'stopped', scanned: 1 });
    expect((await service.getState()).enabled).toBe(true);
    expect(service.stopRun(admin)).toBe(false);
  });

  it('tells the Jobs area when a run starts, moves on a page, and ends', async () => {
    const notify = vi.fn();
    const watched = new CoverThumbnailBackfillService(
      { getOrThrow: () => appDataPath } as unknown as ConfigService,
      { servedSlotsAfter, countServedSlots: () => Promise.resolve(1) } as unknown as CoverThumbnailBackfillRepository,
      { ensureSlotThumbnail } as unknown as BookCoverStore,
      { setValue: () => Promise.resolve() } as unknown as AppSettingsService,
      { notify } as never,
    );
    slots = [{ bookId: 1, medium: 'ebook' }];

    await watched.run('manual');

    expect(notify.mock.calls.map(([change]) => change)).toEqual([
      { type: 'cover-thumbnail-backfill', ownerId: null, state: true },
      { type: 'cover-thumbnail-backfill', ownerId: null, state: false },
      { type: 'cover-thumbnail-backfill', ownerId: null, state: true },
    ]);
  });

  it('starts a short while after boot, and not at all once the module is destroyed', () => {
    vi.useFakeTimers();
    const run = vi.spyOn(service, 'run').mockResolvedValue(null);

    service.onApplicationBootstrap();
    vi.advanceTimersByTime(THUMBNAIL_BACKFILL_STARTUP_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    service.onApplicationBootstrap();
    service.onModuleDestroy();
    vi.advanceTimersByTime(THUMBNAIL_BACKFILL_STARTUP_DELAY_MS);
    return vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });
});
