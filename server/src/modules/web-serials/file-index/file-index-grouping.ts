import { normalizeSerialTitle } from '@bookorbit/types';

import type { ListingFile } from './file-index-listing';

const TITLE_KEY_MAX = 1000;
const TITLE_MAX = 1000;
/** Book formats counted as skipped rather than ignored, so the admin preview shows what a listing holds but BookOrbit cannot file. */
const OTHER_BOOK_EXTENSIONS = new Set(['pdf', 'mobi', 'azw', 'azw3', 'kfx', 'cbz', 'cbr', 'docx', 'txt', 'fb2', 'djvu']);
const SUB_PART_FOLDER = /^(?:part|arc|season|book|story)\s*\d+(?:\.\d+)?\b/i;
const VOLUME_MARKER = /(?:^|[^a-z])(?:volume|vol\.?|v)\s*[-_.]?\s*0*(\d{1,4}(?:\.\d+)?)(?![\d])/i;
const PART_MARKER = /(?:^|[^a-z])part\s*[-_.]?\s*0*(\d{1,3}(?:\.\d+)?)(?![\d])/i;
const TRAILING_NUMBER = /(?:^|[\s_-])0*(\d{1,3}(?:\.\d+)?)$/;
const BRACKET_GROUPS = /\s*[[({][^\])}]*[\])}]/g;
const COVER_FILE = /^(?:cover|folder|poster)\.(?:jpe?g|png|webp)$/i;

export interface GroupedFile extends ListingFile {
  volume: number | null;
}

export interface GroupedSeries {
  folderPath: string;
  title: string;
  titleKey: string;
  coverPath: string | null;
  files: GroupedFile[];
}

export interface GroupedListing {
  series: GroupedSeries[];
  /** Book files in a format BookOrbit does not file from an index. */
  skippedFiles: number;
  fileCount: number;
}

/**
 * A folder that holds EPUBs directly is one series. When a folder holds the same volume more than once, the larger copy
 * is kept: two releases of one volume usually differ by their illustrations. Files at the listing root have no series.
 */
export function groupListing(files: readonly ListingFile[]): GroupedListing {
  const folders = new Map<string, Map<string, GroupedFile>>();
  const covers = new Map<string, string>();
  let skippedFiles = 0;

  for (const file of files) {
    if (COVER_FILE.test(file.name)) {
      const folder = file.path.slice(0, Math.max(file.path.lastIndexOf('/'), 0));
      if (folder && !covers.has(folder)) covers.set(folder, file.path);
      continue;
    }
    const extension = extensionOf(file.name);
    if (extension !== 'epub') {
      if (OTHER_BOOK_EXTENSIONS.has(extension)) skippedFiles += 1;
      continue;
    }
    const slash = file.path.lastIndexOf('/');
    if (slash <= 0) continue;
    const folderPath = file.path.slice(0, slash);
    const volume = parseVolumeNumber(file.name);
    const slot = volume === null ? `name:${file.path}` : `vol:${parsePartNumber(file.name) ?? 0}:${volume}`;
    let entries = folders.get(folderPath);
    if (!entries) folders.set(folderPath, (entries = new Map()));
    const existing = entries.get(slot);
    if (!existing || (file.size ?? 0) > (existing.size ?? 0)) entries.set(slot, { ...file, volume });
  }

  const series: GroupedSeries[] = [];
  let fileCount = 0;
  for (const [folderPath, entries] of folders) {
    const title = seriesTitle(folderPath);
    const titleKey = normalizeSerialTitle(title).slice(0, TITLE_KEY_MAX);
    if (!titleKey) continue;
    const grouped = [...entries.values()].sort(compareFiles);
    fileCount += grouped.length;
    series.push({ folderPath, title, titleKey, coverPath: covers.get(folderPath) ?? null, files: grouped });
  }
  series.sort((left, right) => left.folderPath.localeCompare(right.folderPath));
  return { series, skippedFiles, fileCount };
}

/** The volume a file name states (`Volume 01`, `Vol. 3`, `v03`), else a short trailing number; null when it states none. */
export function parseVolumeNumber(fileName: string): number | null {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const marked = VOLUME_MARKER.exec(stem);
  if (marked) return Number(marked[1]);
  const trailing = TRAILING_NUMBER.exec(stem.replace(BRACKET_GROUPS, '').trim());
  return trailing ? Number(trailing[1]) : null;
}

/** The part a file name states (`Part 2 Volume 1`); parts restart their volume numbers, so both decide a file's place. */
export function parsePartNumber(fileName: string): number | null {
  const marked = PART_MARKER.exec(fileName.replace(/\.[^.]+$/, ''));
  return marked ? Number(marked[1]) : null;
}

/** Orders files by part, then volume, then name; files without a volume go last. */
export function compareFiles(left: Pick<GroupedFile, 'name' | 'volume'>, right: Pick<GroupedFile, 'name' | 'volume'>): number {
  if (left.volume === null && right.volume !== null) return 1;
  if (left.volume !== null && right.volume === null) return -1;
  if (left.volume !== null && right.volume !== null) {
    const partDelta = (parsePartNumber(left.name) ?? 0) - (parsePartNumber(right.name) ?? 0);
    if (partDelta !== 0) return partDelta;
    if (left.volume !== right.volume) return left.volume - right.volume;
  }
  return left.name.localeCompare(right.name, undefined, { numeric: true });
}

/** The folder name without release tags; a `Part 2` style folder is titled with its parent folder too. */
export function seriesTitle(folderPath: string): string {
  const segments = folderPath.split('/').filter(Boolean);
  const name = cleanFolderName(segments.at(-1) ?? '');
  const parent = segments.length > 1 ? cleanFolderName(segments.at(-2)!) : '';
  const title = SUB_PART_FOLDER.test(name) && parent ? `${parent} ${name}` : name;
  return title.slice(0, TITLE_MAX);
}

function cleanFolderName(name: string): string {
  const cleaned = name.replace(BRACKET_GROUPS, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || name.trim();
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}
