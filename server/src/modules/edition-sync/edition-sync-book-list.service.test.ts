import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { BookCoverStore } from '../book-cover-store/book-cover-store.service';
import { EditionSyncBookListService } from './edition-sync-book-list.service';
import { resolveEditionSyncDecision } from './edition-sync-policy';
import { EditionSyncSettingsService } from './edition-sync-settings.service';
import { EditionSyncRepository } from './edition-sync.repository';

const COUNTS = { all: 5, problems: 1, queued: 2, synced: 1, off: 1 };

function row(overrides: Record<string, unknown> = {}) {
  return {
    bookId: 7,
    title: 'Dune',
    syncEnabled: true,
    syncOverride: null,
    status: 'queued',
    stage: null,
    progress: null,
    indexedAt: null,
    lastAttemptAt: null,
    errorCode: null,
    attemptCount: 0,
    invalidatedReason: null,
    queuePosition: null,
    sentences: null,
    matchedSentences: null,
    workerVersion: null,
    indexBytes: null,
    error: null,
    whisperFallback: false,
    formats: ['m4b', 'epub'],
    ...overrides,
  };
}

async function setup(disabledReason: string | null = null, bookSyncMode = 'all_eligible') {
  const repo = { listBooks: vi.fn().mockResolvedValue({ items: [], counts: COUNTS }) };
  const settings = { getSettings: vi.fn().mockResolvedValue({ disabledReason, bookSyncMode, effectiveEnabled: disabledReason === null }) };
  const coverStore = { facesFor: vi.fn().mockResolvedValue(new Map()) };
  const libraryScope = { visibleIdsOrAll: vi.fn().mockResolvedValue(null) };
  const module = await Test.createTestingModule({
    providers: [
      EditionSyncBookListService,
      { provide: EditionSyncRepository, useValue: repo },
      { provide: EditionSyncSettingsService, useValue: settings },
      { provide: BookCoverStore, useValue: coverStore },
      { provide: LibraryScopeService, useValue: libraryScope },
    ],
  }).compile();
  return { service: module.get(EditionSyncBookListService), repo, coverStore, libraryScope };
}

it('short circuits when the server is disabled', async () => {
  const { service, repo } = await setup('server_disabled');
  expect(await service.list({ id: 1 } as never, {})).toMatchObject({ items: [], total: 0, disabledReason: 'server_disabled' });
  expect(repo.listBooks).not.toHaveBeenCalled();
});

it.each(['all_eligible', 'selected_only'])('lists while user disabled with mode %s', async (mode) => {
  const { service, repo } = await setup('user_disabled', mode);
  const user = { id: 1 } as never;
  expect(await service.list(user, { filter: 'queued', page: 2 })).toMatchObject({ total: 2, disabledReason: 'user_disabled' });
  expect(repo.listBooks).toHaveBeenCalledWith(
    user,
    null,
    expect.objectContaining({ effectiveEnabled: false, bookSyncMode: mode }),
    'queued',
    undefined,
    2,
  );
});

it('lists only the libraries the requester scope allows', async () => {
  const { service, repo, libraryScope } = await setup();
  libraryScope.visibleIdsOrAll.mockResolvedValue([3, 8]);
  const user = { id: 1, isSuperuser: false } as never;
  await service.list(user, {});
  expect(libraryScope.visibleIdsOrAll).toHaveBeenCalledWith(user);
  expect(repo.listBooks).toHaveBeenCalledWith(user, [3, 8], expect.anything(), 'all', undefined, 1);
});

it.each(['included', 'excluded', null])('passes an off row through while the user sync is off, keeping override %s', async (override) => {
  const { service, repo } = await setup('user_disabled');
  repo.listBooks.mockResolvedValue({ items: [row({ syncEnabled: false, syncOverride: override, status: 'off' })], counts: COUNTS });
  const [item] = (await service.list({ id: 1 } as never, {})).items;
  expect(item).toMatchObject({ syncEnabled: false, syncOverride: override, status: 'off', canRunNow: false, canRetry: false });
});

it.each(['queued', 'stale', 'running', 'ready', 'failed', 'off'])('maps actions for %s', async (status) => {
  const { service, repo } = await setup();
  repo.listBooks.mockResolvedValue({
    items: [row({ status, syncEnabled: status !== 'off', syncOverride: status === 'off' ? 'excluded' : null })],
    counts: COUNTS,
  });
  const { items } = await service.list({ id: 1 } as never, {});
  expect(items[0].canRunNow).toBe(status === 'queued' || status === 'stale');
  expect(items[0].canRetry).toBe(status === 'failed');
});

// The repository computes syncEnabled in SQL; this table is the rule that SQL implements.
it.each([
  [true, 'all_eligible', null, true],
  [true, 'all_eligible', 'included', true],
  [true, 'all_eligible', 'excluded', false],
  [true, 'selected_only', null, false],
  [true, 'selected_only', 'included', true],
  [true, 'selected_only', 'excluded', false],
  [false, 'all_eligible', null, false],
  [false, 'selected_only', 'included', false],
] as const)(
  'trusts the SQL sync flag, which matches the policy (effective %s, %s, override %s)',
  async (effectiveEnabled, mode, override, expected) => {
    const policy = resolveEditionSyncDecision({
      settings: { effectiveEnabled, disabledReason: effectiveEnabled ? null : 'user_disabled', bookSyncMode: mode },
      eligible: true,
      override,
    });
    expect(policy.syncEnabled).toBe(expected);
    const { service, repo } = await setup(effectiveEnabled ? null : 'user_disabled', mode);
    repo.listBooks.mockResolvedValue({
      items: [row({ syncEnabled: expected, syncOverride: override, status: expected ? 'queued' : 'off' })],
      counts: COUNTS,
    });
    expect((await service.list({ id: 1 } as never, {})).items[0].syncEnabled).toBe(expected);
  },
);

it.each([
  [true, true],
  [false, false],
])('passes the whisper fallback through while sync is on (stored %s)', async (stored, expected) => {
  const { service, repo } = await setup();
  repo.listBooks.mockResolvedValue({ items: [row({ status: 'failed', whisperFallback: stored })], counts: COUNTS });
  expect((await service.list({ id: 1 } as never, {})).items[0].whisperFallback).toBe(expected);
});

it('logs a slow book list at warn', async () => {
  const { service } = await setup();
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValueOnce(1_000).mockReturnValueOnce(2_500);
  await service.list({ id: 4 } as never, { filter: 'queued', page: 2 });
  expect(warn).toHaveBeenCalledWith('[edition_sync.list_books] [end] userId=4 filter=queued page=2 durationMs=1500 total=2 - slow book list');
  now.mockRestore();
  warn.mockRestore();
});

it('does not log a fast book list', async () => {
  const { service } = await setup();
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  await service.list({ id: 4 } as never, {});
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

it('keeps the repository format order and normalises the indexed date', async () => {
  const { service, repo } = await setup();
  const indexedAt = new Date('2026-10-01T12:00:00Z');
  repo.listBooks.mockResolvedValue({ items: [row({ status: 'ready', formats: ['m4b', 'epub'], indexedAt })], counts: COUNTS });
  const [item] = (await service.list({ id: 1 } as never, {})).items;
  expect(item.formats).toEqual(['m4b', 'epub']);
  expect(item.indexedAt).toBe('2026-10-01T12:00:00.000Z');
});

it('takes the cover version from the cover store faces of the page rows', async () => {
  const { service, repo, coverStore } = await setup();
  repo.listBooks.mockResolvedValue({ items: [row({ bookId: 7 }), row({ bookId: 9 })], counts: COUNTS });
  coverStore.facesFor.mockResolvedValue(new Map([[7, { coverAspectRatio: '1/1', coverVersion: 'audio:2026:-' }]]));
  const { items } = await service.list({ id: 1 } as never, {});
  expect(coverStore.facesFor).toHaveBeenCalledWith([7, 9]);
  expect(items.map((item) => item.coverVersion)).toEqual(['audio:2026:-', null]);
});

it.each(['queued', 'stale', 'running', 'failed', 'ready', 'off'])('maps monitoring data for %s', async (status) => {
  const { service, repo } = await setup();
  const waiting = status === 'queued' || status === 'stale';
  repo.listBooks.mockResolvedValue({
    items: [
      row({
        status,
        lastAttemptAt: new Date('2026-11-01T01:00:00Z'),
        errorCode: 'TIMEOUT',
        attemptCount: 2,
        queuePosition: waiting ? 4 : null,
        invalidatedReason: waiting ? 'files_changed' : null,
        sentences: status === 'ready' ? 100 : null,
        matchedSentences: status === 'ready' ? 90 : null,
        workerVersion: status === 'ready' ? '1.0' : null,
        indexBytes: status === 'ready' ? 2048 : null,
      }),
    ],
    counts: COUNTS,
  });
  const [item] = (await service.list({ id: 1 } as never, {})).items;
  expect(item).toMatchObject({
    lastAttemptAt: '2026-11-01T01:00:00.000Z',
    errorCode: 'TIMEOUT',
    attemptCount: 2,
    queuePosition: waiting ? 4 : null,
    invalidatedReason: waiting ? 'files_changed' : null,
    sentences: status === 'ready' ? 100 : null,
  });
});
