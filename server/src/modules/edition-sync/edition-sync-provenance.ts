import {
  READ_ALOUD_REBUILD_MAX_CHUNKS,
  type EditionSyncInvalidatedReason,
  type EditionSyncProvenance,
  type EditionSyncProvenanceFile,
  type ReadAloudRebuildRequest,
  type ReadAloudWorkerRequest,
} from '@bookorbit/types';
import type { EditionSyncBookFileRef, EditionSyncVerification } from './edition-sync.types';

export class EditionSyncSourcesChangedError extends Error {
  constructor(readonly reason: 'epub_changed' | 'audio_changed' | 'file_missing') {
    super('Timing index sources changed');
    this.name = 'EditionSyncSourcesChangedError';
  }
}

export function provenanceFile(file: EditionSyncBookFileRef): EditionSyncProvenanceFile {
  return {
    bookFileId: file.id,
    path: file.absolutePath,
    sizeBytes: file.sizeBytes ?? 0,
    mtimeMs: file.mtime?.getTime() ?? 0,
    fileHash: file.fileHash,
  };
}

export function compareProvenance(provenance: EditionSyncProvenance, files: EditionSyncBookFileRef[]): EditionSyncVerification {
  const byId = new Map(files.map((file) => [file.id, file]));
  const compare = (stored: EditionSyncProvenanceFile, reason: EditionSyncInvalidatedReason): EditionSyncVerification => {
    const current = byId.get(stored.bookFileId);
    if (!current || current.bookId !== provenance.bookId) return { valid: false, reason: 'file_missing' };
    if (current.sizeBytes !== stored.sizeBytes || current.fileHash !== stored.fileHash) return { valid: false, reason };
    if ((current.mtime?.getTime() ?? 0) !== stored.mtimeMs) return { valid: false, reason };
    return { valid: true };
  };
  const epub = compare(provenance.epub, 'epub_changed');
  if (!epub.valid) return epub;
  for (const audio of provenance.audio) {
    const result = compare(audio, 'audio_changed');
    if (!result.valid) return result;
  }
  return { valid: true };
}

export function matchesRebuildRequest(provenance: EditionSyncProvenance, request: ReadAloudWorkerRequest, files: EditionSyncBookFileRef[]): boolean {
  if (
    !compareProvenance(provenance, files).valid ||
    provenance.language !== request.language ||
    provenance.granularity !== request.granularity ||
    provenance.model !== request.model
  )
    return false;
  if (
    Object.keys(request.decisions.chapters).length ||
    request.decisions.audio.length ||
    Object.keys(provenance.decisions.chapters).length ||
    provenance.decisions.audio.length
  )
    return false;
  const byId = new Map(files.map((file) => [file.id, file]));
  return (
    byId.get(provenance.epub.bookFileId)?.absolutePath === request.epubPath &&
    provenance.audio.length === request.audioPaths.length &&
    [...provenance.audio]
      .sort((a, b) => a.order - b.order)
      .every((file, order) => byId.get(file.bookFileId)?.absolutePath === request.audioPaths[order])
  );
}

// Mirrors the worker's safeEntry and validateRebuild: a request it would refuse fails the whole job.
export function isWorkerSafeEntry(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2000 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
  );
}

export function isWorkerRebuildValid(rebuild: ReadAloudRebuildRequest): boolean {
  if (!isWorkerSafeEntry(rebuild.indexEntry) || rebuild.indexEntry.includes('/') || !isWorkerSafeEntry(rebuild.reportEntry)) return false;
  if (!rebuild.chunks.length || rebuild.chunks.length > READ_ALOUD_REBUILD_MAX_CHUNKS) return false;
  if (!rebuild.audioEntries.length || rebuild.audioEntries.length > READ_ALOUD_REBUILD_MAX_CHUNKS) return false;
  const names = new Set<string>();
  for (const chunk of rebuild.chunks) {
    if (!isWorkerSafeEntry(chunk.name) || chunk.name.includes('/') || names.has(chunk.name)) return false;
    if (!Number.isSafeInteger(chunk.size) || chunk.size < 0 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) return false;
    names.add(chunk.name);
  }
  const hrefs = new Set<string>();
  for (const entry of rebuild.audioEntries) {
    if (!isWorkerSafeEntry(entry.href) || entry.href === 'mimetype' || entry.href.startsWith('bookorbit-timings/')) return false;
    if (hrefs.has(entry.href) || !names.has(entry.chunk)) return false;
    hrefs.add(entry.href);
  }
  const sourceEntries = rebuild.sourceEntries === undefined ? [] : rebuild.sourceEntries;
  if (!Array.isArray(sourceEntries) || sourceEntries.length > READ_ALOUD_REBUILD_MAX_CHUNKS) return false;
  for (const entry of sourceEntries) {
    if (
      !entry ||
      typeof entry.href !== 'string' ||
      !isWorkerSafeEntry(entry.href) ||
      entry.href === 'mimetype' ||
      entry.href.startsWith('bookorbit-timings/')
    )
      return false;
    if (
      hrefs.has(entry.href) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isInteger(entry.crc32) ||
      entry.crc32 < 0 ||
      entry.crc32 > 0xffffffff ||
      (entry.position !== undefined && (!Number.isSafeInteger(entry.position) || entry.position < 0))
    )
      return false;
    hrefs.add(entry.href);
  }
  return true;
}
