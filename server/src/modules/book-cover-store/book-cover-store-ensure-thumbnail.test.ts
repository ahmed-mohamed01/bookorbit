import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bookCoverSlotDirPath } from '../../common/book-cover-storage';
import { generateThumbnail } from '../metadata/lib/cover';
import { BookCoverStore } from './book-cover-store.service';

vi.mock('../metadata/lib/cover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../metadata/lib/cover')>();
  return { ...actual, generateThumbnail: vi.fn(actual.generateThumbnail) };
});

describe('BookCoverStore.ensureSlotThumbnail', () => {
  let root: string;
  let dir: string;
  let store: BookCoverStore;

  beforeEach(async () => {
    vi.mocked(generateThumbnail).mockClear();
    root = await mkdtemp(join(tmpdir(), 'cover-store-ensure-'));
    dir = bookCoverSlotDirPath(root, 7, 'ebook');
    await mkdir(dir, { recursive: true });
    store = new BookCoverStore({ getOrThrow: () => root } as never, {} as never, {} as never);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('makes a missing thumbnail once when a backfill and a request ask for it together', async () => {
    const cover = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#335577' } })
      .jpeg()
      .toBuffer();
    await writeFile(join(dir, 'cover_extracted.jpg'), cover);

    const [backfill, again] = await Promise.all([store.ensureSlotThumbnail(7, 'ebook'), store.ensureSlotThumbnail(7, 'ebook')]);

    expect(backfill).toBe(join(dir, 'thumbnail.jpg'));
    expect(again).toBe(backfill);
    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    expect((await readdir(dir)).sort()).toEqual(['cover_extracted.jpg', 'thumbnail.jpg']);
  });

  it('returns the existing thumbnail without re-encoding it', async () => {
    await writeFile(join(dir, 'thumbnail.jpg'), 'existing');

    await expect(store.ensureSlotThumbnail(7, 'ebook')).resolves.toBe(join(dir, 'thumbnail.jpg'));
    expect(generateThumbnail).not.toHaveBeenCalled();
  });

  it('resolves null when the slot has no cover file', async () => {
    await expect(store.ensureSlotThumbnail(7, 'ebook')).resolves.toBeNull();
  });
});
