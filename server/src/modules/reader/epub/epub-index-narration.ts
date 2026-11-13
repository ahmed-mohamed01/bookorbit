/**
 * Fork: read along for a plain EPUB from the book's edition sync timing index.
 *
 * The timing index (`<book>.bookorbit-timings`) is the aligned read-aloud EPUB without its audio:
 * the plain EPUB's chapters with a `<span id>` around every sentence, SMIL that times each one,
 * and `bookorbit-timings/provenance.json`, which says which audiobook file and stretch each of
 * the worker's audio pieces was cut from. So every sentence lands at an exact second of the
 * audiobook, and the playlist built here plays the audiobook's own files.
 *
 * The reader keeps the plain EPUB, which has no sentence ids, so each sentence also gets its
 * place in its chapter, counted in characters that are not whitespace; the reader marks it there
 * (client `index-narration.ts`).
 */
import { copyFile, mkdtemp, open, rm, stat, type FileHandle } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { Readable } from 'stream';
import * as unzipper from 'unzipper';
import { load } from 'cheerio';

import {
  EDITION_SYNC_PROVENANCE_ENTRY,
  type EditionSyncProvenance,
  type EpubBookInfo,
  type EpubMediaOverlayPlaylist,
  type EpubMediaOverlayPlaylistItem,
  type EpubMediaOverlayPlaylistSection,
  type EpubMediaOverlayTextPositions,
} from '@bookorbit/types';
import { buildEpubMediaOverlayPlaylistFromFile, findEpubZipEntry } from './epub-media-overlay';

const MAX_PROVENANCE_BYTES = 16 * 1024 * 1024;

/** Where the playlist's audiobook files are served from, under the media-overlay file route. */
export const INDEX_AUDIO_PREFIX = 'bookorbit-audio/';

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

export interface IndexNarrationAudioFile {
  id: number;
  absolutePath: string;
}

/** The href an audiobook file is served under in an index playlist. */
export function indexAudioHref(file: { id: number; absolutePath: string }): string {
  return `${INDEX_AUDIO_PREFIX}${file.id}${extname(file.absolutePath).toLowerCase()}`;
}

export function indexAudioMimeType(path: string): string {
  return AUDIO_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** The audiobook file an index playlist href names, or null when it names none. */
export function indexAudioFileId(href: string): number | null {
  if (!href.startsWith(INDEX_AUDIO_PREFIX)) return null;
  const id = Number.parseInt(href.slice(INDEX_AUDIO_PREFIX.length), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const WHITESPACE = /\s+/g;

/** The parts of a parsed node the count reads. */
interface DomNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

const localName = (node: DomNode) => (node.name ?? '').toLowerCase().replace(/^.*:/, '');
const UNCOUNTED = new Set(['script', 'style', 'svg', 'math']);

const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;
const namedEntities = new Map<string, string>();

/** A named entity as the browser's HTML table decodes it (XHTML readers map the same names). */
function decodeNamedEntity(reference: string): string {
  let value = namedEntities.get(reference);
  if (value === undefined) {
    value = load(reference, { xml: { xmlMode: false, decodeEntities: true } }, false).text();
    namedEntities.set(reference, value);
  }
  return value;
}

/**
 * Text as the browser's XHTML parser decodes it: a numeric reference is its code point as written
 * (XML, so `&#128;` stays U+0080, where HTML would remap it to U+20AC), a named entity is looked up.
 */
function decodeXhtmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(REFERENCE, (reference: string, dec?: string, hex?: string) => {
    if (dec === undefined && hex === undefined) return decodeNamedEntity(reference);
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : reference;
  });
}

/**
 * Where the elements named in `ids` sit in a chapter's body text: the character data of every
 * text and CDATA node under `<body>` in order, nothing inside `<script>`, `<style>`, `<svg>` or
 * `<math>`, entities decoded as the browser's XHTML parser decodes them, JS `\s` not counted, and the counted
 * UTF-16 code units hashed (h = h * 31 + c, 32-bit). The reader counts the plain chapter the same
 * way. A sentence with nothing counted can never be marked, so it is left out. Null when the
 * chapter has no body.
 */
export function sentencePositions(chapter: string, ids: ReadonlySet<string>): EpubMediaOverlayTextPositions | null {
  const $ = load(chapter, { xml: { decodeEntities: false } });
  const found = new Map<string, [number, number]>();
  const seen = new Set<string>();
  let at = 0;
  let hash = 0;
  const count = (value: string) => {
    const counted = value.replace(WHITESPACE, '');
    for (let i = 0; i < counted.length; i++) hash = (Math.imul(hash, 31) + counted.charCodeAt(i)) >>> 0;
    at += counted.length;
  };
  const walk = (node: DomNode, inCdata = false): void => {
    if (node.type === 'text') return count(inCdata ? (node.data ?? '') : decodeXhtmlText(node.data ?? ''));
    if (node.type === 'cdata') return node.children?.forEach((child) => walk(child, true));
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return;
    if (UNCOUNTED.has(localName(node))) return;
    const id = node.attribs?.['id'];
    if (id === undefined || !ids.has(id) || seen.has(id)) return node.children?.forEach((child) => walk(child));
    seen.add(id);
    const start = at;
    node.children?.forEach((child) => walk(child));
    if (at > start) found.set(id, [start, at]);
  };
  const body = ($('*').toArray() as unknown as DomNode[]).find((el) => el.type === 'tag' && localName(el) === 'body');
  if (!body) return null;
  body.children?.forEach((child) => walk(child));
  // Document order: sentences do not nest, so by start, then by end.
  const order = [...found.entries()].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]);
  return {
    length: at,
    hash: hash | 0,
    ids: order.map(([id]) => id),
    starts: order.map(([, [start]]) => start),
    ends: order.map(([, [, end]]) => end),
  };
}

/**
 * The indices of the longest run of `keys` that never goes back, in order. Storyteller can time
 * the title page in the closing credits, and following the audio must never jump back to it.
 */
export function longestForwardRun(keys: readonly number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]!]! <= keys[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const run: number[] = [];
  for (let i = tails.length ? tails.at(-1)! : -1; i >= 0; i = prev[i]!) run.push(i);
  return run.reverse();
}

async function readProvenance(zip: unzipper.CentralDirectory): Promise<EditionSyncProvenance | null> {
  const entry = zip.files.find((file) => file.path === EDITION_SYNC_PROVENANCE_ENTRY);
  if (!entry || entry.uncompressedSize > MAX_PROVENANCE_BYTES) return null;
  try {
    const value = JSON.parse((await entry.buffer()).toString('utf8')) as EditionSyncProvenance;
    return value?.version === 1 && Array.isArray(value.audio) && Array.isArray(value.sources) && Array.isArray(value.audioEntries) ? value : null;
  } catch {
    return null;
  }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A zip source over one open file. unzipper's own file source reopens the path for every read, and
 * an index removed between two reads throws from a stream nothing listens to, which takes the
 * process down. One handle keeps reading the file it opened, and a failed read ends the stream
 * quietly (unzipper then rejects on the short read) instead of emitting an error.
 */
function handleSource(handle: FileHandle, size: number) {
  return {
    size: () => Promise.resolve(size),
    stream: (offset: number, length?: number) => {
      const end = length ? Math.min(size, offset + length) : size;
      let at = offset;
      return new Readable({
        read() {
          if (at >= end) return void this.push(null);
          const want = Math.min(READ_CHUNK_BYTES, end - at);
          handle.read(Buffer.alloc(want), 0, want, at).then(
            ({ bytesRead, buffer }) => {
              if (bytesRead === 0) return void this.push(null);
              at += bytesRead;
              this.push(buffer.subarray(0, bytesRead));
            },
            () => this.push(null),
          );
        },
      });
    },
  };
}

/**
 * The index's provenance alone, without reading its chapters or SMIL: the zip's central directory
 * and the one entry, from a single open handle, so deleting the index meanwhile changes nothing.
 */
export async function readIndexProvenance(indexPath: string): Promise<EditionSyncProvenance | null> {
  const handle = await open(indexPath, 'r');
  try {
    const { size } = await handle.stat();
    return await readProvenance(await unzipper.Open.custom(handleSource(handle, size)));
  } finally {
    await handle.close();
  }
}

/** The worker's input order a provenance source was cut from: `0001.m4b` is 0. */
function sourceOrder(source: { source: unknown }): number {
  return Number.parseInt(String(source.source).split('.')[0] ?? '', 10) - 1;
}

/** The audiobook files the index's sources were cut from, by book file id. */
export function provenanceSourceAudioFileIds(provenance: EditionSyncProvenance): Set<number> {
  const audioByOrder = new Map(provenance.audio.map((file) => [file.order, file.bookFileId]));
  const ids = new Set<number>();
  for (const source of provenance.sources) {
    const id = audioByOrder.get(sourceOrder(source));
    if (id !== undefined && Number.isFinite(source.start)) ids.add(id);
  }
  return ids;
}

/** Runs `use` on a private copy of the index, for the same reason, since edition sync replaces and clears indexes. */
async function withPrivateCopy<T>(indexPath: string, use: (copy: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bookorbit-index-'));
  try {
    const copy = join(dir, 'index.zip');
    await copyFile(indexPath, copy);
    return await use(copy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface IndexNarration {
  playlist: EpubMediaOverlayPlaylist;
  /** The audiobook files the playlist plays. */
  audioFiles: IndexNarrationAudioFile[];
}

interface IndexPiece {
  file: IndexNarrationAudioFile;
  /** The file's place in the worker's input, the order the index was aligned in. */
  order: number;
  start: number;
}

/**
 * The index's narration as a playlist for the plain EPUB `plainInfo` (file `fileId`), playing the
 * book's audiobook files `audioFiles` in the order the index was aligned in. Null when the index
 * was made from another EPUB, names an audiobook file the book no longer has, or has no sentence
 * left to read. Only the files the playlist plays are read from disk.
 */
export async function buildIndexNarration(params: {
  indexPath: string;
  plainInfo: EpubBookInfo;
  bookId: number;
  fileId: number;
  audioFiles: readonly IndexNarrationAudioFile[];
}): Promise<IndexNarration | null> {
  return withPrivateCopy(params.indexPath, (indexPath) => buildFromIndex({ ...params, indexPath }));
}

async function buildFromIndex(params: Parameters<typeof buildIndexNarration>[0]): Promise<IndexNarration | null> {
  const { indexPath, plainInfo, bookId, fileId, audioFiles } = params;
  const zip = await unzipper.Open.file(indexPath);
  const provenance = await readProvenance(zip);
  if (!provenance || provenance.epub?.bookFileId !== fileId) return null;

  // The worker copies its inputs in as `0001.m4b`, `0002.mp3`, ... by order.
  const audioByOrder = new Map(provenance.audio.map((file) => [file.order, file.bookFileId]));
  const filesById = new Map(audioFiles.map((file) => [file.id, file]));
  const pieceBySource = new Map<string, IndexPiece>();
  for (const source of provenance.sources) {
    const order = sourceOrder(source);
    const file = filesById.get(audioByOrder.get(order) ?? -1);
    if (!file || !Number.isFinite(source.start)) continue;
    pieceBySource.set(source.name, { file, order, start: source.start });
  }
  const pieceByHref = new Map<string, IndexPiece>();
  for (const entry of provenance.audioEntries) {
    const piece = pieceBySource.get(entry.chunk);
    if (piece) pieceByHref.set(entry.href, piece);
  }
  if (pieceByHref.size === 0) return null;

  const indexed = await buildEpubMediaOverlayPlaylistFromFile(indexPath, bookId, fileId);
  const spineIndexByHref = new Map(plainInfo.spine.map((item, index) => [item.href, index]));

  // Sentence places, from the index's own copy of each chapter.
  const wanted = new Map<string, Set<string>>();
  for (const item of indexed.items) {
    if (item.textFragment) (wanted.get(item.textHref) ?? wanted.set(item.textHref, new Set()).get(item.textHref)!).add(item.textFragment);
  }
  const textPositions: Record<string, EpubMediaOverlayTextPositions> = {};
  for (const [href, ids] of wanted) {
    if (!spineIndexByHref.has(href)) continue;
    const entry = findEpubZipEntry(zip.files, href);
    if (!entry) continue;
    const positions = sentencePositions((await entry.buffer()).toString('utf8'), ids);
    if (positions && positions.ids.length > 0) textPositions[href] = positions;
  }
  const placed = new Map(Object.entries(textPositions).map(([href, p]) => [href, new Set(p.ids)]));

  const candidates: EpubMediaOverlayPlaylistItem[] = [];
  const keys: number[] = [];
  for (const item of indexed.items) {
    const piece = pieceByHref.get(item.audioHref);
    const sectionIndex = spineIndexByHref.get(item.textHref);
    if (!piece || sectionIndex === undefined || !item.textFragment || !placed.get(item.textHref)?.has(item.textFragment)) continue;
    const begin = piece.start + item.clipBeginSeconds;
    candidates.push({
      ...item,
      sectionIndex,
      audioHref: indexAudioHref(piece.file),
      audioMimeType: indexAudioMimeType(piece.file.absolutePath),
      clipBeginSeconds: begin,
      clipEndSeconds: item.clipEndSeconds == null ? null : piece.start + item.clipEndSeconds,
    });
    // Ordered by file, then by time in it, so no audiobook duration is needed.
    keys.push(piece.order * 1e7 + begin);
  }

  const items: EpubMediaOverlayPlaylistItem[] = [];
  for (const i of longestForwardRun(keys)) items.push({ ...candidates[i]!, index: items.length });
  if (items.length === 0) return null;

  // The narration clock runs through the clips in reading order, as for a read-along EPUB.
  const sections: EpubMediaOverlayPlaylistSection[] = [];
  let clock = 0;
  let unknown = false;
  for (const item of items) {
    let section = sections.at(-1);
    if (!section || section.index !== item.sectionIndex) {
      const spineItem = plainInfo.spine[item.sectionIndex]!;
      section = {
        index: item.sectionIndex,
        href: spineItem.href,
        label: item.label,
        smilHref: item.smilHref,
        startSeconds: clock,
        durationSeconds: 0,
      };
      sections.push(section);
    }
    const length = item.clipEndSeconds == null ? null : Math.max(0, item.clipEndSeconds - item.clipBeginSeconds);
    if (length == null) {
      unknown = true;
      section.durationSeconds = null;
    } else {
      clock += length;
      if (section.durationSeconds != null) section.durationSeconds += length;
    }
  }

  const playedHrefs = new Set(items.map((item) => item.audioHref));
  const playedByOrder = new Map<number, IndexNarrationAudioFile>();
  for (const piece of pieceByHref.values()) if (playedHrefs.has(indexAudioHref(piece.file))) playedByOrder.set(piece.order, piece.file);
  const played = [...playedByOrder.entries()].sort(([a], [b]) => a - b).map(([, file]) => file);
  const resources = await Promise.all(
    played.map(async (file) => ({
      href: indexAudioHref(file),
      mediaType: indexAudioMimeType(file.absolutePath),
      size: (await stat(file.absolutePath)).size,
    })),
  );

  const usedTexts = new Set(items.map((item) => item.textHref));
  for (const href of Object.keys(textPositions)) if (!usedTexts.has(href)) delete textPositions[href];

  return {
    playlist: {
      bookId,
      fileId,
      durationSeconds: unknown ? null : clock,
      items,
      sections,
      resources,
      source: 'timing-index',
      textPositions,
    },
    audioFiles: played,
  };
}
