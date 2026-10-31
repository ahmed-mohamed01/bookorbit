import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitoredAuthorConfig, MonitoredWork } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { isAutoFormat, isDestinationRefusal, isRequestable, MonitoredAutoRequestService, submitThrottled } from './monitored-autorequest.service';

const user = { id: 9, isSuperuser: true, active: true } as RequestUser;

function monitor(patch: Partial<MonitoredAuthorConfig> = {}): MonitoredAuthorConfig {
  return {
    id: 'monitor-1',
    ownerUserId: 4,
    authorName: 'Test Author',
    localAuthorId: null,
    providerIds: { hardcover: 'author-1' },
    formats: {
      ebook: { mode: 'auto-all', libraryId: 2, folderId: 3 },
      audiobook: { mode: 'off', libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-03-15T10:00:00.000Z',
    lastRefreshedAt: null,
    fetch: { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
    ...patch,
  };
}

function work(patch: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'Test Work',
    subtitle: 'A Subtitle',
    seriesName: 'Test Series',
    seriesIndex: '2',
    seriesMemberships: [],
    releaseYear: 2026,
    ebookReleaseDate: '2026-09-01',
    ebookDatePrecision: 'day',
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: 'https://example.com/cover.jpg',
    description: null,
    verdict: 'verified',
    flags: [],
    sources: ['hardcover'],
    providerWorkIds: { hardcover: 'hardcover-work-1' },
    monitorState: 'monitoring',
    matchedBookId: null,
    matchedBookIds: {},
    ownedFormats: [],
    monitorFormats: {},
    requestIds: {},
    ...patch,
  };
}

function harness(works: MonitoredWork[], submit = vi.fn()) {
  let nextId = 100;
  if (!submit.getMockImplementation()) submit.mockImplementation(() => Promise.resolve({ request: { id: nextId++ } }));
  const updateWorkUserState = vi.fn().mockImplementation((workId: string, patch: { requestIds: Record<string, number> }) => {
    const current = works.find((candidate) => candidate.id === workId)!;
    current.requestIds = { ...current.requestIds, ...patch.requestIds };
    return Promise.resolve(current);
  });
  return {
    service: new MonitoredAutoRequestService({ submit } as never, { updateWorkUserState } as never),
    submit,
    updateWorkUserState,
  };
}

describe('MonitoredAutoRequestService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['notify', true, false, 1],
    ['auto-all', false, false, 0],
    ['off', true, false, 0],
    ['notify', true, true, 0],
    ['auto-upcoming', true, false, 1],
    ['auto-upcoming', undefined, false, 0],
  ] as const)('applies override %s %s with paused=%s', async (mode, override, paused, created) => {
    const works = [work({ ...(override === undefined ? {} : { autoDownload: { ebook: override } }), ebookReleaseDate: '2025-01-01' })];
    const { service, submit } = harness(works);
    const configured = monitor({ paused, formats: { ...monitor().formats, ebook: { mode, libraryId: 2, folderId: 3 } } });
    expect((await service.fanOut(configured, works, user)).created).toBe(created);
    expect(submit).toHaveBeenCalledTimes(created);
  });

  it.each([
    ['a possible match', { possibleMatches: { ebook: { bookId: 9 } } }],
    ['an existing request', { requestIds: { ebook: 41 } }],
    ['a hidden work', { userVisibility: 'hidden' as const }],
    ['an owned format', { ownedFormats: ['ebook' as const] }],
  ])('does not let an override on bypass %s', async (_label, blocker) => {
    const works = [work({ autoDownload: { ebook: true }, ebookReleaseDate: '2025-01-01', ...(blocker as object) })];
    const { service, submit } = harness(works);
    const configured = monitor({ formats: { ...monitor().formats, ebook: { mode: 'notify', libraryId: 2, folderId: 3 } } });
    expect((await service.fanOut(configured, works, user)).created).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits an auto-all work for the monitor owner and records the request id', async () => {
    const works = [work()];
    const { service, submit, updateWorkUserState } = harness(works);

    await expect(service.fanOut(monitor(), works, user)).resolves.toEqual({ created: 1, skipped: 0, failed: 0 });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 4,
        title: 'Test Work',
        subtitle: 'A Subtitle',
        authors: ['Test Author'],
        seriesName: 'Test Series',
        seriesIndex: 2,
        publishedYear: 2026,
        coverUrl: 'https://example.com/cover.jpg',
        providerKey: 'hardcover',
        providerId: 'hardcover-work-1',
        targetLibraryId: 2,
        targetFolderId: 3,
        autoGrab: true,
      }),
      user,
    );
    expect(updateWorkUserState).toHaveBeenCalledWith('work-1', { requestIds: { ebook: 100 } }, user);
  });

  it('does not request missing audio for an owned flagged work', async () => {
    const works = [work({ ownedFormats: ['ebook'], verdict: 'suspect', flags: ['wrong_contributor'] })];
    const { service, submit } = harness(works);
    const configured = monitor({
      formats: {
        ebook: { mode: 'off', libraryId: null, folderId: null },
        audiobook: { mode: 'auto-all', libraryId: 2, folderId: 3 },
      },
    });

    await expect(service.fanOut(configured, works, user)).resolves.toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('forwards a per-request source list to the book request submission', async () => {
    const works = [work()];
    const { service, submit } = harness(works);

    await service.submitWorkRequest(user, monitor(), works[0]!, 'ebook', { sourceIds: [4, 7] });

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: [4, 7] }), user);
  });

  it('is idempotent once a request id has been recorded', async () => {
    const works = [work()];
    const { service, submit } = harness(works);

    await service.fanOut(monitor(), works, user);
    await expect(service.fanOut(monitor(), works, user)).resolves.toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    ['owned format', work({ ownedFormats: ['ebook'] })],
    ['matched book', work({ matchedBookIds: { ebook: 12 } })],
  ])('skips a work already owned through its %s marker', async (_label, ownedWork) => {
    const { service, submit } = harness([ownedWork]);

    await expect(service.fanOut(monitor(), [ownedWork], user)).resolves.toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['notify', 'off'] as const)('creates nothing for %s mode', async (mode) => {
    const works = [work()];
    const { service, submit } = harness(works);
    const configured = monitor({ formats: { ...monitor().formats, ebook: { mode, libraryId: 2, folderId: 3 } } });

    await expect(service.fanOut(configured, works, user)).resolves.toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ['hidden work', { userVisibility: 'hidden' as const }],
    ['disabled format', { monitorFormats: { ebook: false } }],
    ['paused work', { monitorState: 'paused' as const }],
    ['stopped work', { monitorState: 'stopped' as const }],
  ])('skips a %s', async (_label, patch) => {
    const works = [work(patch)];
    const { service, submit } = harness(works);

    await expect(service.fanOut(monitor(), works, user)).resolves.toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('does nothing while the monitor is paused', async () => {
    const works = [work()];
    const { service, submit } = harness(works);

    await expect(service.fanOut(monitor({ paused: true }), works, user)).resolves.toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('uses precision-aware release windows for auto-upcoming back-catalog exclusion', async () => {
    const works = [
      work({ id: 'day-before', ebookReleaseDate: '2026-03-14', ebookDatePrecision: 'day' }),
      work({ id: 'day-after', ebookReleaseDate: '2026-03-16', ebookDatePrecision: 'day' }),
      work({ id: 'month-before', ebookReleaseDate: '2026-02', ebookDatePrecision: 'month' }),
      work({ id: 'month-overlap', ebookReleaseDate: '2026-03', ebookDatePrecision: 'month' }),
      work({ id: 'year-before', ebookReleaseDate: '2025', ebookDatePrecision: 'year' }),
      work({ id: 'year-overlap', ebookReleaseDate: '2026', ebookDatePrecision: 'year' }),
    ];
    const { service, submit } = harness(works);
    const configured = monitor({ formats: { ...monitor().formats, ebook: { mode: 'auto-upcoming', libraryId: 2, folderId: 3 } } });

    await expect(service.fanOut(configured, works, user)).resolves.toEqual({ created: 2, skipped: 4, failed: 0 });
    expect(submit.mock.calls.map(([payload]) => payload.title)).toHaveLength(2);
    expect(works.filter((item) => item.requestIds.ebook != null).map((item) => item.id)).toEqual(['day-after', 'month-overlap']);
  });

  it('treats a month or year date as due only once its range has ended, like the watcher', async () => {
    const works = [
      work({ id: 'month-current', ebookReleaseDate: '2026-09', ebookDatePrecision: 'month' }),
      work({ id: 'month-last', ebookReleaseDate: '2026-08', ebookDatePrecision: 'month' }),
      work({ id: 'year-current', ebookReleaseDate: '2026', ebookDatePrecision: 'year' }),
      work({ id: 'year-last', ebookReleaseDate: '2025', ebookDatePrecision: 'year' }),
      work({ id: 'day-today', ebookReleaseDate: '2026-09-05', ebookDatePrecision: 'day' }),
    ];
    const { service } = harness(works);
    const configured = monitor({ formats: { ...monitor().formats, ebook: { mode: 'auto-all', libraryId: 2, folderId: 3 } } });

    await expect(service.fanOut(configured, works, user)).resolves.toEqual({ created: 3, skipped: 2, failed: 0 });
    expect(works.filter((item) => item.requestIds.ebook != null).map((item) => item.id)).toEqual(['month-last', 'year-last', 'day-today']);

    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    await expect(service.fanOut(configured, works, user)).resolves.toEqual({ created: 2, skipped: 3, failed: 0 });
    expect(works.filter((item) => item.requestIds.ebook != null).map((item) => item.id)).toEqual(
      expect.arrayContaining(['month-current', 'year-current']),
    );
  });

  it('isolates a failed submission and continues the remaining candidates', async () => {
    const works = Array.from({ length: 4 }, (_, index) =>
      work({ id: `work-${index}`, title: `Work ${index}`, ebookReleaseDate: `2026-09-0${index + 1}` }),
    );
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ request: { id: 1 } })
      .mockRejectedValueOnce(new Error('tracker unavailable'))
      .mockResolvedValueOnce({ request: { id: 3 } })
      .mockResolvedValueOnce({ request: { id: 4 } });
    const { service } = harness(works, submit);

    await expect(service.fanOut(monitor(), works, user)).resolves.toEqual({ created: 3, skipped: 0, failed: 1 });
    expect(submit).toHaveBeenCalledTimes(4);
  });

  it('stops only the refused destination format', async () => {
    const works = [
      work({ id: 'ebook-first', ebookReleaseDate: '2026-09-05' }),
      work({ id: 'audio-first', ebookReleaseDate: null, ebookDatePrecision: null, audioReleaseDate: '2026-09-04', audioDatePrecision: 'day' }),
      work({ id: 'audio-second', ebookReleaseDate: null, ebookDatePrecision: null, audioReleaseDate: '2026-09-03', audioDatePrecision: 'day' }),
      work({ id: 'ebook-second', ebookReleaseDate: '2026-09-02' }),
      work({ id: 'audio-third', ebookReleaseDate: null, ebookDatePrecision: null, audioReleaseDate: '2026-09-01', audioDatePrecision: 'day' }),
      work({ id: 'ebook-third', ebookReleaseDate: '2026-08-31' }),
    ];
    const submit = vi.fn().mockImplementation((payload: { mediaKind: string }) => {
      if (payload.mediaKind === 'ebook') {
        return Promise.reject(new BadRequestException({ message: 'Pick a destination', errorCode: 'SUBMIT_DESTINATION_REQUIRED', statusCode: 400 }));
      }
      return Promise.resolve({ request: { id: 200 } });
    });
    const { service } = harness(works, submit);
    const configured = monitor({
      formats: {
        ebook: { mode: 'auto-all', libraryId: null, folderId: null },
        audiobook: { mode: 'auto-all', libraryId: 8, folderId: null },
      },
    });

    const result = await service.fanOut(configured, works, user);

    expect(result).toEqual({ created: 3, skipped: 8, failed: 1 });
    expect(submit.mock.calls.filter(([payload]) => payload.mediaKind === 'ebook')).toHaveLength(1);
    expect(submit.mock.calls.filter(([payload]) => payload.mediaKind === 'audiobook')).toHaveLength(3);
  });

  it('defers immediate automation from the fourth candidate onward', async () => {
    const works = Array.from({ length: 5 }, (_, index) => work({ id: `work-${index}`, ebookReleaseDate: `2026-09-0${index + 1}` }));
    const { service, submit } = harness(works);

    await service.fanOut(monitor(), works, user);

    const payloads = submit.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    expect(payloads.slice(0, 3).every((payload) => !('deferAutomation' in payload))).toBe(true);
    expect(payloads.slice(3).every((payload) => payload.deferAutomation === true)).toBe(true);
  });
});

describe('auto-request helpers', () => {
  const refusal = () => new BadRequestException({ message: 'Pick a destination', errorCode: 'SUBMIT_DESTINATION_REQUIRED', statusCode: 400 });

  it('treats owned, matched, already requested, opted out and unmonitored works as not requestable', () => {
    expect(isRequestable(work(), 'ebook')).toBe(true);
    expect(isRequestable(work({ ownedFormats: ['ebook'] }), 'ebook')).toBe(false);
    expect(isRequestable(work({ matchedBookIds: { ebook: 5 } }), 'ebook')).toBe(false);
    expect(isRequestable(work({ requestIds: { ebook: 12 } }), 'ebook')).toBe(false);
    expect(isRequestable(work({ monitorFormats: { ebook: false } }), 'ebook')).toBe(false);
    expect(isRequestable(work({ monitorState: 'stopped' }), 'ebook')).toBe(false);
  });

  it('holds a format back while a possible match waits for the owner, and only that format', () => {
    const flagged = work({ possibleMatches: { ebook: { bookId: 31, title: 'Inhibitor Phase', seriesName: 'Revelation Space', seriesIndex: '5' } } });

    expect(isRequestable(flagged, 'ebook')).toBe(false);
    expect(isRequestable(flagged, 'audiobook')).toBe(true);
  });

  it('follows the owner mark: a review mark blocks a kept work, Book requests an unverified one', () => {
    expect(isRequestable(work({ userVisibility: 'visible', userKind: 'collection' }), 'ebook')).toBe(false);
    expect(isRequestable(work({ verdict: 'suspect', userKind: 'book' }), 'ebook')).toBe(true);
  });

  it('recognises only the destination error codes as a refusal', () => {
    expect(isDestinationRefusal(refusal())).toBe(true);
    expect(isDestinationRefusal(new BadRequestException({ message: 'nope', errorCode: 'OTHER' }))).toBe(false);
    expect(isDestinationRefusal(new Error('SUBMIT_DESTINATION_REQUIRED'))).toBe(false);
  });

  it('submits in chunks of three, deferring from the fourth candidate, and reports outcomes in order', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({ id: index, format: 'ebook' as const }));
    const inFlight: number[] = [];
    let running = 0;
    const submit = vi.fn().mockImplementation(async (candidate: { id: number }) => {
      running++;
      inFlight.push(running);
      await Promise.resolve();
      running--;
      if (candidate.id === 1) throw new Error('boom');
      return candidate.id * 10;
    });

    const outcomes = await submitThrottled(candidates, submit);

    expect(Math.max(...inFlight)).toBeLessThanOrEqual(3);
    expect(submit.mock.calls.map(([, deferred]) => deferred)).toEqual([false, false, false, true, true]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(outcomes[1]).toMatchObject({ status: 'rejected', destinationRefusal: false });
  });

  it('stops later candidates of a format after a destination refusal without stopping other formats', async () => {
    const candidates = [
      { id: 0, format: 'ebook' as const },
      { id: 1, format: 'audiobook' as const },
      { id: 2, format: 'audiobook' as const },
      { id: 3, format: 'ebook' as const },
      { id: 4, format: 'audiobook' as const },
    ];
    const submit = vi
      .fn()
      .mockImplementation((candidate: { format: string }) => (candidate.format === 'ebook' ? Promise.reject(refusal()) : Promise.resolve('ok')));

    const outcomes = await submitThrottled(candidates, submit);

    expect(submit).toHaveBeenCalledTimes(4);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'stopped', 'fulfilled']);
    expect(outcomes[0]).toMatchObject({ destinationRefusal: true });
  });
});

describe('per-work auto format gate', () => {
  it('blocks both formats while paused even with explicit overrides', () => {
    const configured = monitor({ paused: true });
    const target = work({ autoDownload: { ebook: true, audiobook: true } });
    expect(isAutoFormat(configured, target, 'ebook')).toBe(false);
    expect(isAutoFormat(configured, target, 'audiobook')).toBe(false);
  });
});
