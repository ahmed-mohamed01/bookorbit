import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XMLValidator } from 'fast-xml-parser';
import * as unzipper from 'unzipper';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSerialsEpubBuilder } from './web-serials-epub.builder';

const safeFetch = vi.hoisted(() => vi.fn());

vi.mock('../../common/utils/safe-fetch', () => ({ safeFetch }));

describe('WebSerialsEpubBuilder', () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it('writes a valid EPUB 3 package and sanitizes chapter XHTML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-serial-epub-'));
    const chapter = join(dir, 'chapter.html');
    const output = join(dir, 'book.epub');
    await writeFile(
      chapter,
      '<p onclick="bad()">Hello <strong>world</strong><script>alert(1)</script><a href="javascript:bad()">link</a><img src="https://images.test/good.png"><img src="https://images.test/bad.jpg"></p>',
    );
    safeFetch
      .mockResolvedValueOnce(new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('not an image', { status: 500 }));

    await new WebSerialsEpubBuilder().build({
      outputPath: output,
      workDir: dir,
      sourceId: 'source-a',
      seriesPath: '/novel/a',
      seriesTitle: 'Series & One',
      authors: ['A. Author'],
      volumeLabel: 'Volume 2',
      volumeIndex: '2',
      chapters: [{ title: 'Chapter 1', htmlPath: chapter, sourceUrl: 'https://site.test/chapter/1' }],
    });

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    const zip = await unzipper.Open.buffer(bytes);
    expect(zip.files[0]?.path).toBe('mimetype');
    expect(zip.files[0]?.type).toBe('File');
    const flags = bytes.readUInt16LE(6);
    expect(flags).toBe(0);
    const compressionMethod = bytes.readUInt16LE(8);
    expect(compressionMethod).toBe(0);

    const entries = new Map(await Promise.all(zip.files.map(async (file) => [file.path, (await file.buffer()).toString('utf8')] as const)));
    expect(entries.get('META-INF/container.xml')).toContain('OEBPS/content.opf');
    const opf = entries.get('OEBPS/content.opf')!;
    expect(opf).toContain('<dc:title>Volume 2</dc:title>');
    expect(opf).toContain('<dc:creator>A. Author</dc:creator>');
    expect(opf).toContain('calibre:series');
    expect(opf).toContain('belongs-to-collection');
    expect(entries.get('OEBPS/nav.xhtml')).toContain('Chapter 1');
    const xhtml = entries.get('OEBPS/chapters/chapter-0001.xhtml')!;
    expect(xhtml).not.toContain('script');
    expect(xhtml).not.toContain('onclick');
    expect(xhtml).not.toContain('javascript:');
    expect(xhtml).toContain('<img src="../images/image-00001.png"/>');
    expect(xhtml).not.toContain('bad.jpg');
    expect(entries.get('OEBPS/images/image-00001.png')).toBe('\u0001\u0002\u0003');
    expect(XMLValidator.validate(xhtml)).toBe(true);
  });

  it('drops the title the site repeats at the top of a chapter, as a bare line or an element', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-serial-epub-'));
    const bare = join(dir, 'bare.html');
    const element = join(dir, 'element.html');
    const output = join(dir, 'book.epub');
    await writeFile(bare, '<p> </p>Chapter 1: Short Break <p></p><p>(A/N: after Chapter 2176.)</p><p>Chapter 1: Short Break is mentioned later.</p>');
    await writeFile(element, '<h3>Chapter 2:  The Return</h3><p>Body text.</p>');

    await new WebSerialsEpubBuilder().build({
      outputPath: output,
      workDir: dir,
      sourceId: 'source-a',
      seriesPath: '/novel/a',
      seriesTitle: 'Series',
      authors: [],
      volumeLabel: 'Volume 1',
      volumeIndex: '1',
      chapters: [
        { title: 'Chapter 1: Short Break', htmlPath: bare, sourceUrl: null },
        { title: 'Chapter 2: The Return', htmlPath: element, sourceUrl: null },
      ],
    });

    const zip = await unzipper.Open.buffer(await readFile(output));
    const read = async (path: string) => (await zip.files.find((file) => file.path === path)!.buffer()).toString('utf8');
    const first = await read('OEBPS/chapters/chapter-0001.xhtml');
    expect(first.match(/Chapter 1: Short Break/g)).toHaveLength(3);
    expect(first).toContain('<h1>Chapter 1: Short Break</h1><p> </p><p></p><p>(A/N: after Chapter 2176.)</p>');
    const second = await read('OEBPS/chapters/chapter-0002.xhtml');
    expect(second).not.toContain('<h3>');
    expect(second).toContain('<p>Body text.</p>');
  });

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  async function oneChapterBook(html: string, extra: Partial<Parameters<WebSerialsEpubBuilder['build']>[0]> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'web-serial-epub-'));
    const htmlPath = join(dir, 'chapter.html');
    await writeFile(htmlPath, html);
    await new WebSerialsEpubBuilder().build({
      outputPath: join(dir, 'book.epub'),
      workDir: dir,
      sourceId: 'source-a',
      seriesPath: '/novel/a',
      seriesTitle: 'Series',
      authors: [],
      volumeLabel: 'Volume 1',
      volumeIndex: '1',
      chapters: [{ title: 'Chapter 1', htmlPath, sourceUrl: 'https://site.test/c/1' }],
      ...extra,
    });
    const read = (path: string) => readFile(join(dir, 'epub-content', path), 'utf8');
    return { dir, chapter: await read('chapters/chapter-0001.xhtml'), opf: await read('content.opf') };
  }

  it('rejects and removes the partial file when aborted while zipping, instead of hanging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-serial-epub-'));
    const chapters: Array<{ title: string; htmlPath: string; sourceUrl: null }> = [];
    for (let index = 0; index < 30; index += 1) {
      const htmlPath = join(dir, `c${index}.html`);
      await writeFile(htmlPath, `<p>${randomBytes(150_000).toString('base64')}</p>`);
      chapters.push({ title: `C${index}`, htmlPath, sourceUrl: null });
    }
    const outputPath = join(dir, 'book.epub');
    const controller = new AbortController();
    const watcher = setInterval(() => {
      if (existsSync(outputPath)) {
        controller.abort();
        clearInterval(watcher);
      }
    }, 1);

    const outcome = await Promise.race([
      new WebSerialsEpubBuilder()
        .build({
          outputPath,
          workDir: dir,
          sourceId: 's',
          seriesPath: 'p',
          seriesTitle: 'T',
          authors: [],
          volumeLabel: 'V',
          volumeIndex: '1',
          chapters,
          signal: controller.signal,
        })
        .then(
          () => 'resolved',
          () => 'rejected',
        ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 8000)),
    ]);
    clearInterval(watcher);

    expect(controller.signal.aborted).toBe(true);
    expect(outcome).toBe('rejected');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('records the modified date, the source language and a separate identity for a whole-series book', async () => {
    const volume = await oneChapterBook('<p>Text</p>', { language: 'Japanese' });
    expect(volume.opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
    expect(volume.opf).toContain('<dc:language>ja</dc:language>');
    expect(volume.chapter).toContain('lang="ja"');

    const series = await oneChapterBook('<p>Text</p>', { identityKey: 'series:series' });
    const id = (opf: string) => /<dc:identifier id="book-id">([^<]+)</.exec(opf)?.[1];
    expect(id(series.opf)).not.toBe(id(volume.opf));
    expect(series.opf).toContain('<dc:language>en</dc:language>');
  });

  it('fetches each image once with checked redirects, and keeps one the host labels as a generic file', async () => {
    safeFetch.mockImplementation(() => Promise.resolve(new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } })));

    const { chapter } = await oneChapterBook('<img src="https://img.test/a"><img src="https://img.test/a"><img src="/b">');

    expect(safeFetch.mock.calls.map((call) => call[0])).toEqual(['https://img.test/a', 'https://site.test/b']);
    for (const call of safeFetch.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: 'manual' });
      expect(call[2]).toMatchObject({ pinResolvedAddress: true });
    }
    expect(chapter.match(/<img src="\.\.\/images\/image-0000\d\.png"\/>/g)).toHaveLength(3);
  });

  it('stops downloading images past the per-chapter cap', async () => {
    safeFetch.mockImplementation(() => Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })));
    const images = Array.from({ length: 45 }, (_, index) => `<img src="https://img.test/${index}.png">`).join('');

    const { chapter } = await oneChapterBook(images);

    expect(safeFetch).toHaveBeenCalledTimes(40);
    expect(chapter.match(/<img /g)).toHaveLength(40);
  });
});
