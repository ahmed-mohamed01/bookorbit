import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSerialIllustratorBackfillBook } from './web-serials.repository';
import { WebSerialsIllustratorBackfillService } from './web-serials-illustrator-backfill.service';

class TestBackfill extends WebSerialsIllustratorBackfillService {
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

function book(bookId: number, matchId: string, hasPencillers = false): WebSerialIllustratorBackfillBook {
  return { bookId, matchKey: `mb:${matchId}`, kind: 'novel', hasPencillers };
}

function setup(options: { rows?: WebSerialIllustratorBackfillBook[]; done?: boolean; enabled?: boolean; locked?: number[]; paused?: boolean } = {}) {
  const rows = options.rows ?? [];
  const repo = {
    isIllustratorBackfillDone: vi.fn().mockResolvedValue(options.done ?? false),
    markIllustratorBackfillDone: vi.fn().mockResolvedValue(undefined),
    findIllustratorBackfillBooks: vi.fn((after: number) => Promise.resolve(rows.filter((row) => row.bookId > after))),
    bookHasPencillers: vi.fn((bookId: number) => Promise.resolve(rows.find((row) => row.bookId === bookId)?.hasPencillers ?? false)),
  };
  const settings = { getSettings: vi.fn().mockResolvedValue({ lookup: { enabled: options.enabled ?? true } }) };
  const artists: Record<string, string[]> = { '1': ['Illustrator One'], '2': ['Illustrator Two'] };
  const lookup = {
    isPaused: vi.fn().mockReturnValue(options.paused ?? false),
    getMatch: vi.fn((id: string) => Promise.resolve(artists[id] ? { id, artists: artists[id] } : null)),
  };
  const metadata = { upsertComicMetadata: vi.fn().mockResolvedValue(undefined) };
  const locks = { getBookIdsWithLockedField: vi.fn(() => Promise.resolve(new Set(options.locked ?? []))) };
  const service = new TestBackfill(
    repo as never,
    { ready: Promise.resolve({ requeued: [] }) } as never,
    settings as never,
    lookup as never,
    metadata as never,
    locks as never,
  );
  return { service, repo, lookup, metadata, locks };
}

describe('WebSerialsIllustratorBackfillService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills empty pencillers from the MangaBaka series, looking each series up once', async () => {
    const { service, repo, lookup, metadata } = setup({ rows: [book(10, '1'), book(11, '1'), book(12, '2')] });

    await expect(service.run()).resolves.toBe('done');

    expect(lookup.getMatch.mock.calls.map((call) => call[0])).toEqual(['1', '2']);
    expect(metadata.upsertComicMetadata.mock.calls).toEqual([
      [10, { pencillers: ['Illustrator One'] }],
      [11, { pencillers: ['Illustrator One'] }],
      [12, { pencillers: ['Illustrator Two'] }],
    ]);
    expect(repo.markIllustratorBackfillDone).toHaveBeenCalledTimes(1);
    const end = logSpy.mock.calls.map((call) => call[0] as string).find((line) => line.includes('[end]'))!;
    expect(end).toContain('[web_serials.illustrator_backfill] [end]');
    expect(end).toContain('booksChecked=3 booksUpdated=3');
    expect(end).toContain('lookupsFailed=0');
  });

  it('never overwrites pencillers that are set or locked', async () => {
    const { service, lookup, metadata } = setup({ rows: [book(10, '1', true), book(11, '2')], locked: [11] });

    await expect(service.run()).resolves.toBe('done');

    expect(lookup.getMatch).not.toHaveBeenCalled();
    expect(metadata.upsertComicMetadata).not.toHaveBeenCalled();
  });

  it('skips a series whose lookup fails and carries on with the rest', async () => {
    const { service, repo, metadata } = setup({ rows: [book(10, '404'), book(11, '2')] });

    await expect(service.run()).resolves.toBe('done');

    expect(metadata.upsertComicMetadata.mock.calls).toEqual([[11, { pencillers: ['Illustrator Two'] }]]);
    expect(repo.markIllustratorBackfillDone).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.map((call) => call[0] as string).find((line) => line.includes('[end]'))).toContain('lookupsFailed=1');
  });

  it('runs once per install', async () => {
    const { service, repo, lookup } = setup({ rows: [book(10, '1')], done: true });

    await expect(service.run()).resolves.toBe('already_done');

    expect(repo.findIllustratorBackfillBooks).not.toHaveBeenCalled();
    expect(lookup.getMatch).not.toHaveBeenCalled();
  });

  it('skips without marking done while MangaBaka is switched off', async () => {
    const { service, repo, lookup } = setup({ rows: [book(10, '1')], enabled: false });

    await expect(service.run()).resolves.toBe('lookup_disabled');

    expect(lookup.getMatch).not.toHaveBeenCalled();
    expect(repo.markIllustratorBackfillDone).not.toHaveBeenCalled();
  });

  it('stops without marking done while the lookup breaker is open, so the next boot resumes', async () => {
    const { service, repo, lookup } = setup({ rows: [book(10, '1')], paused: true });

    await expect(service.run()).resolves.toBe('interrupted');

    expect(lookup.getMatch).not.toHaveBeenCalled();
    expect(repo.markIllustratorBackfillDone).not.toHaveBeenCalled();
  });
});
