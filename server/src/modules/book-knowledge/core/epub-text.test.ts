import { Logger } from '@nestjs/common';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import { extractEpubText } from './epub-text';

interface Doc {
  name: string;
  html: string;
  linear?: 'no';
  missing?: boolean;
}

async function epub(documents: Doc[], { nav = true, navHref = 'nav.xhtml' }: { nav?: boolean; navHref?: string } = {}): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    'META-INF/container.xml',
    new TextReader('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),
  );
  const items = documents.map((doc, i) => `<item id="c${i}" href="${doc.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = documents.map((doc, i) => `<itemref idref="c${i}"${doc.linear ? ` linear="${doc.linear}"` : ''}/>`).join('');
  await writer.add(
    'EPUB/package.opf',
    new TextReader(
      `<package><manifest>${items}<item id="nav" href="${navHref}" properties="nav" media-type="application/xhtml+xml"/></manifest><spine>${spine}</spine></package>`,
    ),
  );
  if (nav) {
    const links = documents.map((doc) => `<a href="${doc.name}">${doc.name}</a>`).join('');
    await writer.add(`EPUB/${navHref}`, new TextReader(`<html><body><nav>${links}<a href="bad%E0%A4%A.xhtml">Bad</a></nav></body></html>`));
  }
  for (const doc of documents) if (!doc.missing) await writer.add(`EPUB/${doc.name}`, new TextReader(`<html><body>${doc.html}</body></html>`));
  return Buffer.from(await writer.close());
}

describe('EPUB text extraction', () => {
  it('records each spine item uncompressed size as Foliate weighs it, with non-linear items at zero', async () => {
    const heavy = `<div class="a"><div class="b"><span class="c">${'<span class="x"></span>'.repeat(200)}</span></div></div><p>Short opening line.</p>`;
    const documents: Doc[] = [
      { name: 'one.xhtml', html: heavy },
      { name: 'two.xhtml', html: '<p>The second chapter holds a longer passage of plain prose.</p>' },
      { name: 'aside.xhtml', html: '<p>An aside the reader skips.</p>', linear: 'no' },
    ];
    const text = await extractEpubText(await epub(documents));
    const size = (doc: Doc) => Buffer.byteLength(`<html><body>${doc.html}</body></html>`);
    expect(text.spineBytes).toEqual([size(documents[0]), size(documents[1]), 0]);
  });

  it('builds without its nav file, a missing spine item or a bad percent-escape, with one warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const text = await extractEpubText(
        await epub(
          [
            { name: 'one.xhtml', html: '<p>The lantern keeper wakes.</p>' },
            { name: 'gone.xhtml', html: '<p>Never packed.</p>', missing: true },
            { name: 'bad%E0%A4%A.xhtml', html: '<p>Unreadable name.</p>' },
            { name: 'three.xhtml', html: '<p>The lantern keeper sleeps.</p>' },
          ],
          { nav: false },
        ),
      );
      expect(text.sentences.map((sentence) => sentence.text)).toEqual(['The lantern keeper wakes.', 'The lantern keeper sleeps.']);
      expect(text.sentences.map((sentence) => sentence.spineIndex)).toEqual([0, 3]);
      expect(text.spineBytes?.[1]).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped=3'));
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a nav link with a bad percent-escape and keeps the other titles', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const text = await extractEpubText(await epub([{ name: 'one.xhtml', html: '<p>The lantern keeper wakes.</p>' }]));
      expect(text.sentences).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
