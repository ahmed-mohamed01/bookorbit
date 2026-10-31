import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as unzipper from 'unzipper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readStream } from '../../../common/test-utils/read-stream';
import { writeZipFixture } from '../../../common/test-utils/zip-fixture';
import { EpubMediaStreamService } from './epub-media-stream.service';
import * as zipRange from './epub-zip-range';

const MP4 = Buffer.from(Array.from({ length: 240 }, (_, i) => i % 251));
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

  it('serves stored MP4 bytes unchanged with a validator', async () => {
    const stored = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp4', entry('Audio/chapter.mp4'));
    const body = await readStream(service.openRange(stored!, { start: 0, end: MP4.length - 1 }));

    expect(stored!.etag).toMatch(/^"1000-/);
    expect(body).toEqual(MP4);
  });

  it('serves other stored audio as it is', async () => {
    const stored = await service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Audio/chapter.mp3', entry('Audio/chapter.mp3'));

    expect(stored!.etag).toMatch(/^"1000-/);
    await expect(readStream(service.openRange(stored!, { start: 10, end: 99 }))).resolves.toEqual(MP3.subarray(10, 100));
  });

  it('reports compressed entries as not streamable', async () => {
    await expect(
      service.storedEntry(1, { path: archivePath, mtime: 1000, size: 5000 }, 'Text/chapter.xhtml', entry('Text/chapter.xhtml')),
    ).resolves.toBeNull();
  });

  it('reuses the entry offset for the same archive version and rebuilds it for a new one', async () => {
    const build = vi.spyOn(zipRange, 'storedZipEntryDataOffset');

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
});
