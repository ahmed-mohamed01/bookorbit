import { describe, expect, it, vi } from 'vitest';
import type { EditionSyncProvenance } from '@bookorbit/types';
import { provenanceFile } from './edition-sync-provenance';
import type { EditionSyncBookFileRef } from './edition-sync.types';

const file = (id: number, format: string): EditionSyncBookFileRef => ({
  id,
  bookId: 7,
  absolutePath: `/books/${id}.${format}`,
  format,
  role: 'content',
  sizeBytes: 100,
  fileHash: 'hash',
  mtime: new Date(1000),
  durationSeconds: null,
  mediaOverlayAvailable: false,
});
const epub = file(1, 'epub');
const audio = file(2, 'mp3');
const provenance = {
  bookId: 7,
  epub: provenanceFile(epub),
  audio: [{ ...provenanceFile(audio), order: 0 }],
  language: 'en',
  granularity: 'sentence',
  model: 'quartznet15x5',
  decisions: { chapters: {}, audio: [] },
} as unknown as EditionSyncProvenance;

import { checkEditionSyncSources } from './edition-sync-source-check';
describe('checkEditionSyncSources', () => {
  it('rejects a different primary EPUB even when the stored EPUB still exists', async () => {
    const repo = {
      findBookFilesByIds: vi.fn().mockResolvedValue([epub, audio]),
      findIndexSource: vi.fn().mockResolvedValue({ epub: { ...epub, id: 3 }, audio: [audio] }),
    };
    expect(await checkEditionSyncSources(repo as never, 7, { indexPath: '/index', provenance })).toEqual({ valid: false, reason: 'epub_changed' });
  });
  it.each([
    ['unchanged', [epub, audio], [audio], { valid: true }],
    ['replaced EPUB', [{ ...epub, sizeBytes: 20 }, audio], [audio], { valid: false, reason: 'epub_changed' }],
    ['removed audio', [epub], [], { valid: false, reason: 'file_missing' }],
    ['added audio', [epub, audio], [audio, { ...audio, id: 3 }], { valid: false, reason: 'audio_changed' }],
  ])('checks %s using database facts', async (_label, files, sources, expected) => {
    const repo = { findBookFilesByIds: vi.fn().mockResolvedValue(files), findIndexSource: vi.fn().mockResolvedValue({ epub, audio: sources }) };
    expect(await checkEditionSyncSources(repo as never, 7, { indexPath: '/index', provenance })).toEqual(expected);
  });
});
