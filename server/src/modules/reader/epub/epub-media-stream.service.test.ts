import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as unzipper from 'unzipper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readStream } from '../../../common/test-utils/read-stream';
import { mp4Box, mp4ChunkOffsets, mp4Index, writeZipFixture } from '../../../common/test-utils/zip-fixture';
import { EpubMediaStreamService } from './epub-media-stream.service';
import * as faststart from './mp4-faststart';

const FTYP = mp4Box('ftyp', Buffer.from('isom\0\0\0\0'));
const MDAT = mp4Box('mdat', Buffer.alloc(200, 7));
const MP4 = Buffer.concat([FTYP, MDAT, mp4Index(mp4ChunkOffsets([FTYP.length + 8]))]);
const MP3 = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 251));

describe('EpubMediaStreamService', () => {
  let root: string;
  let archivePath: string;
  let files: unzipper.File[];
  let service: EpubMediaStreamService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookorbit-media-stream-'));
    archivePath = join(root, 'book.epub');
    await writeZipFixture(archivePath, [
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'Audio/chapter.mp4', data: MP4, store: true },
      { name: 'Audio/chapter.mp3', data: MP3, store: true },
      { name: 'Text/chapter.xhtml', data: '<p>text</p>'.repeat(50) },
    ]);
    files = (await unzipper.Open.file(archivePath)).files;
    service = new EpubMediaStreamService();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const entry = (path: string) => files.find((file) => file.path === path)!;

  it('serves MP4 audio index-first under its own validator', async () => {
    const stored = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    const body = await readStream(service.openRange(stored!, { start: 0, end: MP4.length - 1 }));

    expect(stored!.etag).toMatch(/^"faststart-/);
    expect(body.toString('latin1', FTYP.length + 4, FTYP.length + 8)).toBe('moov');
  });

  it('serves other stored audio as it is', async () => {
    const stored = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp3', entry('Audio/chapter.mp3'));

    expect(stored!.etag).not.toMatch(/faststart/);
    await expect(readStream(service.openRange(stored!, { start: 10, end: 99 }))).resolves.toEqual(MP3.subarray(10, 100));
  });

  it('reports compressed entries as not streamable', async () => {
    await expect(
      service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Text/chapter.xhtml', entry('Text/chapter.xhtml')),
    ).resolves.toBeNull();
  });

  it('reuses the layout for the same archive version and rebuilds it for a new one', async () => {
    const build = vi.spyOn(faststart, 'buildFaststartLayout');

    await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    expect(build).toHaveBeenCalledOnce();

    const replaced = await service.storedEntry(1, { path: archivePath, mtime: 2000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    expect(build).toHaveBeenCalledTimes(2);
    expect(replaced!.etag).toContain('2000');
  });

  it('knows an entry once loaded, only for the same archive version', async () => {
    const archive = { path: archivePath, mtime: 1000, size: 5000 };
    expect(service.knownEntry(archive, 'Audio/chapter.mp4')).toBeNull();

    const stored = await service.storedEntry(1, archive, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));

    expect(service.knownEntry(archive, 'Audio/chapter.mp4')).toBe(stored);
    expect(service.knownEntry({ ...archive, size: 5001 }, 'Audio/chapter.mp4')).toBeNull();
    expect(service.knownEntry({ ...archive, mtime: 1001 }, 'Audio/chapter.mp4')).toBeNull();
  });

  it('does not remember a failed layout build', async () => {
    const build = vi.spyOn(faststart, 'buildFaststartLayout').mockRejectedValueOnce(new Error('disk hiccup'));

    const fallback = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    expect(fallback!.etag).not.toMatch(/faststart/);

    const retried = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    expect(build).toHaveBeenCalledTimes(2);
    expect(retried!.etag).toMatch(/^"faststart-/);
  });
});
