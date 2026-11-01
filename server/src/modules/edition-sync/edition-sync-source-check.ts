import { compareProvenance } from './edition-sync-provenance';
import type { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncBookIndexRow } from './schema/edition-sync.schema';
import type { EditionSyncVerification } from './edition-sync.types';

export async function checkEditionSyncSources(
  repo: EditionSyncRepository,
  bookId: number,
  row: Pick<EditionSyncBookIndexRow, 'provenance' | 'indexPath'>,
): Promise<EditionSyncVerification> {
  const stored = row.provenance;
  if (!stored || stored.bookId !== bookId || !row.indexPath) return { valid: false, reason: 'index_missing' };
  const [source, files] = await Promise.all([
    repo.findIndexSource(bookId),
    repo.findBookFilesByIds([stored.epub.bookFileId, ...stored.audio.map((file) => file.bookFileId)]),
  ]);
  if (source && source.epub.id !== stored.epub.bookFileId) return { valid: false, reason: 'epub_changed' };
  const compared = compareProvenance(stored, files);
  if (!compared.valid) return compared;
  if (
    !source ||
    source.audio.length !== stored.audio.length ||
    source.audio.some((file) => !stored.audio.some((entry) => entry.bookFileId === file.id))
  )
    return { valid: false, reason: 'audio_changed' };
  return { valid: true };
}
