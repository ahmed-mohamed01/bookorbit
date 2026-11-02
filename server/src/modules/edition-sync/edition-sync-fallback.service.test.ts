import { describe, expect, it, vi } from 'vitest';

import { EditionSyncFallbackService } from './edition-sync-fallback.service';

type Options = {
  row?: { status: string } | null;
  permission?: boolean;
  settings?: { enabled: boolean; bookSyncMode: 'all_eligible' | 'selected_only' } | null;
  override?: 'included' | 'excluded' | null;
  eligible?: boolean | null;
};

function setup(options: Options = {}) {
  const repo = {
    isServerEnabled: vi.fn().mockResolvedValue(true),
    findIndexRow: vi.fn().mockResolvedValue(options.row === undefined ? { status: 'failed' } : options.row),
    userHasEditionSyncPermission: vi.fn().mockResolvedValue(options.permission ?? true),
    findResolverInputs: vi.fn().mockResolvedValue({
      settings: options.settings === undefined ? { enabled: true, bookSyncMode: 'all_eligible' } : options.settings,
      override: options.override ?? null,
      index: null,
    }),
    findEligibility: vi.fn().mockResolvedValue(options.eligible === null ? null : { bookId: 10, eligible: options.eligible ?? true }),
  };
  return { service: new EditionSyncFallbackService(repo as never), repo };
}

describe('EditionSyncFallbackService.allowsWhisperFallback', () => {
  it.each([[null], [{ status: 'ready' }], [{ status: 'queued' }], [{ status: 'running' }], [{ status: 'stale' }]])(
    'is false for a book whose index row is %j, without reading the user',
    async (row) => {
      const { service, repo } = setup({ row });
      await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
      expect(repo.userHasEditionSyncPermission).not.toHaveBeenCalled();
    },
  );

  it('is false without the edition sync permission', async () => {
    const { service, repo } = setup({ permission: false });
    await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
    expect(repo.userHasEditionSyncPermission).toHaveBeenCalledWith(7);
    expect(repo.findResolverInputs).not.toHaveBeenCalled();
  });

  it('is false when the user disabled sync', async () => {
    const { service, repo } = setup({ settings: { enabled: false, bookSyncMode: 'all_eligible' } });
    await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
    expect(repo.findEligibility).not.toHaveBeenCalled();
  });

  it('is false when the book is excluded', async () => {
    const { service } = setup({ override: 'excluded' });
    await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
  });

  it('is false in selected_only mode without an include, true with one', async () => {
    const off = setup({ settings: { enabled: true, bookSyncMode: 'selected_only' } });
    await expect(off.service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
    const on = setup({ settings: { enabled: true, bookSyncMode: 'selected_only' }, override: 'included' });
    await expect(on.service.allowsWhisperFallback(7, 10)).resolves.toBe(true);
  });

  it('is false when the book is not eligible or missing', async () => {
    for (const eligible of [false, null]) {
      const { service } = setup({ eligible });
      await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
    }
  });

  it('is true for a failed book the user has permission, sync and scope for', async () => {
    const { service, repo } = setup();
    await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(true);
    expect(repo.findIndexRow).toHaveBeenCalledWith(10);
    expect(repo.findResolverInputs).toHaveBeenCalledWith(7, 10);
    expect(repo.findEligibility).toHaveBeenCalledWith(10);
  });
});

it('allows an eligible failed book for a user with no settings row', async () => {
  await expect(setup({ settings: null }).service.allowsWhisperFallback(7, 10)).resolves.toBe(true);
});
it('suppresses Whisper fallback when the server is disabled', async () => {
  const { service, repo } = setup();
  repo.isServerEnabled.mockResolvedValue(false);
  await expect(service.allowsWhisperFallback(7, 10)).resolves.toBe(false);
  expect(repo.findEligibility).not.toHaveBeenCalled();
});
