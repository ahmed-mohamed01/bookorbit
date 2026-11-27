import { Logger } from '@nestjs/common';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import { classifyDocument, extractEpubText } from './epub-text';

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
  it('marks a blockquote and a run of three paragraphs in an uncommon class as inset, and nothing else', async () => {
    const plain = (text: string) => `<p class="body">${text}</p>`;
    const html = [
      plain('The clerk opened the logbook.'),
      plain('He cleared his throat.'),
      '<blockquote><p>We sighted land at dawn.</p></blockquote>',
      plain('The clerk turned the page.'),
      '<p class="log">Day one, calm seas.</p>',
      '<p class="log">Day two, a squall.</p>',
      '<p class="log">Day three, the mast cracked.</p>',
      plain('He paused for breath.'),
      '<p class="note">Wind from the east.</p>',
      '<p class="note">Rain by noon.</p>',
      plain('The harbour bell rang.'),
      plain('Nobody moved.'),
    ].join('');
    const text = await extractEpubText(await epub([{ name: 'one.xhtml', html }]));
    expect(text.sentences.filter((sentence) => sentence.inset).map((sentence) => sentence.text)).toEqual([
      'We sighted land at dawn.',
      'Day one, calm seas.',
      'Day two, a squall.',
      'Day three, the mast cracked.',
    ]);
    expect(text.sentences.find((sentence) => sentence.text === 'Rain by noon.')).not.toHaveProperty('inset');
  });

  it('marks nothing inset in plain text', async () => {
    const html = '<p>The lamp flickered.</p><p>The keeper climbed.</p><p>The gulls were quiet.</p><p>Night fell.</p>';
    const text = await extractEpubText(await epub([{ name: 'one.xhtml', html }]));
    expect(text.sentences).toHaveLength(4);
    expect(text.sentences.some((sentence) => sentence.inset)).toBe(false);
  });

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

  it('reads text in divs and table cells beside paragraphs, and ends a sentence at each line break', async () => {
    const html = [
      '<h2>Chapter 3</h2>',
      '<div class="calibre1">The bell broke at noon.</div>',
      '<p class="status">Strength: 12<br/>Agility: 9<br/>Mana Shield (Novice)</p>',
      '<table><tr><th>Stamina</th><td>40</td></tr></table>',
      '<div>Loose text <p>They fled.</p> after it.</div>',
      '<pre>Level 4\nClass: Warden</pre>',
    ].join('');
    const text = await extractEpubText(await epub([{ name: 'one.xhtml', html }]));
    expect(text.sentences.map((sentence) => sentence.text)).toEqual([
      'Chapter 3',
      'The bell broke at noon.',
      'Strength: 12',
      'Agility: 9',
      'Mana Shield (Novice)',
      'Stamina',
      '40',
      'Loose text',
      'They fled.',
      'after it.',
      'Level 4',
      'Class: Warden',
    ]);
    const status = text.sentences.filter((sentence) => /Strength|Agility|Mana/.test(sentence.text));
    expect(new Set(status.map((sentence) => sentence.paragraphIndex)).size).toBe(1);
    expect(text.sentences[0].heading).toBe(true);
  });

  it('keeps emphasis on the right sentence across a line break', async () => {
    const html = '<p>Skill gained: <b>Power Strike</b><br/>Then <i>Mana Shield</i> woke.</p>';
    const text = await extractEpubText(await epub([{ name: 'one.xhtml', html }]));
    expect(text.sentences.map(({ text: line, emphasis }) => [line, emphasis])).toEqual([
      ['Skill gained: Power Strike', ['Power Strike']],
      ['Then Mana Shield woke.', ['Mana Shield']],
    ]);
  });

  it('keeps chapters whose titles hold a back-matter word as story', async () => {
    const story = '<p>They ran for the trees and did not look back.</p>';
    const documents: Doc[] = [
      { name: 'ch07.xhtml', html: `<h1>Taking Cover</h1>${story}` },
      { name: 'ch08.xhtml', html: `<h1>Field Notes</h1>${story}` },
      { name: 'ch09.xhtml', html: `<h1>Chapter 12: References</h1>${story}` },
      { name: 'ch10.xhtml', html: `<h1>Notes</h1><p>1. A source.</p>` },
    ];
    const text = await extractEpubText(await epub(documents));
    const structures = (href: string) => new Set(text.sentences.filter((sentence) => sentence.href.endsWith(href)).map(({ structure }) => structure));
    expect(structures('ch07.xhtml')).toEqual(new Set(['body']));
    expect(structures('ch08.xhtml')).toEqual(new Set(['body']));
    expect(structures('ch09.xhtml')).toEqual(new Set(['body']));
    expect(structures('ch10.xhtml')).toEqual(new Set(['notes']));
  });

  it('classifies a document by its declared role first and by a whole label only when every label agrees', () => {
    const signals = (extra: Partial<Parameters<typeof classifyDocument>[0]>) => ({ filename: '', titles: [], heading: '', structural: '', ...extra });
    expect(classifyDocument(signals({ titles: ['The Index Case'] }), 'prose')).toBe('body');
    expect(classifyDocument(signals({ titles: ['Contents Under Pressure'] }), 'prose')).toBe('body');
    expect(classifyDocument(signals({ titles: ['Copyright', 'Chapter One'] }), 'prose')).toBe('body');
    expect(classifyDocument(signals({ titles: ['Copyright', 'Dedication'] }), 'prose')).toBe('front');
    expect(classifyDocument(signals({ titles: ['Acknowledgments'] }), 'prose')).toBe('front');
    expect(classifyDocument(signals({ filename: 'copyright' }), 'prose')).toBe('front');
    expect(classifyDocument(signals({ structural: 'bodymatter chapter', titles: ['Notes'] }), 'prose')).toBe('body');
    expect(classifyDocument(signals({ structural: 'endnotes' }), 'prose')).toBe('notes');
  });
});
