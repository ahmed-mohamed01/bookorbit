import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findSourceEpubProblem } from './storyteller-epub.utils';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'storyteller-epub-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeEpub(name: string, entries: Record<string, string>): Promise<string> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const [path, body] of Object.entries(entries)) archive.append(body, { name: path });
  await archive.finalize();
  await done;
  const target = join(dir, name);
  await writeFile(target, Buffer.concat(chunks));
  return target;
}

describe('findSourceEpubProblem', () => {
  it('accepts an EPUB that declares where its OPF lives', async () => {
    const path = await writeEpub('good.epub', {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': '<package version="3.0" />',
    });

    await expect(findSourceEpubProblem(path)).resolves.toBeNull();
  });

  // The reader tolerates case differences in zip paths, so this must not refuse a file the rest of
  // the app opens happily.
  it('accepts a container entry whose case differs', async () => {
    const path = await writeEpub('cased.epub', {
      mimetype: 'application/epub+zip',
      'meta-inf/Container.xml': '<container />',
    });

    await expect(findSourceEpubProblem(path)).resolves.toBeNull();
  });

  // The real shape that reached Storyteller as a 500: a zip of a book's files with no META-INF at
  // all, so no reader can locate the OPF and every import mode fails identically.
  it('refuses an archive with no container entry', async () => {
    const path = await writeEpub('no-container.epub', {
      'Warbreaker/content.opf': '<package version="2.0" />',
      'Warbreaker/ch01.xhtml': '<html />',
    });

    await expect(findSourceEpubProblem(path)).resolves.toBe('missing_container');
  });

  it('refuses a file that is not an archive at all', async () => {
    const path = join(dir, 'broken.epub');
    await writeFile(path, 'this is not a zip');

    await expect(findSourceEpubProblem(path)).resolves.toBe('unreadable_archive');
  });

  it('refuses a file that does not exist', async () => {
    await expect(findSourceEpubProblem(join(dir, 'missing.epub'))).resolves.toBe('unreadable_archive');
  });
});
