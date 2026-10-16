import type { EngineUnitSpec } from '../engines/web-serial-engine';
import { compareFiles, parsePartNumber } from './file-index-grouping';

const LABEL_MAX = 300;
const BRACKET_GROUPS = /\s*[[({][^\])}]*[\])}]/g;
const VOLUME_TAIL = /(?:^|[^a-z])(?:volume|vol\.?|v)\s*[-_.]?\s*0*\d{1,4}(?:\.\d+)?(?![\d])(.*)$/i;

export interface FileIndexUnitFile {
  id: number;
  path: string;
  name: string;
  size: number | null;
  volume: number;
}

/** What a download needs to find the file again: its row, re-read at download time so a removed file fails cleanly. */
export interface FileIndexUnitRemote {
  fileId: number;
  path: string;
}

/**
 * One volume unit per file. The sequence is the volume number, so the book is filed as that volume, unless the series is
 * split into parts whose volume numbers restart; then it is the file's place in the list, which keeps ranges working.
 */
export function fileIndexUnits(files: readonly FileIndexUnitFile[]): EngineUnitSpec[] {
  const ordered = [...files].sort(compareFiles);
  const byVolume = ordered.every((file) => parsePartNumber(file.name) === null);

  return ordered.map((file, index) => {
    const part = parsePartNumber(file.name);
    const remote: FileIndexUnitRemote = { fileId: file.id, path: file.path };
    return {
      // Stable across refreshes and renamed releases of the same volume, so the import ledger recognises a filed volume.
      unitKey: part === null ? `volume-${file.volume}` : `part-${part}-volume-${file.volume}`,
      label: unitLabel(file, part),
      sequence: byVolume ? String(file.volume) : String(index + 1),
      chapterCount: 0,
      publishedAt: null,
      volume: String(file.volume),
      packaging: 'volume',
      remote: remote as unknown as Record<string, unknown>,
    };
  });
}

/** `Volume 1: Spy Sensation` from `S - Volume 01 - Spy Sensation [June][Kindle].epub`. */
export function unitLabel(file: Pick<FileIndexUnitFile, 'name' | 'volume'>, part: number | null = parsePartNumber(file.name)): string {
  const stem = file.name.replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(BRACKET_GROUPS, '').trim() || stem;
  const heading = `${part === null ? '' : `Part ${part} `}Volume ${file.volume}`;
  const subtitle = (VOLUME_TAIL.exec(cleaned)?.[1] ?? '').replace(/^[\s:.\-–_]+/, '').trim();
  return (subtitle ? `${heading}: ${subtitle}` : heading).slice(0, LABEL_MAX);
}
