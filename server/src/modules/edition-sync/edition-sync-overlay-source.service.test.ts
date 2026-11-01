import { Logger } from '@nestjs/common';
import { checkEditionSyncSources } from './edition-sync-source-check';
vi.mock('./edition-sync-source-check', () => ({ checkEditionSyncSources: vi.fn() }));
import { describe, expect, it, vi } from 'vitest';

import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';

const epub = {
  id: 1,
  absolutePath: '/lib/b/book.epub',
  format: 'epub',
  role: 'content',
  sortOrder: 0,
  durationSeconds: null,
  mediaOverlayAvailable: false,
  mediaOverlayDurationSeconds: null,
};
const audio = { ...epub, id: 2, absolutePath: '/lib/b/book.m4b', format: 'm4b', durationSeconds: 3600 };
const index = { ...epub, id: 3, absolutePath: '/lib/b/book.bookorbit-timings', format: 'bookorbit-timings', role: 'supplement' };

function setup(inputs: {
  enabled?: boolean;
  mode?: 'all_eligible' | 'selected_only';
  override?: 'included' | 'excluded' | null;
  status?: 'running' | 'ready' | 'failed' | 'stale' | null;
  hasPermission?: boolean;
  indexFileId?: number | null;
}) {
  vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: true });
  const repo = {
    findResolverInputs: vi.fn().mockResolvedValue({
      settings:
        inputs.enabled === undefined
          ? null
          : { userId: 7, enabled: inputs.enabled, bookSyncMode: inputs.mode ?? 'all_eligible', updatedAt: new Date() },
      override: inputs.override ?? null,
      index: inputs.status
        ? { status: inputs.status, indexFileId: inputs.indexFileId === undefined ? 3 : inputs.indexFileId, indexPath: index.absolutePath }
        : null,
    }),
    flagRecheck: vi.fn(),
    markStale: vi.fn(),
    clearRecheck: vi.fn(),
    userHasEditionSyncPermission: vi.fn().mockResolvedValue(inputs.hasPermission ?? true),
  };
  return { service: new EditionSyncOverlaySourceService(repo as never), repo };
}

describe('EditionSyncOverlaySourceService.resolveOverlaySource', () => {
  it('offers the ready index as a media-overlay source for a user with sync on', async () => {
    const { service } = setup({ enabled: true, status: 'ready' });
    await expect(service.resolveOverlaySource(7, 10, [epub, audio, index])).resolves.toEqual({ ...index, mediaOverlayAvailable: true });
  });

  it('matches the index by path while the row has no file id yet', async () => {
    const { service } = setup({ enabled: true, status: 'ready', indexFileId: null });
    await expect(service.resolveOverlaySource(7, 10, [epub, audio, index])).resolves.toMatchObject({ id: 3, mediaOverlayAvailable: true });
  });

  it.each([
    ['no settings row', { status: 'ready' as const }],
    ['sync disabled', { enabled: false, status: 'ready' as const }],
    ['no permission', { enabled: true, hasPermission: false, status: 'ready' as const }],
    ['book excluded', { enabled: true, override: 'excluded' as const, status: 'ready' as const }],
    ['selected-only without include', { enabled: true, mode: 'selected_only' as const, status: 'ready' as const }],
    ['index running', { enabled: true, status: 'running' as const }],
    ['index stale', { enabled: true, status: 'stale' as const }],
    ['index failed', { enabled: true, status: 'failed' as const }],
  ])('returns null when %s', async (_label, inputs) => {
    const { service } = setup(inputs);
    await expect(service.resolveOverlaySource(7, 10, [epub, audio, index])).resolves.toBeNull();
  });

  it('uses an include in selected-only mode', async () => {
    const { service } = setup({ enabled: true, mode: 'selected_only', override: 'included', status: 'ready' });
    await expect(service.resolveOverlaySource(7, 10, [epub, audio, index])).resolves.toMatchObject({ id: 3 });
  });

  it('skips the database when the book has no index file', async () => {
    const { service, repo } = setup({ enabled: true, status: 'ready' });
    await expect(service.resolveOverlaySource(7, 10, [epub, audio])).resolves.toBeNull();
    expect(repo.findResolverInputs).not.toHaveBeenCalled();
  });

  it('caches the decision per user and book until invalidated', async () => {
    const { service, repo } = setup({ enabled: true, status: 'ready' });
    await service.resolveOverlaySource(7, 10, [index]);
    await service.resolveOverlaySource(7, 10, [index]);
    expect(repo.findResolverInputs).toHaveBeenCalledTimes(1);

    service.invalidate(7, 10);
    await service.resolveOverlaySource(7, 10, [index]);
    service.invalidateBook(10);
    await service.resolveOverlaySource(7, 10, [index]);
    service.invalidate(7);
    await service.resolveOverlaySource(7, 10, [index]);
    expect(repo.findResolverInputs).toHaveBeenCalledTimes(4);
  });

  it('rejects changed sources even without a catalog recheck flag', async () => {
    const { service, repo } = setup({ enabled: true, status: 'ready' });
    vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: false, reason: 'audio_changed' });
    await expect(service.resolveOverlaySource(7, 10, [index])).resolves.toBeNull();
    expect(repo.markStale).toHaveBeenCalledWith(10, 'audio_changed');
  });

  it('never throws into progress sync', async () => {
    const { service, repo } = setup({ enabled: true, status: 'ready' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo.findResolverInputs.mockRejectedValueOnce(new Error('db down'));
    await expect(service.resolveOverlaySource(7, 10, [index])).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/durationMs=\d+ errorClass=Error/));
    warn.mockRestore();
  });
});

describe('EditionSyncOverlaySourceService.resolveEpubDomSource', () => {
  it('reads the index file as an EPUB and leaves other formats alone', async () => {
    const { service } = setup({});
    await expect(service.resolveEpubDomSource(3, { absolutePath: index.absolutePath, format: 'bookorbit-timings' })).resolves.toEqual({
      absolutePath: index.absolutePath,
      format: 'epub',
    });
    await expect(service.resolveEpubDomSource(2, { absolutePath: audio.absolutePath, format: 'm4b' })).resolves.toBeNull();
  });
});

it('serves nothing and flags fingerprinted mismatches for the scheduler without loading a fingerprint service', async () => {
  const { service, repo } = setup({ enabled: true, status: 'ready' });
  const inputs = await repo.findResolverInputs();
  inputs.index.provenance = { epub: { chapterFingerprint: 'a'.repeat(64) }, audio: [{ audioFingerprint: 'b'.repeat(32) }] };
  vi.mocked(checkEditionSyncSources).mockResolvedValue({ valid: false, reason: 'audio_changed', canCheckContent: true });
  expect(await service.resolveOverlaySource(7, 10, [index])).toBeNull();
  expect(repo.flagRecheck).toHaveBeenCalledWith(10);
  expect(repo.markStale).not.toHaveBeenCalled();
});

it.each([false, true])('resolver uses shared per-changed-file coverage: uncovered=%s', async (uncovered) => {
  const { service, repo } = setup({ enabled: true, status: 'ready' });
  const { checkEditionSyncSources: actualCheck } = await vi.importActual<typeof import('./edition-sync-source-check')>('./edition-sync-source-check');
  vi.mocked(checkEditionSyncSources).mockImplementation(actualCheck);
  const sourceEpub = { ...epub, bookId: 10, sizeBytes: 100, fileHash: 'old', mtime: new Date(1000) };
  const first = { ...sourceEpub, id: 2, format: 'm4b' };
  const second = { ...first, id: 4 };
  const storedFile = (file: typeof sourceEpub) => ({
    bookFileId: file.id,
    path: file.absolutePath,
    sizeBytes: file.sizeBytes,
    fileHash: file.fileHash,
    mtimeMs: 1000,
  });
  const inputs = await repo.findResolverInputs();
  inputs.index.provenance = {
    bookId: 10,
    epub: storedFile(sourceEpub),
    audio: [
      { ...storedFile(first), order: 0, audioFingerprint: 'a'.repeat(32) },
      { ...storedFile(second), order: 1 },
    ],
  };
  Object.assign(repo, {
    findIndexSource: vi.fn().mockResolvedValue({ epub: sourceEpub, audio: [first, second] }),
    findBookFilesByIds: vi.fn().mockResolvedValue([sourceEpub, { ...first, fileHash: 'new' }, { ...second, fileHash: uncovered ? 'new' : 'old' }]),
  });
  expect(await service.resolveOverlaySource(7, 10, [index])).toBeNull();
  if (uncovered) {
    expect(repo.markStale).toHaveBeenCalledWith(10, 'audio_changed');
    expect(repo.flagRecheck).not.toHaveBeenCalled();
  } else {
    expect(repo.flagRecheck).toHaveBeenCalledWith(10);
    expect(repo.markStale).not.toHaveBeenCalled();
  }
});
