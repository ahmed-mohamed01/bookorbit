import * as unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import { load, type CheerioAPI } from 'cheerio';
import { posix } from 'node:path';
import { Logger } from '@nestjs/common';
import type { Structure, TextStage } from './model';
import { createWinkNlp } from './wink';

const array = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const logger = new Logger('BookKnowledgeEpubText');
class SkippedResource extends Error {}

const ROLES: readonly [Exclude<Structure, 'body'>, RegExp][] = [
  ['contents', /\b(toc|contents|table of contents|navigation|nav|landmarks)\b/],
  ['notes', /\b(endnotes?|footnotes?|rearnotes?|notes)\b/],
  ['bibliography', /\b(bibliography|references|works cited)\b/],
  ['index', /\bindex\b/],
  ['front', /\b(cover|copyright|copyright page|titlepage|title page|halftitlepage|dedication|acknowledg\w*|foreword|preface|frontmatter)\b/],
  ['other', /\b(colophon|about the author|backmatter|advertisement)\b/],
];
const foldLabel = (value: string) => value.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
const roleOf = (value: string): Structure | undefined => ROLES.find(([, pattern]) => pattern.test(foldLabel(value)))?.[0];
const WHOLE_LABELS = ROLES.map(([role, pattern]) => [role, new RegExp(`^(?:the )?(?:${pattern.source})$`)] as const);
/** "Notes" or "Copyright" as the whole label, not "Field Notes" or "Taking Cover". */
const labelRole = (label: string): Structure | undefined => WHOLE_LABELS.find(([, pattern]) => pattern.test(foldLabel(label)))?.[0];

export interface DocumentSignals {
  filename: string;
  /** Every TOC label that points into the document. */
  titles: readonly string[];
  heading: string;
  /** epub:type of the body and the item's manifest properties. */
  structural: string;
}

/**
 * The document's role. epub:type and manifest properties are the book's own statement; a filename names a file's role;
 * a TOC label or heading only counts when it is that word alone ("Notes", not "Field Notes"), and a file with several TOC
 * labels needs them all to agree, so a chapter called "Taking Cover" or a file holding "Copyright" and "Chapter One" stays body.
 */
export function classifyDocument(signals: DocumentSignals, text: string, linkRatio = 0): Structure {
  const structural = signals.structural.toLowerCase();
  if (/\b(bodymatter|chapter|part)\b/.test(structural) && !/\b(toc|nav|landmarks)\b/.test(structural)) return text.trim() ? 'body' : 'other';
  const declared = roleOf(signals.structural) ?? roleOf(signals.filename);
  if (declared === 'contents' || linkRatio > 0.65) return 'contents';
  if (declared) return declared;
  const roles = signals.titles.length > 1 ? signals.titles.map(labelRole) : [labelRole(signals.titles[0] ?? '') ?? labelRole(signals.heading)];
  if (roles[0] && roles.every((role) => role === roles[0])) return roles[0];
  if (!text.trim()) return 'other';
  return 'body';
}

const INSET_RUN = 3;
type Block = Exclude<Parameters<typeof load>[0], string | Buffer | readonly unknown[]>;

const BLOCK_TAGS = new Set(
  'address article aside blockquote body caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(
    ' ',
  ),
);
/** Stands for a line break inside a block while whitespace is folded; `\s` does not match it. */
const BREAK = '\uE000';

/** A block's own run of inline content: a paragraph, or text set loose in a div beside other blocks. */
interface TextUnit {
  owner: Block;
  parts: Block[];
}

/** Every run of inline content in reading order, each under the nearest block that holds it, so no text is left out. */
function textUnits(root: Block | undefined): TextUnit[] {
  const units: TextUnit[] = [];
  if (!root) return units;
  const holdsBlock = new Map<Block, boolean>();
  const isBlock = (node: Block): boolean => {
    if (!('name' in node) || !('children' in node)) return false;
    if (BLOCK_TAGS.has(node.name)) return true;
    let known = holdsBlock.get(node);
    if (known === undefined) {
      known = (node.children as Block[]).some(isBlock);
      holdsBlock.set(node, known);
    }
    return known;
  };
  const visit = (owner: Block) => {
    let run: Block[] = [];
    const flush = () => {
      if (run.length) units.push({ owner, parts: run });
      run = [];
    };
    for (const child of 'children' in owner ? (owner.children as Block[]) : []) {
      if (isBlock(child)) {
        flush();
        visit(child);
      } else run.push(child);
    }
    flush();
  };
  visit(root);
  return units;
}

const foldText = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replace(new RegExp(` ?${BREAK}[${BREAK} ]*`, 'g'), BREAK)
    .replace(new RegExp(`^[ ${BREAK}]+`), '');

/** A unit's text, whitespace folded and line breaks kept as `BREAK`, with its emphasised spans placed in that text. */
function unitText({ owner, parts }: TextUnit): { text: string; emphasis: { start: number; end: number; text: string }[] } {
  const emphasis: { start: number; end: number; text: string }[] = [];
  const pre = 'name' in owner && owner.name === 'pre';
  let raw = '';
  const walk = (element: Block) => {
    const start = raw.length;
    if ('data' in element && typeof element.data === 'string' && String(element.type) === 'text')
      raw += pre ? element.data.replace(/\r?\n/g, BREAK) : element.data;
    else if ('name' in element && element.name === 'br') raw += BREAK;
    else if ('children' in element) (element.children as Block[]).forEach(walk);
    if ('name' in element && /^(em|strong|i|b)$/.test(element.name)) {
      emphasis.push({
        start: foldText(raw.slice(0, start)).length,
        end: foldText(raw).length,
        text: raw
          .slice(start)
          .replace(new RegExp(`[\\s${BREAK}]+`, 'g'), ' ')
          .trim(),
      });
    }
  };
  parts.forEach(walk);
  return { text: foldText(raw).replace(new RegExp(`[ ${BREAK}]+$`), ''), emphasis };
}

/**
 * Blocks set off from the narration: inside a blockquote, or in a run of `INSET_RUN` or more paragraphs whose class
 * differs from the document's most common paragraph class, as a reproduced letter or log is styled.
 */
function insetBlocks(nodes: readonly Block[], $: CheerioAPI): Set<Block> {
  const classOf = (node: Block) => ($(node).attr('class') ?? '').split(/\s+/).filter(Boolean).sort().join(' ');
  const isParagraph = (node: Block) => 'name' in node && node.name === 'p';
  const counts = new Map<string, number>();
  for (const node of nodes) if (isParagraph(node)) counts.set(classOf(node), (counts.get(classOf(node)) ?? 0) + 1);
  let common: string | null = null;
  for (const [name, count] of counts) if (common === null || count > counts.get(common)!) common = name;
  const inset = new Set<Block>(nodes.filter((node) => $(node).closest('blockquote').length > 0));
  let run: Block[] = [];
  const close = () => {
    if (run.length >= INSET_RUN) for (const node of run) inset.add(node);
    run = [];
  };
  for (const node of nodes) {
    if (isParagraph(node) && classOf(node) !== common) run.push(node);
    else close();
  }
  close();
  return inset;
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
    const signals: DocumentSignals = {
      filename: /^index(?:[_-]split[_-]?\d+)?$/i.test(filename) ? '' : filename,
      titles: titles.get(href) ?? [],
      heading: headingText,
      structural: `${body.attr('epub:type') ?? ''} ${item['@_properties'] ?? ''}`,
    };
    const linkLength = $('body a[href]')
      .toArray()
      .reduce((sum, node) => sum + ($(node).text().length <= 160 ? $(node).text().length : 0), 0);
    const structure = classifyDocument(signals, fullText, linkLength / Math.max(fullText.length, 1));
    if (structure === 'contents') result.seeds.push(fullText);
    const units = textUnits(body.toArray()[0]);
    if (structure === 'index') result.seeds.push(units.map((unit) => unitText(unit).text.replace(new RegExp(BREAK, 'g'), ' ')).join('\n'));
    const inset = insetBlocks([...new Set(units.map(({ owner }) => owner))], $);
    for (const unit of units) {
      const { owner } = unit;
      const { text, emphasis } = unitText(unit);
      if (!text) continue;
      const heading = /^h[1-6]$/.test('name' in owner ? owner.name : '');
      const caption = $(owner).closest('figcaption,caption').length > 0;
      let lineStart = 0;
      // A <br> or a line of <pre> ends a sentence: status screens put one stat on each line.
      for (const line of text.split(BREAK)) {
        let cursor = 0;
        for (const sentence of nlp.readDoc(line).sentences().out() as string[]) {
          const start = lineStart + line.indexOf(sentence, cursor);
          const end = start + sentence.length;
          cursor = end - lineStart;
          result.sentences.push({
            ordinal: result.sentences.length + 1,
            spineIndex,
            paragraphIndex,
            href,
            text: sentence,
            structure,
            heading,
            caption,
            ...(inset.has(owner) ? { inset: true } : {}),
            emphasis: emphasis.filter((span) => span.start >= start && span.end <= end).map((span) => span.text),
          });
        }
        lineStart += line.length + 1;
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
