import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractCbzZipEntry, readCbzZipIndex } from '../../common/cbz-zip-reader';
import { writeZipFixture } from '../../common/test-utils/zip-fixture';
import { mergeCbzChapters } from './web-serials-cbz-merge.utils';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-serial-merge-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mergeCbzChapters', () => {
  it('streams naturally sorted pages under stable names and replaces ComicInfo.xml', async () => {
    const first = join(dir, 'one.cbz');
    const second = join(dir, 'two.cbz');
    const output = join(dir, 'merged.cbz');
    await writeZipFixture(first, [
      { name: '10.jpg', data: 'ten' },
      { name: '2.jpg', data: 'two' },
      { name: 'ComicInfo.xml', data: '<old />' },
      { name: 'note.txt', data: 'ignore' },
    ]);
    await writeZipFixture(second, [
      { name: 'page.webp', data: 'webp' },
      { name: 'cover.png', data: 'png' },
    ]);

    const result = await mergeCbzChapters(
      [first, second],
      output,
      {
        series: 'Saga',
        title: 'Saga, Volume 3',
        volume: '3',
        number: '3',
        writers: ['Writer'],
        pencillers: ['Artist'],
        summary: 'A & B\u0008\u0000 end',
        genres: ['Fantasy'],
        language: 'en',
      },
      1024 * 1024,
    );

    const index = await readCbzZipIndex(output);
    expect(index?.entries.map((entry) => entry.name)).toEqual(['0001-0001.jpg', '0001-0002.jpg', '0002-0001.png', '0002-0002.webp', 'ComicInfo.xml']);
    const firstPage = await extractCbzZipEntry(output, index!.entries[0]!);
    expect(firstPage?.toString()).toBe('two');
    const xml = await extractCbzZipEntry(output, index!.entries.at(-1)!);
    expect(xml?.toString()).toContain('<Title>Saga, Volume 3</Title>');
    expect(xml?.toString()).toContain('<Summary>A &amp; B end</Summary>');
    expect(xml?.toString()).toContain('<Penciller>Artist</Penciller>');
    expect(xml?.toString()).toContain('<Volume>3</Volume>');
    expect(xml?.toString()).not.toContain('<Web>');
    expect(result).toMatchObject({ path: output, pages: 4 });
    expect(await readFile(`${output}.part`).catch(() => null)).toBeNull();
  });

  it('removes partial output when a chapter is invalid or the cap is exceeded', async () => {
    const invalid = join(dir, 'invalid.cbz');
    const output = join(dir, 'merged.cbz');
    await import('fs/promises').then(({ writeFile }) => writeFile(invalid, 'not a zip'));
    const metadata = {
      series: 'Saga',
      title: 'Saga',
      number: '1',
      writers: [],
      pencillers: [],
      summary: null,
      genres: [],
      language: null,
    };

    await expect(mergeCbzChapters([invalid], output, metadata, 1024)).rejects.toThrow('valid CBZ');
    expect(await readFile(`${output}.part`).catch(() => null)).toBeNull();

    const valid = join(dir, 'valid.cbz');
    await writeZipFixture(valid, [{ name: '1.jpg', data: Buffer.alloc(2048, 1), store: true }]);
    await expect(mergeCbzChapters([valid], output, metadata, 100)).rejects.toThrow('larger than the allowed size');
    expect(await readFile(`${output}.part`).catch(() => null)).toBeNull();
  });
});
