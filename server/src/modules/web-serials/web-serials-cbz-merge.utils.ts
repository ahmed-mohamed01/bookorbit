import { createWriteStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { extname } from 'path';
import { Transform, type Readable } from 'stream';
import { BadGatewayException } from '@nestjs/common';
import { ZipArchive, type Archiver } from 'archiver';

import { createCbzZipEntryReadStream, isSupportedCbzZipCompression, readCbzZipIndex } from '../../common/cbz-zip-reader';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const MAX_MERGED_PAGES = 250_000;
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export interface MergedCbzMetadata {
  series: string;
  title: string;
  volume?: string | null;
  number: string;
  writers: string[];
  pencillers: string[];
  summary: string | null;
  genres: string[];
  language: string | null;
  web: string | null;
}

export interface MergedCbzResult {
  path: string;
  pages: number;
  sizeBytes: number;
}

export async function mergeCbzChapters(
  chapterPaths: readonly string[],
  outputPath: string,
  metadata: MergedCbzMetadata,
  sizeCap: number,
): Promise<MergedCbzResult> {
  const partialPath = `${outputPath}.part`;
  await rm(partialPath, { force: true });
  await rm(outputPath, { force: true });

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const limiter = outputSizeCap(sizeCap);
  const output = createWriteStream(partialPath, { flags: 'wx' });
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => undefined);
  archive.on('error', rejectFailure);
  limiter.on('error', rejectFailure);
  output.on('error', rejectFailure);
  const closed = new Promise<void>((resolve) => output.once('close', resolve));
  archive.pipe(limiter).pipe(output);

  let pages = 0;
  try {
    for (let chapterIndex = 0; chapterIndex < chapterPaths.length; chapterIndex += 1) {
      const chapterPath = chapterPaths[chapterIndex]!;
      const index = await readCbzZipIndex(chapterPath);
      if (!index) throw new BadGatewayException('A downloaded chapter is not a valid CBZ file');
      const entries = index.entries
        .filter((entry) => IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .sort((left, right) => COLLATOR.compare(left.name, right.name));
      for (let pageIndex = 0; pageIndex < entries.length; pageIndex += 1) {
        const entry = entries[pageIndex]!;
        if (!isSupportedCbzZipCompression(entry)) throw new BadGatewayException('A downloaded chapter uses unsupported ZIP compression');
        pages += 1;
        if (pages > MAX_MERGED_PAGES) throw new BadGatewayException('The merged book has too many pages');
        const name = `${String(chapterIndex + 1).padStart(4, '0')}-${String(pageIndex + 1).padStart(4, '0')}${extname(entry.name).toLowerCase()}`;
        await Promise.race([appendEntry(archive, () => createCbzZipEntryReadStream(chapterPath, entry) as Readable, name, rejectFailure), failure]);
      }
    }
    if (pages === 0) throw new BadGatewayException('The downloaded chapters do not contain any pages');
    await Promise.race([appendEntry(archive, Buffer.from(buildComicInfo(metadata), 'utf8'), 'ComicInfo.xml', rejectFailure), failure]);
    void archive.finalize();
    await Promise.race([closed, failure]);
    await rename(partialPath, outputPath);
    return { path: outputPath, pages, sizeBytes: (await stat(outputPath)).size };
  } catch (error) {
    archive.abort();
    output.destroy();
    await rm(partialPath, { force: true }).catch(() => undefined);
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function appendEntry(archive: Archiver, source: Buffer | (() => Readable), name: string, fail: (error: Error) => void): Promise<void> {
  return new Promise((resolve) => {
    const opened = typeof source === 'function' ? source() : source;
    if (!Buffer.isBuffer(opened)) opened.once('error', fail);
    archive.once('entry', () => resolve());
    archive.append(opened, { name });
  });
}

function outputSizeCap(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > limit ? new BadGatewayException('The merged book is larger than the allowed size') : null, chunk);
    },
  });
}

function buildComicInfo(metadata: MergedCbzMetadata): string {
  const fields: Array<[string, string | null | undefined]> = [
    ['Series', metadata.series],
    ['Title', metadata.title],
    ['Volume', metadata.volume],
    ['Number', metadata.number],
    ['Writer', metadata.writers.join(', ') || null],
    ['Penciller', metadata.pencillers.join(', ') || null],
    ['Summary', metadata.summary],
    ['Genre', metadata.genres.join(', ') || null],
    ['LanguageISO', metadata.language],
    ['Web', metadata.web],
  ];
  const body = fields
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => `  <${key}>${escapeXml(value)}</${key}>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n${body}\n</ComicInfo>`;
}

// XML 1.0 forbids most control characters; one in a synopsis would leave ComicInfo.xml unreadable.
const INVALID_XML_CHARS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
