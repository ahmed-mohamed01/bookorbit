// @vitest-environment jsdom
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WebSerialsEpubBuilder } from './web-serials-epub.builder';

vi.mock('../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));

/** A browser's XHTML parser, which is what foliate and Apple Books use: any well-formedness error is a parsererror. */
function parseErrors(xml: string): number {
  return new DOMParser().parseFromString(xml, 'application/xhtml+xml').getElementsByTagName('parsererror').length;
}

async function buildChapter(html: string, title = 'Chapter 1', extra: { missing?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'web-serial-xhtml-'));
  const htmlPath = join(dir, 'chapter.html');
  await writeFile(htmlPath, html);
  await new WebSerialsEpubBuilder().build({
    outputPath: join(dir, 'book.epub'),
    workDir: dir,
    sourceId: 's',
    seriesPath: 'p',
    seriesTitle: 'Series',
    authors: [],
    volumeLabel: 'Volume 1',
    volumeIndex: '1',
    chapters: [{ title, htmlPath, sourceUrl: 'https://site.test/c/1', ...extra }],
  });
  const read = (path: string) => readFile(join(dir, 'epub-content', path), 'utf8');
  return { chapter: await read('chapters/chapter-0001.xhtml'), nav: await read('nav.xhtml'), opf: await read('content.opf') };
}

describe('WebSerialsEpubBuilder XHTML', () => {
  it('writes chapters a strict XML parser accepts, whatever entities and characters the site used', async () => {
    const { chapter, nav, opf } = await buildChapter(
      '<p>a&nbsp;b &copy; c\u0008d\u000Be￾f &hellip;</p><p>&#x1;</p><a href="https://x.test/?a=1&b=<2>">link</a><img alt="a&quot;b>c<d" src="">',
      'Chapter \u0001 1 & <x>',
    );

    for (const xml of [chapter, nav, opf]) expect(parseErrors(xml)).toBe(0);
    expect(chapter).toContain('a b © cde');
    expect(chapter).toContain('<h1>Chapter  1 &amp; &lt;x&gt;</h1>');
    expect(chapter).toContain('href="https://x.test/?a=1&amp;b=%3C2%3E"');
  });

  it('keeps only links that leave the book, and drops every script-capable scheme', async () => {
    const { chapter } = await buildChapter(
      [
        '<a href="java\tscript:alert(1)">t1</a>',
        '<a href="data:text/html,x">t2</a>',
        '<a href="vbscript:x">t3</a>',
        '<a href="next.html">t4</a>',
        '<a href="/novel/index">t5</a>',
        '<a href="https://site.test/c/2">t6</a>',
        '<a href="mailto:a@b.test">t7</a>',
      ].join(''),
    );

    expect(parseErrors(chapter)).toBe(0);
    expect(chapter).toContain('<a>t1</a><a>t2</a><a>t3</a><a>t4</a><a>t5</a>');
    expect(chapter).toContain('<a href="https://site.test/c/2">t6</a><a href="mailto:a@b.test">t7</a>');
  });

  it('files a chapter the source never delivered as a short notice', async () => {
    const { chapter } = await buildChapter('', 'Chapter 57', { missing: true });

    expect(parseErrors(chapter)).toBe(0);
    expect(chapter).toContain('<h1>Chapter 57</h1><p>This chapter could not be downloaded from the source.</p>');
  });
});
