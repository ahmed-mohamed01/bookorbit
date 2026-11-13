vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), mkdtemp: vi.fn(actual.mkdtemp), open: vi.fn(actual.open) };
});

import { ZipArchive } from 'archiver';
import * as fsPromises from 'fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EpubBookInfo } from '@bookorbit/types';
import { buildIndexNarration, indexAudioFileId, longestForwardRun, readIndexProvenance, sentencePositions } from './epub-index-narration';

async function zip(path: string, entries: Record<string, string>) {
  const archive = new ZipArchive();
  const done = pipeline(archive, createWriteStream(path));
  for (const [name, value] of Object.entries(entries)) archive.append(value, { name, store: name === 'mimetype' });
  await archive.finalize();
  await done;
}

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata/>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml" media-overlay="ch1-smil"/>
    <item id="ch1-smil" href="ch1.smil" media-type="application/smil+xml"/>
    <item id="a1" href="Audio/00001.mp4" media-type="audio/mp4"/>
    <item id="a2" href="Audio/00002.mp4" media-type="audio/mp4"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="ch1"/></spine>
</package>`;

const CH1 = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><style>p { margin: 0 }</style></head><body>
<p><span id="s1">It was dark.</span> <span id="s2">The <em>rain fell</em> hard.</span></p>
<p><span id="s3">Nobody came.</span></p>
</body></html>`;

const SMIL = `<?xml version="1.0"?>
<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body>
  <par><text src="ch1.xhtml#s1"/><audio src="Audio/00001.mp4" clipBegin="1s" clipEnd="2s"/></par>
  <par><text src="ch1.xhtml#s2"/><audio src="Audio/00001.mp4" clipBegin="2s" clipEnd="4s"/></par>
  <par><text src="ch1.xhtml#s3"/><audio src="Audio/00002.mp4" clipBegin="0s" clipEnd="1s"/></par>
</body></smil>`;

// The worker's input order: audiobook file 31 is 0001, file 30 is 0002. `backwards` swaps them, so
// s3's audio sits before s1's, as Storyteller can time a title page in the credits.
const provenance = (epubFileId: number, backwards = false) => ({
  version: 1,
  bookId: 7,
  epub: { bookFileId: epubFileId },
  audio: [
    { bookFileId: 31, order: backwards ? 1 : 0 },
    { bookFileId: 30, order: backwards ? 0 : 1 },
  ],
  sources: [
    { name: '00001.mp4', source: backwards ? '0002.m4b' : '0001.m4b', start: 100, end: 200 },
    { name: '00002.mp4', source: backwards ? '0001.m4b' : '0002.m4b', start: 5, end: 50 },
  ],
  audioEntries: [
    { href: 'OEBPS/Audio/00001.mp4', chunk: '00001.mp4', size: 1 },
    { href: 'OEBPS/Audio/00002.mp4', chunk: '00002.mp4', size: 1 },
  ],
});

const plainInfo = {
  containerPath: 'OEBPS/content.opf',
  rootPath: 'OEBPS/',
  spine: [
    { idref: 'cover', href: 'OEBPS/cover.xhtml', mediaType: 'application/xhtml+xml', linear: true },
    { idref: 'ch1', href: 'OEBPS/ch1.xhtml', mediaType: 'application/xhtml+xml', linear: true },
  ],
  manifest: [],
  toc: null,
  metadata: {},
  coverPath: null,
} as EpubBookInfo;

describe('sentencePositions', () => {
  it('counts each sentence in characters that are not whitespace, from the start of the body', () => {
    const p = sentencePositions(CH1, new Set(['s1', 's2', 's3']))!;
    expect(p.ids).toEqual(['s1', 's2', 's3']);
    expect(p.starts).toEqual([0, 10, 26]);
    expect(p.ends).toEqual([10, 26, 37]);
    expect(p.length).toBe(37);
    // The same hash Absorb and the reader compute: h = h * 31 + c over the counted characters.
    let h = 0;
    for (const c of 'Itwasdark.Therainfellhard.Nobodycame.') h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    expect(p.hash).toBe(h | 0);
  });

  it('leaves style and script text out', () => {
    expect(sentencePositions('<html><body><style>x</style><p id="a">Hi</p><script>y</script></body></html>', new Set(['a']))!.length).toBe(2);
  });

  it('decodes numeric references as XML does, the code point as written', () => {
    const p = sentencePositions('<html><body><p id="a">&#128;&#x80;&#8364;&amp;#128;</p></body></html>', new Set(['a']))!;
    let h = 0;
    for (const c of '\u0080\u0080\u20ac&#128;') h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    expect(p.hash).toBe(h | 0);
    expect(p.length).toBe(9);
  });

  it('decodes named entities as a browser does, and a no-break space is whitespace', () => {
    const p = sentencePositions(
      '<html><body><p id="a">A&nbsp;b&mdash;c&rsquo;d.</p><p id="b">&amp;nbsp;&#65;</p></body></html>',
      new Set(['a', 'b']),
    )!;
    expect(p.ends).toEqual([7, 14]);
    let h = 0;
    for (const c of 'Ab\u2014c\u2019d.&nbsp;A') h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    expect(p.hash).toBe(h | 0);
  });

  it('counts CDATA as it is written', () => {
    const p = sentencePositions('<html><body><p id="a">x<![CDATA[y&amp;z]]></p></body></html>', new Set(['a']))!;
    expect(p.length).toBe(8);
  });

  it('leaves svg and math text out, in any case', () => {
    const chapter = '<html><body><p id="a">Hi<svg><text>no</text></svg><m:MATH xmlns:m="x"><m:mi>x</m:mi></m:MATH><SVG>no</SVG></p></body></html>';
    expect(sentencePositions(chapter, new Set(['a']))!.length).toBe(2);
  });

  it('leaves out a sentence with nothing to count', () => {
    const p = sentencePositions(
      '<html><body><p><span id="a"><img src="x.png"/></span><span id="b">Hi</span></p></body></html>',
      new Set(['a', 'b']),
    )!;
    expect(p.ids).toEqual(['b']);
  });

  it('is null for a chapter without a body', () => {
    expect(sentencePositions('<html><p id="a">Hi</p></html>', new Set(['a']))).toBeNull();
  });
});

describe('longestForwardRun', () => {
  it('drops the entries that would go back in time', () => {
    expect(longestForwardRun([5, 1, 2, 3, 0, 4])).toEqual([1, 2, 3, 5]);
    expect(longestForwardRun([])).toEqual([]);
  });
});

describe('buildIndexNarrationPlaylist', () => {
  let root: string;
  let indexPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'index-narration-'));
    indexPath = join(root, 'book.bookorbit-timings');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeIndex(epubFileId = 12, options: { backwards?: boolean; chapter?: string; smil?: string } = {}) {
    await zip(indexPath, {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      'OEBPS/content.opf': OPF,
      'OEBPS/cover.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Cover</p></body></html>',
      'OEBPS/ch1.xhtml': options.chapter ?? CH1,
      'OEBPS/ch1.smil': options.smil ?? SMIL,
      'bookorbit-timings/provenance.json': JSON.stringify(provenance(epubFileId, options.backwards)),
    });
  }

  async function audioFiles() {
    const part1 = join(root, 'part1.m4b');
    const part2 = join(root, 'part2.m4b');
    await writeFile(part1, Buffer.alloc(1000));
    await writeFile(part2, Buffer.alloc(2000));
    return [
      { id: 30, absolutePath: part2 },
      { id: 31, absolutePath: part1 },
    ];
  }

  const build = async (files: { id: number; absolutePath: string }[]) =>
    (await buildIndexNarration({ indexPath, plainInfo, bookId: 7, fileId: 12, audioFiles: files }))?.playlist ?? null;

  it('plays each sentence from the audiobook file and second it was cut from', async () => {
    await writeIndex();
    const playlist = await build(await audioFiles());
    expect(playlist?.source).toBe('timing-index');
    // Provenance order puts file 31 (0001) before file 30 (0002), so s1, s2, s3 run forward.
    expect(playlist!.items.map((item) => [item.textFragment, item.audioHref, item.clipBeginSeconds, item.clipEndSeconds])).toEqual([
      ['s1', 'bookorbit-audio/31.m4b', 101, 102],
      ['s2', 'bookorbit-audio/31.m4b', 102, 104],
      ['s3', 'bookorbit-audio/30.m4b', 5, 6],
    ]);
    expect(playlist!.items.every((item) => item.sectionIndex === 1)).toBe(true);
    expect(playlist!.sections).toEqual([expect.objectContaining({ index: 1, href: 'OEBPS/ch1.xhtml', startSeconds: 0, durationSeconds: 4 })]);
    expect(playlist!.resources).toEqual([
      { href: 'bookorbit-audio/31.m4b', mediaType: 'audio/mp4', size: 1000 },
      { href: 'bookorbit-audio/30.m4b', mediaType: 'audio/mp4', size: 2000 },
    ]);
    expect(playlist!.textPositions?.['OEBPS/ch1.xhtml']?.ids).toEqual(['s1', 's2', 's3']);
    expect(indexAudioFileId('bookorbit-audio/31.m4b')).toBe(31);
  });

  it('follows the provenance order, whatever order the book lists its audio files in', async () => {
    await writeIndex();
    const files = await audioFiles();
    expect(await build([...files].reverse())).toEqual(await build(files));
  });

  it('drops the sentences whose audio goes back in the provenance order', async () => {
    await writeIndex(12, { backwards: true });
    const playlist = await build(await audioFiles());
    expect(playlist!.items.map((item) => item.textFragment)).toEqual(['s1', 's2']);
    expect(playlist!.resources.map((item) => item.href)).toEqual(['bookorbit-audio/31.m4b']);
  });

  it('leaves out a sentence with no text to mark', async () => {
    await writeIndex(12, {
      chapter: CH1.replace('<p><span id="s1">', '<p><span id="s0"><img src="x.png"/></span><span id="s1">'),
      smil: SMIL.replace('<par>', '<par><text src="ch1.xhtml#s0"/><audio src="Audio/00001.mp4" clipBegin="0s" clipEnd="1s"/></par>\n  <par>'),
    });
    const playlist = await build(await audioFiles());
    expect(playlist!.items.map((item) => item.textFragment)).toEqual(['s1', 's2', 's3']);
    expect(playlist!.textPositions?.['OEBPS/ch1.xhtml']?.ids).toEqual(['s1', 's2', 's3']);
  });

  it('never reads an audiobook file the index does not play', async () => {
    await writeIndex();
    const playlist = await build([...(await audioFiles()), { id: 40, absolutePath: join(root, 'missing.m4b') }]);
    expect(playlist!.items).toHaveLength(3);
  });

  it('rejects, rather than throwing from a stream, when the index is gone', async () => {
    await expect(
      buildIndexNarration({ indexPath: join(root, 'gone.bookorbit-timings'), plainInfo, bookId: 7, fileId: 12, audioFiles: [] }),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readIndexProvenance(join(root, 'gone.bookorbit-timings'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /** The private copy directories builds made, to check none is left behind. */
  const privateCopyDirs = async () => {
    const made = await Promise.all(vi.mocked(fsPromises.mkdtemp).mock.results.map((result) => result.value as Promise<string>));
    return made.filter((dir) => dir.includes('bookorbit-index-'));
  };

  it('reads a private copy, so deleting the index while it builds changes nothing', async () => {
    await writeIndex();
    const files = await audioFiles();
    vi.mocked(fsPromises.mkdtemp).mockClear();
    const actualCopy = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fsPromises.copyFile).mockImplementationOnce(async (source, destination) => {
      await actualCopy.copyFile(source, destination);
      await rm(indexPath);
    });
    expect((await build(files))?.items.length).toBeGreaterThan(0);
    expect(existsSync(indexPath)).toBe(false);
    const dirs = await privateCopyDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it('removes its private copy when the build fails', async () => {
    await writeFile(indexPath, 'not a zip');
    vi.mocked(fsPromises.mkdtemp).mockClear();
    await expect(build(await audioFiles())).rejects.toThrow();
    const dirs = await privateCopyDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it('reads the provenance from one open handle, so deleting the index meanwhile changes nothing', async () => {
    await writeIndex();
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fsPromises.open).mockImplementationOnce(async (path, flags) => {
      const handle = await actual.open(path, flags);
      await rm(indexPath);
      return handle;
    });
    expect(await readIndexProvenance(indexPath)).toMatchObject({ epub: { bookFileId: 12 } });
    expect(existsSync(indexPath)).toBe(false);
  });

  it('reads no provenance from a file that is not a zip', async () => {
    await writeFile(indexPath, 'not a zip');
    await expect(readIndexProvenance(indexPath)).rejects.toThrow();
  });

  it('is null for an index made from another EPUB', async () => {
    await writeIndex(99);
    expect(await build(await audioFiles())).toBeNull();
  });

  it('is null when the book no longer has the audio the index was cut from', async () => {
    await writeIndex();
    expect(await build([{ id: 50, absolutePath: '/x.m4b' }])).toBeNull();
  });
});
