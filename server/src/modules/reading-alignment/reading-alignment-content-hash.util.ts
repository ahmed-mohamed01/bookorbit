import { createHash } from 'crypto';

type HashableAudioFile = { fileId: number; absolutePath: string; durationSeconds: number | null };
type HashableEbookFile = { id: number; absolutePath: string; sizeBytes: number | null };
type StoredContentHashes = { audioContentHash: string | null; epubContentHash: string | null };
type ContentFileReader = {
  findEbookFile(textBookId: number): Promise<HashableEbookFile | undefined>;
  resolveAudioFilesWithPaths(audioBookId: number): Promise<HashableAudioFile[]>;
};

// The hash inputs are persisted on every alignment row, so changing them marks every existing alignment stale.
export function audioContentHashOf(files: readonly HashableAudioFile[]): string {
  return sha256Json(files.map((f) => [f.fileId, f.absolutePath, f.durationSeconds]));
}

export function epubContentHashOf(ebook: HashableEbookFile): string {
  return sha256Json([ebook.id, ebook.absolutePath, ebook.sizeBytes]);
}

export function contentHashesDiffer(
  stored: StoredContentHashes,
  ebook: HashableEbookFile | undefined,
  audioFiles: readonly HashableAudioFile[],
): boolean {
  if (!ebook || audioFiles.length === 0) return true;
  return stored.audioContentHash !== audioContentHashOf(audioFiles) || stored.epubContentHash !== epubContentHashOf(ebook);
}

// Two indexed reads of the pair's current content rows, no file IO, so callers can check a ready
// alignment against what is on disk now.
export async function alignmentContentChanged(
  reader: ContentFileReader,
  pair: { textBookId: number; audioBookId: number },
  stored: StoredContentHashes,
): Promise<boolean> {
  const [ebook, audioFiles] = await Promise.all([reader.findEbookFile(pair.textBookId), reader.resolveAudioFilesWithPaths(pair.audioBookId)]);
  return contentHashesDiffer(stored, ebook, audioFiles);
}

function sha256Json(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
