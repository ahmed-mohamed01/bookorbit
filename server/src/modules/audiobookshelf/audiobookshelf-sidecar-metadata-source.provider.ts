import { basename } from 'path';

import { selectSidecarCoverPath } from '../metadata/lib/cover-source-resolution';
import type { MetadataSourceFile, MetadataSourceProvider } from '../scanner/metadata-source-provider';
import { AudiobookshelfRepository } from './audiobookshelf.repository';

/**
 * Implements the scanner's `sidecar` metadata source using Audiobookshelf's convention: a
 * `metadata.json` written alongside the audio files. The filename knowledge lives here rather than
 * in the scanner so removing this plugin leaves the `sidecar` precedence entry simply unimplemented,
 * which is how the scanner already treats every key without a provider.
 */
export class AudiobookshelfSidecarMetadataSourceProvider implements MetadataSourceProvider {
  readonly key = 'sidecar';

  constructor(private readonly repo: AudiobookshelfRepository) {}

  select<T extends MetadataSourceFile>(files: readonly T[]): { file: T; format: string } | null {
    const file = files.find(
      (candidate) => candidate.role === 'metadata' && candidate.format === 'json' && basename(candidate.absolutePath) === 'metadata.json',
    );
    return file ? { file, format: 'json' } : null;
  }

  // Audiobookshelf writes `cover.jpg` (or another image extension) beside the audio files.
  selectCover<T extends MetadataSourceFile>(files: readonly T[]): T | null {
    const coverFiles = files.filter((file) => file.role === 'cover');
    const winningPath = selectSidecarCoverPath(coverFiles);
    if (!winningPath) return null;
    return coverFiles.find((file) => file.absolutePath === winningPath) ?? null;
  }

  listCoversForBooks(libraryId: number, bookIds: number[]): Promise<{ bookId: number; absolutePath: string; format: string | null }[]> {
    return this.repo.findCoverFilesForBooks(libraryId, bookIds);
  }
}
