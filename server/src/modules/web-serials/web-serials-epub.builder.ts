import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadGatewayException, Injectable } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import { load } from 'cheerio';

import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { readBoundedBytes, ResponseTooLargeError } from '../../common/utils/bounded-response';
import { declaredContentType, fetchUntrusted, imageExtension, mayBeImageType, resolveImageType } from './engines/untrusted-fetch.utils';
import { WEB_SERIAL_SIZE_CAPS } from './web-serials-import.service';

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 12_000;
const IMAGE_CONCURRENCY = 4;
const MAX_IMAGES_PER_CHAPTER = 40;
const MAX_IMAGES_PER_BOOK = 400;
const MISSING_CHAPTER_BODY = '<p>This chapter could not be downloaded from the source.</p>';
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  english: 'en',
  french: 'fr',
  german: 'de',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
  thai: 'th',
  turkish: 'tr',
  vietnamese: 'vi',
};
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'form', 'object', 'embed', 'input', 'button', 'textarea', 'select', 'option']);
const KEEP_TAGS = new Set([
  'p',
  'br',
  'em',
  'strong',
  'i',
  'b',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'hr',
  'ul',
  'ol',
  'li',
  'img',
  'a',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
]);

export interface EpubChapterInput {
  title: string;
  htmlPath: string;
  sourceUrl: string | null;
  /** The source never delivered this chapter; the book carries a short notice in its place. */
  missing?: boolean;
}

export interface WebSerialEpubInput {
  outputPath: string;
  workDir: string;
  sourceId: string;
  seriesPath: string;
  seriesTitle: string;
  authors: string[];
  volumeLabel: string;
  volumeIndex: string;
  /** Tells books of one series apart in the identifier; defaults to the volume index. */
  identityKey?: string;
  language?: string | null;
  chapters: EpubChapterInput[];
  cover?: { body: Buffer; contentType: string } | null;
  signal?: AbortSignal;
}

type ImageEntry = { href: string; mediaType: string };

interface ImageBudget {
  manifest: Map<string, ImageEntry>;
  byUrl: Map<string, Promise<ImageEntry | null>>;
  started: number;
}

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

@Injectable()
export class WebSerialsEpubBuilder {
  async build(input: WebSerialEpubInput): Promise<{ path: string; size: number }> {
    input.signal?.throwIfAborted();
    const contentDir = join(input.workDir, 'epub-content');
    const chapterDir = join(contentDir, 'chapters');
    const imageDir = join(contentDir, 'images');
    await mkdir(chapterDir, { recursive: true });
    await mkdir(imageDir, { recursive: true });

    const language = epubLanguage(input.language);
    const images: ImageBudget = { manifest: new Map(), byUrl: new Map(), started: 0 };
    const chapterFiles: string[] = [];
    for (let index = 0; index < input.chapters.length; index += 1) {
      input.signal?.throwIfAborted();
      const chapter = input.chapters[index]!;
      const body = chapter.missing
        ? MISSING_CHAPTER_BODY
        : await this.sanitizeChapter(await readFile(chapter.htmlPath, 'utf8'), chapter.title, chapter.sourceUrl, imageDir, images, input.signal);
      const file = `chapter-${String(index + 1).padStart(4, '0')}.xhtml`;
      await writeFile(join(chapterDir, file), chapterXhtml(chapter.title, body, language));
      chapterFiles.push(file);
    }

    const cover = await this.writeCover(input.cover ?? null, contentDir);
    const identifier = stableUuid(`${input.sourceId}\0${input.seriesPath}\0${input.identityKey ?? input.volumeIndex}`);
    await mkdir(join(contentDir, 'META-INF'), { recursive: true });
    await writeFile(join(contentDir, 'META-INF', 'container.xml'), containerXml());
    await writeFile(join(contentDir, 'nav.xhtml'), navXhtml(input.chapters, chapterFiles, language));
    await writeFile(join(contentDir, 'toc.ncx'), tocNcx(identifier, input.seriesTitle, input.chapters, chapterFiles));
    if (cover) await writeFile(join(contentDir, 'cover.xhtml'), coverXhtml(cover.href, language));
    await writeFile(join(contentDir, 'content.opf'), opf(input, identifier, language, chapterFiles, images.manifest, cover));

    await this.archive(input.outputPath, contentDir, chapterFiles, images.manifest, cover, input.signal);
    const size = (await stat(input.outputPath)).size;
    if (size > WEB_SERIAL_SIZE_CAPS.novel) throw new BadGatewayException('The generated EPUB is larger than the allowed size');
    return { path: input.outputPath, size };
  }

  private async sanitizeChapter(
    html: string,
    title: string,
    sourceUrl: string | null,
    imageDir: string,
    images: ImageBudget,
    signal?: AbortSignal,
  ): Promise<string> {
    const $ = load(html, { xmlMode: false });
    $('*').each((_index, element) => {
      const node = element as unknown as { tagName?: string; attribs?: Record<string, string> };
      const tag = node.tagName?.toLowerCase();
      if (!tag || tag === 'html' || tag === 'head' || tag === 'body') return;
      if (DROP_TAGS.has(tag)) {
        $(element).remove();
        return;
      }
      if (!KEEP_TAGS.has(tag)) {
        $(element).replaceWith($(element).contents());
        return;
      }
      for (const name of Object.keys(node.attribs ?? {})) {
        const lower = name.toLowerCase();
        const allowed = (tag === 'a' && lower === 'href') || (tag === 'img' && ['src', 'alt', 'title'].includes(lower));
        if (!allowed) $(element).removeAttr(name);
      }
      if (tag === 'a') {
        const href = externalHref($(element).attr('href'));
        if (href) $(element).attr('href', href);
        else $(element).removeAttr('href');
      }
    });

    dropRepeatedTitle($, title);

    const imageElements = $('img').toArray();
    const resolved = await mapWithConcurrency(imageElements, IMAGE_CONCURRENCY, async (element, index) => {
      signal?.throwIfAborted();
      const src = $(element).attr('src');
      if (!src || index >= MAX_IMAGES_PER_CHAPTER) return null;
      return this.imageFor(src, sourceUrl, imageDir, images, signal);
    });
    imageElements.forEach((element, index) => {
      const image = resolved[index];
      if (image) $(element).attr('src', `../${image.href}`);
      else $(element).remove();
    });
    return serializeNodes($('body').contents().toArray() as unknown as DomNode[]);
  }

  /** One download per distinct URL in the book, and no new downloads once the book's budget is spent. */
  private imageFor(src: string, sourceUrl: string | null, imageDir: string, images: ImageBudget, signal?: AbortSignal): Promise<ImageEntry | null> {
    let url: URL;
    try {
      url = new URL(src, sourceUrl ?? undefined);
    } catch {
      return Promise.resolve(null);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve(null);
    const existing = images.byUrl.get(url.href);
    if (existing) return existing;
    if (images.started >= MAX_IMAGES_PER_BOOK) return Promise.resolve(null);
    images.started += 1;
    const pending = this.downloadImage(url, imageDir, images.started, signal)
      .then((image) => {
        images.manifest.set(image.href, image);
        return image;
      })
      .catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return null;
      });
    images.byUrl.set(url.href, pending);
    return pending;
  }

  private async downloadImage(url: URL, imageDir: string, number: number, signal?: AbortSignal): Promise<ImageEntry> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]) : AbortSignal.timeout(IMAGE_TIMEOUT_MS);
    const response = await fetchUntrusted(url.href, { headers: { Accept: 'image/*' }, signal: combined });
    const declared = declaredContentType(response);
    if (!response.ok || !mayBeImageType(declared)) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException('A chapter image could not be loaded');
    }
    let body: Buffer;
    try {
      body = await readBoundedBytes(response, IMAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new BadGatewayException('A chapter image is too large');
      throw error;
    }
    const mediaType = resolveImageType(declared, body);
    const extension = mediaType ? imageExtension(mediaType) : undefined;
    if (!mediaType || !extension) throw new BadGatewayException('A chapter image has an unsupported type');
    const name = `image-${String(number).padStart(5, '0')}.${extension}`;
    await writeFile(join(imageDir, name), body);
    return { href: `images/${name}`, mediaType };
  }

  private async writeCover(cover: WebSerialEpubInput['cover'], contentDir: string): Promise<ImageEntry | null> {
    if (!cover) return null;
    const mediaType = cover.contentType.split(';', 1)[0]!.trim().toLowerCase();
    const extension = imageExtension(mediaType);
    if (!extension || cover.body.length > IMAGE_MAX_BYTES) return null;
    const href = `cover.${extension}`;
    await writeFile(join(contentDir, href), cover.body);
    return { href, mediaType };
  }

  private async archive(
    outputPath: string,
    contentDir: string,
    chapterFiles: string[],
    images: Map<string, ImageEntry>,
    cover: ImageEntry | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const output = createWriteStream(outputPath);
    archive.append('application/epub+zip', { name: 'mimetype', store: true });
    archive.file(join(contentDir, 'META-INF', 'container.xml'), { name: 'META-INF/container.xml' });
    for (const name of ['content.opf', 'nav.xhtml', 'toc.ncx']) archive.file(join(contentDir, name), { name: `OEBPS/${name}` });
    if (cover) {
      archive.file(join(contentDir, cover.href), { name: `OEBPS/${cover.href}` });
      archive.file(join(contentDir, 'cover.xhtml'), { name: 'OEBPS/cover.xhtml' });
    }
    for (const file of chapterFiles) archive.file(join(contentDir, 'chapters', file), { name: `OEBPS/chapters/${file}` });
    for (const image of images.values()) archive.file(join(contentDir, image.href), { name: `OEBPS/${image.href}` });
    let written = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > WEB_SERIAL_SIZE_CAPS.novel) {
          callback(new BadGatewayException('The generated EPUB is larger than the allowed size'));
          return;
        }
        callback(null, chunk);
      },
    });
    // After an abort or a cap error the finalize promise may never settle; the pipeline is what reports the outcome.
    const finalized = archive.finalize();
    finalized.catch(() => undefined);
    try {
      await pipeline(archive, cap, output, signal ? { signal } : {});
      await finalized;
    } catch (error) {
      archive.abort();
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

const MAX_LEADING_TITLE_ELEMENTS = 3;

/** Sites often repeat the chapter title at the top of the text; the chapter page already carries it as its heading. */
function dropRepeatedTitle($: ReturnType<typeof load>, title: string): void {
  const wanted = collapse(title);
  if (!wanted) return;
  let removed = 0;
  for (const node of $('body').contents().toArray()) {
    if (removed >= MAX_LEADING_TITLE_ELEMENTS) return;
    const text = collapse($(node).text());
    const hasImage = $(node).find('img').length > 0;
    if (!text && !hasImage) continue;
    if (text !== wanted) return;
    $(node).remove();
    removed += 1;
  }
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Characters XML 1.0 does not allow anywhere, not even as character references.
const INVALID_XML_CHARS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}

/** Writes the sanitised tree as XML: only text and kept elements survive, every character is escaped, void elements self-close. */
function serializeNodes(nodes: DomNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += escapeXml(node.data ?? '');
      continue;
    }
    if (node.type !== 'tag' || !node.name) continue;
    const name = node.name.toLowerCase();
    const attributes = Object.entries(node.attribs ?? {})
      .map(([key, value]) => ` ${key.toLowerCase()}="${escapeXml(value)}"`)
      .join('');
    out += VOID_TAGS.has(name) ? `<${name}${attributes}/>` : `<${name}${attributes}>${serializeNodes(node.children ?? [])}</${name}>`;
  }
  return out;
}

/** Only links that leave the book are kept: relative links point at pages the EPUB does not contain, and other schemes can run code. */
function externalHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Sources report either a code ("en", "pt-BR") or an English language name; anything else falls back to English. */
function epubLanguage(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(text)) return text;
  return LANGUAGE_CODES[text.toLowerCase()] ?? 'en';
}

function chapterXhtml(title: string, body: string, language: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}"><head><title>${escapeXml(title)}</title></head><body><h1>${escapeXml(title)}</h1>${body}</body></html>`;
}

function navXhtml(chapters: EpubChapterInput[], files: string[], language: string): string {
  const items = chapters.map((chapter, index) => `<li><a href="chapters/${files[index]}">${escapeXml(chapter.title)}</a></li>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${items}</ol></nav></body></html>`;
}

function tocNcx(identifier: string, title: string, chapters: EpubChapterInput[], files: string[]): string {
  const points = chapters
    .map(
      (chapter, index) =>
        `<navPoint id="nav-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel><content src="chapters/${files[index]}"/></navPoint>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${identifier}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${points}</navMap></ncx>`;
}

function coverXhtml(href: string, language: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}"><head><title>Cover</title></head><body><section epub:type="cover"><img src="${escapeXml(href)}" alt="Cover"/></section></body></html>`;
}

function opf(
  input: WebSerialEpubInput,
  identifier: string,
  language: string,
  chapterFiles: string[],
  images: Map<string, ImageEntry>,
  cover: ImageEntry | null,
): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const creators = input.authors.map((author) => `<dc:creator>${escapeXml(author)}</dc:creator>`).join('');
  const chapterItems = chapterFiles
    .map((file, index) => `<item id="chapter-${index + 1}" href="chapters/${file}" media-type="application/xhtml+xml"/>`)
    .join('');
  const imageItems = [...images.values()]
    .map((image, index) => `<item id="image-${index + 1}" href="${image.href}" media-type="${image.mediaType}"/>`)
    .join('');
  const coverItems = cover
    ? `<item id="cover-image" href="${cover.href}" media-type="${cover.mediaType}" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`
    : '';
  const spine = `${cover ? '<itemref idref="cover-page" linear="no"/>' : ''}${chapterFiles.map((_file, index) => `<itemref idref="chapter-${index + 1}"/>`).join('')}`;
  return `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="book-id"><metadata><dc:identifier id="book-id">urn:uuid:${identifier}</dc:identifier><dc:title>${escapeXml(input.volumeLabel)}</dc:title>${creators}<dc:language>${escapeXml(language)}</dc:language><meta property="dcterms:modified">${modified}</meta><meta name="calibre:series" content="${escapeXml(input.seriesTitle)}"/><meta name="calibre:series_index" content="${escapeXml(input.volumeIndex)}"/><meta property="belongs-to-collection" id="series-id">${escapeXml(input.seriesTitle)}</meta><meta refines="#series-id" property="collection-type">series</meta><meta refines="#series-id" property="group-position">${escapeXml(input.volumeIndex)}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${coverItems}${chapterItems}${imageItems}</manifest><spine toc="ncx">${spine}</spine></package>`;
}
