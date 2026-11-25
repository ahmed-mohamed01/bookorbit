import * as unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import { posix } from 'node:path';
import { Logger } from '@nestjs/common';
import type { Structure, TextStage } from './model';
import { createWinkNlp } from './wink';

const array = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const logger = new Logger('BookKnowledgeEpubText');
class SkippedResource extends Error {}

export function classifyDocument(signals: string, text: string, linkRatio = 0): Structure {
  const value = signals.toLowerCase().replace(/[_-]/g, ' ');
  if (/\b(toc|contents|navigation|nav)\b/.test(value) || linkRatio > 0.65) return 'contents';
  if (/\b(endnotes?|footnotes?|notes)\b/.test(value)) return 'notes';
  if (/\b(bibliography|references|works cited)\b/.test(value)) return 'bibliography';
  if (/\bindex\b/.test(value)) return 'index';
  if (/\b(cover|copyright|titlepage|title page|dedication|acknowledg\w*|foreword|preface|frontmatter)\b/.test(value)) return 'front';
  if (/\b(colophon|about the author|backmatter|advertisement)\b/.test(value)) return 'other';
  if (!text.trim()) return 'other';
  return 'body';
}

export async function extractEpubText(source: string | Buffer): Promise<TextStage> {
  const started = Date.now();
  let skipped = 0;
  const zip = typeof source === 'string' ? await unzipper.Open.file(source) : await unzipper.Open.buffer(source);
  const nlp = createWinkNlp(['sbd']);
  const entries = new Map(zip.files.map((file) => [file.path, file]));
  const read = async (path: string): Promise<string> => {
    const entry = entries.get(path);
    if (!entry) throw new Error('EPUB resource missing');
    if (entry.uncompressedSize > 32 * 1024 * 1024) throw new Error('EPUB resource exceeds text limit');
    return (await entry.buffer()).toString('utf8');
  };
  const container = parser.parse(await read('META-INF/container.xml'));
  const opfPath = array<any>(container.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  if (typeof opfPath !== 'string') throw new Error('EPUB has no package');
  const pkg = parser.parse(await read(opfPath)).package;
  const manifest = new Map<string, any>(array<any>(pkg.manifest?.item).map((item) => [item['@_id'], item]));
  const resolve = (base: string, href: string): string => {
    try {
      return posix.normalize(posix.join(posix.dirname(base), decodeURIComponent(href.split('#')[0])));
    } catch (error) {
      if (error instanceof URIError) throw new SkippedResource();
      throw error;
    }
  };
  const readOptional = async (path: string): Promise<string | undefined> => (entries.has(path) ? read(path) : undefined);
  const skip = (error: unknown): void => {
    if (!(error instanceof SkippedResource)) throw error;
    skipped++;
  };
  const titles = new Map<string, string[]>();
  for (const item of manifest.values()) {
    const nav = String(item['@_properties'] ?? '')
      .split(/\s+/)
      .includes('nav');
    if (!nav && item['@_media-type'] !== 'application/x-dtbncx+xml') continue;
    let path: string;
    try {
      path = resolve(opfPath, String(item['@_href']));
    } catch (error) {
      skip(error);
      continue;
    }
    const document = await readOptional(path);
    if (document === undefined) {
      skipped++;
      continue;
    }
    const $ = load(document, { xml: true });
    const addTitle = (href: string, title: string) => {
      try {
        const target = resolve(path, href);
        titles.set(target, [...(titles.get(target) ?? []), title]);
      } catch (error) {
        skip(error);
      }
    };
    if (nav) $('a[href]').each((_, node) => addTitle($(node).attr('href')!, $(node).text()));
    else
      $('navPoint').each((_, node) => {
        const src = $(node).children('content').attr('src');
        if (src) addTitle(src, $(node).children('navLabel').text());
      });
  }
  const spine = array<any>(pkg.spine?.itemref);
  const result: TextStage = { sentences: [], seeds: [], spineBytes: spine.map(() => 0) };
  let paragraphIndex = 0;
  for (let spineIndex = 0; spineIndex < spine.length; spineIndex++) {
    const item = manifest.get(spine[spineIndex]['@_idref']);
    if (!item) {
      skipped++;
      continue;
    }
    let href: string;
    try {
      href = resolve(opfPath, String(item['@_href']));
    } catch (error) {
      skip(error);
      continue;
    }
    const entry = entries.get(href);
    if (!entry) {
      skipped++;
      continue;
    }
    if (spine[spineIndex]['@_linear'] !== 'no') result.spineBytes![spineIndex] = entry.uncompressedSize;
    if (!/xhtml|html/.test(item['@_media-type'])) continue;
    const $ = load(await read(href));
    $('script, style, sup:has(a), [epub\\:type="noteref"]').remove();
    const body = $('body');
    const fullText = body.text().replace(/\s+/g, ' ').trim();
    const headingText = $('h1,h2').first().text();
    // Conversion tools use index_split_N for ordinary body chapters.
    const filename = posix.basename(href).replace(/\.[^.]+$/, '');
    const signals = [
      /^index(?:[_-]split[_-]?\d+)?$/i.test(filename) ? '' : filename,
      ...(titles.get(href) ?? []),
      headingText,
      body.attr('epub:type') ?? '',
      item['@_properties'] ?? '',
    ].join(' ');
    const linkLength = $('body a[href]')
      .toArray()
      .reduce((sum, node) => sum + ($(node).text().length <= 160 ? $(node).text().length : 0), 0);
    const structure = classifyDocument(signals, fullText, linkLength / Math.max(fullText.length, 1));
    if (structure === 'contents') result.seeds.push(fullText);
    let blocks = $(
      'body p, body h1, body h2, body h3, body h4, body h5, body h6, body li, body blockquote, body dt, body dd, body figcaption, body caption',
    );
    blocks = blocks.filter((_, node) => $(node).find('p,h1,h2,h3,h4,h5,h6,li,blockquote,dt,dd,figcaption,caption').length === 0);
    const nodes = blocks.length ? blocks.toArray() : body.toArray();
    if (structure === 'index') result.seeds.push(nodes.map((node) => $(node).text().replace(/\s+/g, ' ').trim()).join('\n'));
    for (const node of nodes) {
      const text = $(node).text().replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const emphasis: { start: number; end: number; text: string }[] = [];
      let raw = '';
      const walk = (element: (typeof node)['children'][number]) => {
        const start = raw.length;
        if ('data' in element && typeof element.data === 'string' && String(element.type) === 'text') raw += element.data;
        else if ('children' in element) element.children.forEach(walk);
        if ('name' in element && /^(em|strong|i|b)$/.test(element.name)) {
          const normalize = (value: string) => value.replace(/\s+/g, ' ').trimStart();
          emphasis.push({
            start: normalize(raw.slice(0, start)).length,
            end: normalize(raw).length,
            text: raw.slice(start).replace(/\s+/g, ' ').trim(),
          });
        }
      };
      walk(node);
      let cursor = 0;
      for (const sentence of nlp.readDoc(text).sentences().out() as string[]) {
        const start = text.indexOf(sentence, cursor);
        const end = start + sentence.length;
        cursor = end;
        result.sentences.push({
          ordinal: result.sentences.length + 1,
          spineIndex,
          paragraphIndex,
          href,
          text: sentence,
          structure,
          heading: /^h[1-6]$/.test('name' in node ? node.name : ''),
          caption: $(node).closest('figcaption,caption').length > 0,
          emphasis: emphasis.filter((span) => span.start >= start && span.end <= end).map((span) => span.text),
        });
      }
      paragraphIndex++;
    }
  }
  if (skipped)
    logger.warn(
      `[book_knowledge.epub_text] [end] durationMs=${Date.now() - started} skipped=${skipped} sentences=${result.sentences.length} - skipped missing or unreadable EPUB resources`,
    );
  return result;
}
