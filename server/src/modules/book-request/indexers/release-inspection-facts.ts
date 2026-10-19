import { extname } from 'node:path';
import type { ReleaseFileInspection } from '@bookorbit/types';
import type { ReleaseCandidate } from './indexer-adapter';
import { FORMAT_TOKENS } from './release-scoring';
import { infoHashFromMagnet } from '../fulfillment/torrent.utils';

export interface ReleaseInspectionFacts {
  infoHash: string;
  fileCount: number;
  unitCount: number;
  primaryFileCount: number;
  formats: string[];
}

export function factsFromInspection(infoHash: string, inspection: ReleaseFileInspection): ReleaseInspectionFacts | null {
  if (inspection.totalFiles === null) return null;
  const files = inspection.files.filter((file) => file.bookFile);
  const formats = [...new Set(files.map((file) => extname(file.path).slice(1).toLowerCase()).filter((format) => FORMAT_TOKENS.includes(format)))];
  return {
    infoHash: infoHash.toLowerCase(),
    fileCount: inspection.totalFiles,
    unitCount: inspection.unitCount,
    primaryFileCount: inspection.primaryFileCount ?? files.length,
    formats,
  };
}

export function releaseInfoHash(candidate: Pick<ReleaseCandidate, 'infoHash' | 'magnet'>): string | null {
  if (candidate.infoHash) return candidate.infoHash.toLowerCase();
  if (!candidate.magnet) return null;
  try {
    return infoHashFromMagnet(candidate.magnet);
  } catch {
    return null;
  }
}
