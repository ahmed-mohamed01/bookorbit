import type { EngineUnitSpec } from '../engines/web-serial-engine';
import { compareFiles, parsePartNumber, parseVolumeNumber } from './file-index-grouping';

const LABEL_MAX = 300;
const BRACKET_GROUPS = /\s*[[({][^\])}]*[\])}]/g;
const VOLUME_TAIL = /(?:^|[^a-z])(?:volume|vol\.?|v)\s*[-_.]?\s*0*\d{1,4}(?:\.\d+)?(?![\d])(.*)$/i;

export interface FileIndexUnitFile {
  id: number;
  path: string;
  name: string;
  size: number | null;
  volume: number | null;
}

/** What a download needs to find the file again: its row, re-read at download time so a removed file fails cleanly. */
export interface FileIndexUnitRemote {
  fileId: number;
  path: string;
}

/**
 * One volume unit per file. The sequence is the volume number when every file states a distinct one and none belongs to
 * a part, so the book is filed as that volume; otherwise it is the file's place in the list, which keeps ranges working.
 */
export function fileIndexUnits(files: readonly FileIndexUnitFile[]): EngineUnitSpec[] {
  const ordered = [...files].sort(compareFiles);
  const volumes = ordered.map((file) => file.volume);
  const byVolume =
    volumes.every((volume) => volume !== null) &&
    new Set(volumes).size === volumes.length &&
    ordered.every((file) => parsePartNumber(file.name) === null);

  return ordered.map((file, index) => {
    const part = parsePartNumber(file.name);
    const sequence = byVolume ? String(file.volume) : String(index + 1);
    const remote: FileIndexUnitRemote = { fileId: file.id, path: file.path };
    return {
      unitKey: unitKey(file, part),
      label: unitLabel(file, part),
      sequence,
      chapterCount: 0,
      publishedAt: null,
      volume: file.volume === null ? null : String(file.volume),
      packaging: 'volume',
      remote: remote as unknown as Record<string, unknown>,
    };
  });
}

/** Stable across refreshes and renamed releases of the same volume, so the import ledger recognises a volume already filed. */
function unitKey(file: FileIndexUnitFile, part: number | null): string {
  if (file.volume === null) return `file-${file.id}`;
  return part === null ? `volume-${file.volume}` : `part-${part}-volume-${file.volume}`;
}

/** `Volume 1: Spy Sensation` from `S - Volume 01 - Spy Sensation [June][Kindle].epub`; the bare stem when no volume is stated. */
export function unitLabel(file: Pick<FileIndexUnitFile, 'name' | 'volume'>, part: number | null = parsePartNumber(file.name)): string {
  const stem = file.name.replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(BRACKET_GROUPS, '').trim() || stem;
  if (file.volume === null || parseVolumeNumber(file.name) === null) return cleaned.slice(0, LABEL_MAX);
  const heading = `${part === null ? '' : `Part ${part} `}Volume ${file.volume}`;
  const subtitle = (VOLUME_TAIL.exec(cleaned)?.[1] ?? '').replace(/^[\s:.\-–_]+/, '').trim();
  return (subtitle ? `${heading}: ${subtitle}` : heading).slice(0, LABEL_MAX);
}
