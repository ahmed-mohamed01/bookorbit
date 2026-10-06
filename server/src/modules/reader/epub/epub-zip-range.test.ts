import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import * as unzipper from 'unzipper';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storedZipEntryDataOffset } from './epub-zip-range';

const AUDIO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

describe('storedZipEntryDataOffset', () => {
  let fixtureRoot: string;
  let archivePath: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'bookorbit-zip-range-'));
    archivePath = join(fixtureRoot, 'book.epub');
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    const complete = new Promise<void>((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });
    archive.append('application/epub+zip', { name: 'mimetype', store: true });
    archive.append('<html>chapter text that compresses</html>'.repeat(20), { name: 'OEBPS/chapter.xhtml' });
    archive.append(AUDIO, { name: 'OEBPS/Audio/00001-00001.mp4', store: true });
    await archive.finalize();
    await complete;
    await writeFile(archivePath, Buffer.concat(chunks));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function entry(path: string): Promise<unzipper.File> {
    const zip = await unzipper.Open.file(archivePath);
    const found = zip.files.find((file) => file.path === path);
    if (!found) throw new Error(`missing ${path}`);
    return found;
  }

  it('points at the bytes of a stored entry inside the archive', async () => {
    const offset = await storedZipEntryDataOffset(archivePath, await entry('OEBPS/Audio/00001-00001.mp4'));
    const archive = await readFile(archivePath);

    expect(offset).not.toBeNull();
    expect(archive.subarray(offset!, offset! + AUDIO.length)).toEqual(AUDIO);
  });

  it('declines compressed entries', async () => {
    await expect(storedZipEntryDataOffset(archivePath, await entry('OEBPS/chapter.xhtml'))).resolves.toBeNull();
  });
});
