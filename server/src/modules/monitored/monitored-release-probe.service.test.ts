import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfigurations } from '@bookorbit/types';

import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import { MonitoredReleaseProbeService } from './monitored-release-probe.service';
import type { ReleaseProbeRow, ReleaseProbeWork } from './monitored-release-probe-store.service';

function config(patch: Partial<ProviderConfigurations['amazon']> = {}): ProviderConfigurations {
  return {
    hardcover: { enabled: true, apiKey: 'hc-key' },
    amazon: { enabled: false, domain: 'amazon.com', cookie: '', ...patch },
  } as ProviderConfigurations;
}

function release(format: ReleaseProbeRow['format'], patch: Partial<ReleaseProbeRow> = {}): ReleaseProbeRow {
  return {
    workId: 'work-1',
    monitorAuthorId: 'monitor-1',
    ownerUserId: 1,
    format,
    status: 'pending',
    releaseDate: null,
    datePrecision: null,
    lastReleaseDate: null,
    lastDatePrecision: null,
    lastDateSource: null,
    previousReleaseDate: null,
    previousDatePrecision: null,
    dateChangedAt: null,
    autoReleaseDate: null,
    autoDatePrecision: null,
    autoSource: null,
    autoChangedAt: null,
    source: null,
    asin: null,
    checkedAt: null,
    nextCheckAt: new Date('2026-09-18T00:00:00.000Z'),
    attempts: 0,
    lastErrorClass: null,
    ...patch,
  };
}

function work(patch: Partial<ReleaseProbeWork> = {}): ReleaseProbeWork {
  return {
    id: 'work-1',
    monitorAuthorId: 'monitor-1',
    ownerUserId: 1,
    authorName: 'James S. A. Corey',
    title: 'The Infinite Extent',
    ebookReleaseDate: '2026-09-10',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2026-09-10',
    audioDatePrecision: 'day',
    sources: ['hardcover', 'audible'],
    ownedFormats: [],
    hardcoverSlug: 'the-infinite-extent',
    audibleAsin: 'B012345678',
    releases: [release('ebook'), release('audiobook')],
    ...patch,
  };
}

function hardcoverBook(slug: string, editions: Array<Record<string, unknown>>) {
  return {
    slug,
    release_date: '2026-09-10',
    editions: editions.map((edition) => ({
      reading_format_id: null,
      release_date: null,
      asin: null,
      isbn_13: null,
      isbn_10: null,
      users_count: 0,
      language: { code2: 'en' },
      ...edition,
    })),
  };
}

function harness(
  options: {
    works?: ReleaseProbeWork[];
    settings?: { releaseProbeEnabled: boolean };
    configs?: Map<number, ProviderConfigurations>;
    hardcoverResult?: unknown[];
    hardcoverError?: unknown;
    appleResult?: { releaseDate: string; trackId: number } | null;
    appleError?: unknown;
  } = {},
) {
  const works = options.works ?? [work()];
  const store = {
    findDueWorks: vi.fn().mockResolvedValue(works),
    findPendingWorksForMonitor: vi.fn().mockResolvedValue(works),
    findWork: vi.fn().mockResolvedValue(works[0] ?? null),
    enrol: vi.fn().mockResolvedValue(works.length * 2),
    prune: vi.fn().mockResolvedValue(undefined),
    saveOutcome: vi.fn((_work: unknown, outcome: Record<string, unknown>) =>
      Promise.resolve({ ledgerResets: 0, appliedFormats: Object.keys(outcome), skippedFormats: [] }),
    ),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(0),
    clearUserReleaseDate: vi.fn().mockResolvedValue(true),
  };
  const hardcover = {
    fetchEditionsBySlugs: options.hardcoverError
      ? vi.fn().mockRejectedValue(options.hardcoverError)
      : vi.fn().mockResolvedValue(options.hardcoverResult ?? [hardcoverBook('the-infinite-extent', [])]),
  };
  const applePausedUntil = vi.fn().mockReturnValue(0);
  const apple = {
    pausedUntil: applePausedUntil,
    searchEbook: options.appleError
      ? vi.fn().mockImplementation(() => {
          if (options.appleError instanceof ProviderThrottleError) applePausedUntil.mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
          const error = options.appleError instanceof Error ? options.appleError : new Error(String(options.appleError));
          return Promise.reject(error);
        })
      : vi.fn().mockResolvedValue(options.appleResult ?? null),
  };
  const amazon = { pausedUntil: vi.fn().mockReturnValue(0), fetchProductPage: vi.fn(), fetchSearchPage: vi.fn() };
  const providerConfigs = {
    forUser: vi.fn((owner: number) => Promise.resolve(options.configs?.get(owner) ?? config())),
  };
  const settings = { getMonitoredSettings: vi.fn().mockResolvedValue(options.settings ?? { releaseProbeEnabled: true }) };
  const service = new MonitoredReleaseProbeService(
    store as never,
    hardcover as never,
    apple as never,
    amazon as never,
    providerConfigs as never,
    settings as never,
  );
  return { service, store, hardcover, apple, amazon, providerConfigs, settings };
}

describe('MonitoredReleaseProbeService', () => {
  it('does no work when the feature is disabled', async () => {
    const { service, store } = harness({ settings: { releaseProbeEnabled: false } });

    await service.runScheduledProbe();

    expect(store.findDueWorks).not.toHaveBeenCalled();
    expect(store.clearAll).toHaveBeenCalledOnce();
  });

  it('self-heals rows recreated after the probe was disabled', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = harness({ settings: { releaseProbeEnabled: false } });
    store.clearAll.mockResolvedValue(2);

    await service.runScheduledProbe();

    expect(store.clearAll).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[monitored\.release_probe\.disabled\] \[end\] durationMs=\d+ deleted=2 - release probe rows removed$/),
    );
    log.mockRestore();
  });

  it('guards overlapping scheduled sweeps', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let resolve!: (value: ReleaseProbeWork[]) => void;
    const { service, store } = harness({ works: [] });
    store.findDueWorks.mockImplementationOnce(() => new Promise<ReleaseProbeWork[]>((done) => (resolve = done)));

    const first = service.runScheduledProbe();
    await vi.waitFor(() => expect(store.findDueWorks).toHaveBeenCalledOnce());
    await service.runScheduledProbe();
    resolve([]);
    await first;

    expect(store.findDueWorks).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[monitored.release_probe.sweep] [end] durationMs=0 skipped=true - previous run still in flight');
    log.mockRestore();
  });

  it('records owner works as failed when Hardcover is not configured', async () => {
    const disabled = config();
    disabled.hardcover = { enabled: false, apiKey: '' };
    const { service, store, hardcover } = harness({ configs: new Map([[1, disabled]]) });

    await service.runScheduledProbe();

    expect(store.recordFailure).toHaveBeenCalledWith(['work-1'], 'HardcoverNotConfigured', expect.any(Date));
    expect(hardcover.fetchEditionsBySlugs).not.toHaveBeenCalled();
    expect(store.saveOutcome).not.toHaveBeenCalled();
  });

  it('isolates a Hardcover batch failure to its owner', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const first = work({ id: 'work-1', ownerUserId: 1, hardcoverSlug: 'one' });
    const second = work({ id: 'work-2', ownerUserId: 2, hardcoverSlug: null });
    const { service, store, hardcover } = harness({ works: [first, second] });
    hardcover.fetchEditionsBySlugs.mockRejectedValueOnce(new TypeError('owner one failed')).mockResolvedValueOnce([]);

    await service.runScheduledProbe();

    expect(store.recordFailure).toHaveBeenCalledWith(['work-1'], 'TypeError', expect.any(Date));
    expect(store.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'work-2' }), expect.anything(), expect.any(Date), expect.anything());
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.hardcover\] \[fail\] userId=1 works=1 durationMs=\d+ errorClass=TypeError error="owner one failed" - Hardcover release probe failed$/,
      ),
    );
    warn.mockRestore();
  });

  it('records a slug the Hardcover batch never answered for instead of deciding it blind', async () => {
    const missing = work({ hardcoverSlug: 'not-in-the-answer' });
    const { service, store } = harness({ works: [missing] });

    await service.runScheduledProbe();

    expect(store.recordFailure).toHaveBeenCalledWith(['work-1'], 'HardcoverBookMissing', expect.any(Date));
    expect(store.saveOutcome).not.toHaveBeenCalled();
  });

  it('still decides a work that has no Hardcover slug at all', async () => {
    const slugless = work({ hardcoverSlug: null, audibleAsin: null });
    const { service, store } = harness({ works: [slugless] });

    await service.runScheduledProbe();

    expect(store.recordFailure).not.toHaveBeenCalled();
    expect(store.saveOutcome).toHaveBeenCalledOnce();
  });

  it('logs and records a failure isolated at the owner boundary', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, store, providerConfigs } = harness();
    providerConfigs.forUser.mockRejectedValueOnce(new RangeError('config failed'));

    await service.runScheduledProbe();

    expect(store.recordFailure).toHaveBeenCalledWith(['work-1'], 'RangeError', expect.any(Date));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.owner\] \[fail\] userId=1 works=1 durationMs=\d+ errorClass=RangeError error="config failed" - release probe owner failed$/,
      ),
    );
    warn.mockRestore();
  });

  it('clears the inherited ebook date for The Infinite Extent while preserving Audible audio provenance', async () => {
    const hardcoverResult = [
      hardcoverBook('the-infinite-extent', [
        { reading_format_id: 2, release_date: '2026-09-10', asin: 'B000000001', users_count: 20 },
        { reading_format_id: 2, release_date: '2026-09-10', asin: 'B000000002', users_count: 10 },
        { reading_format_id: 4, release_date: '2027-01-10', users_count: 0 },
      ]),
    ];
    const { service, store } = harness({ hardcoverResult });

    await service.runScheduledProbe();

    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.ebook.decision).toMatchObject({ status: 'expected', releaseDate: '2027-01-10', source: 'hardcover_edition', overlay: 'clear' });
    expect(outcome.audiobook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-09-10', source: 'audible' });
  });

  it('dates Blightfall from Apple only after Hardcover leaves the ebook unlisted', async () => {
    const blightfall = work({
      title: 'Blightfall',
      authorName: 'Some Author',
      ebookReleaseDate: null,
      audioReleaseDate: null,
      sources: ['hardcover'],
      hardcoverSlug: 'blightfall',
      audibleAsin: null,
    });
    const hardcoverResult = [hardcoverBook('blightfall', [{ reading_format_id: 1, release_date: '2026-08-01', isbn_10: '123456789X' }])];
    const { service, store, apple } = harness({ works: [blightfall], hardcoverResult, appleResult: { releaseDate: '2026-09-01', trackId: 9 } });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledWith('Blightfall', 'Some Author', 'us');
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-09-01', source: 'apple' });
  });

  it('keeps stored Apple evidence when the Apple budget is unavailable', async () => {
    const storedApple = release('ebook', { status: 'dated', releaseDate: '2026-10-10', datePrecision: 'day', source: 'apple' });
    const probeWork = work({ releases: [storedApple, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });
    Reflect.set(service, 'newRun', (now: Date) => ({
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: 0, owner: 0 },
      amazon: { tick: 0, owner: 0 },
      stats: { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 },
      disabled: false,
    }));

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-10-10', source: 'apple' });
  });

  it('reschedules an ebook that only missed Apple because the budget was spent', async () => {
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null });
    const { service, store } = harness({ works: [probeWork] });
    Reflect.set(service, 'newRun', (now: Date) => ({
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: 0, owner: 0 },
      amazon: { tick: 0, owner: 0 },
      stats: { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 },
      disabled: false,
    }));

    await service.runScheduledProbe();

    const call = store.saveOutcome.mock.calls[0];
    const nextCheckAt = call?.[1].ebook.nextCheckAt as Date;
    expect(call?.[1].ebook.decision).toMatchObject({ status: 'unlisted' });
    expect(nextCheckAt.getTime() - (call?.[2] as Date).getTime()).toBe(60 * 60 * 1000);
  });

  it('keeps stored Apple evidence when the Apple search itself came back empty', async () => {
    const storedApple = release('ebook', {
      status: 'dated',
      releaseDate: '2026-10-10',
      datePrecision: 'day',
      source: 'apple',
      checkedAt: new Date(Date.now() - 13 * 86_400_000),
    });
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null, releases: [storedApple, release('audiobook')] });
    const { service, store, apple } = harness({ works: [probeWork], appleResult: null });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-10-10', source: 'apple' });
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.rescheduleOnly).toBe(true);
  });

  it('lets a missing Apple result replace confirmed evidence after the grace period', async () => {
    const storedApple = release('ebook', {
      status: 'dated',
      releaseDate: '2026-10-10',
      datePrecision: 'day',
      source: 'apple',
      checkedAt: new Date(Date.now() - 15 * 86_400_000),
    });
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null, releases: [storedApple, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork], appleResult: null });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'unlisted', source: null, overlay: 'clear' });
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.rescheduleOnly).toBe(false);
  });

  it('keeps recent Audible evidence when a refresh no longer carries an Audible date', async () => {
    const storedAudible = release('audiobook', {
      status: 'dated',
      releaseDate: '2026-10-10',
      datePrecision: 'day',
      source: 'audible',
      checkedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const probeWork = work({
      hardcoverSlug: null,
      sources: ['hardcover'],
      audioReleaseDate: null,
      audioDatePrecision: null,
      releases: [release('ebook'), storedAudible],
    });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].audiobook).toMatchObject({
      decision: { status: 'dated', releaseDate: '2026-10-10', source: 'audible', overlay: 'set' },
      rescheduleOnly: true,
    });
  });

  it('replaces stored Apple evidence when the Apple search returns a new date', async () => {
    const storedApple = release('ebook', { status: 'dated', releaseDate: '2026-10-10', datePrecision: 'day', source: 'apple' });
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null, releases: [storedApple, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork], appleResult: { releaseDate: '2026-11-24', trackId: 4 } });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-11-24', source: 'apple' });
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.rescheduleOnly).toBe(false);
  });

  it('uses a stored expected hint when the catalog column is null', async () => {
    const hint = release('ebook', { status: 'expected', releaseDate: '2027-02', datePrecision: 'month', source: null });
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null, releases: [hint, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'expected', releaseDate: '2027-02', precision: 'month' });
  });

  it('uses the hint enrolment parked on a pending row', async () => {
    const hint = release('ebook', { status: 'pending', releaseDate: '2027-02-08', datePrecision: 'day', source: null });
    const probeWork = work({ ebookReleaseDate: null, ebookDatePrecision: null, releases: [hint, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({
      status: 'expected',
      releaseDate: '2027-02-08',
      source: null,
      overlay: 'clear',
    });
  });

  it('treats a non-day audio date as a hint rather than an Audible listing', async () => {
    const probeWork = work({ audioReleaseDate: '2027', audioDatePrecision: 'year' });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].audiobook.decision).toMatchObject({
      status: 'expected',
      releaseDate: '2027',
      precision: 'year',
      source: null,
      overlay: 'clear',
    });
  });

  it('stops Apple requests after a throttle response', async () => {
    const works = Array.from({ length: 3 }, (_, index) => work({ id: `work-${index}`, hardcoverSlug: null }));
    const { service, apple, store } = harness({ works, appleError: new ProviderThrottleError(undefined, 'HTTP 429') });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    expect(store.saveOutcome).toHaveBeenCalledTimes(3);
  });

  it('keeps Apple paused across later ticks and names the work in the failure line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const probeWork = work({ id: 'work-1', hardcoverSlug: null });
    const { service, apple } = harness({ works: [probeWork], appleError: new ProviderThrottleError(undefined, 'HTTP 429') });

    await service.runScheduledProbe();
    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.apple\] \[fail\] workId="work-1" userId=1 durationMs=\d+ errorClass=ProviderThrottleError error=".+" - Apple tier paused$/,
      ),
    );
    warn.mockRestore();
  });

  it('does not spend Apple budget while the client is paused and schedules at the client deadline', async () => {
    const pausedUntil = Date.now() + 4 * 60 * 60 * 1000;
    const { service, apple, store } = harness({ works: [work({ hardcoverSlug: null })] });
    apple.pausedUntil.mockReturnValue(pausedUntil);

    await service.runScheduledProbe();

    expect(apple.searchEbook).not.toHaveBeenCalled();
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.nextCheckAt).toEqual(new Date(pausedUntil));
  });

  it('splits the per-tick Apple budget across owners', async () => {
    const works = Array.from({ length: 20 }, (_, index) =>
      work({
        id: `work-${index}`,
        ownerUserId: index < 10 ? 1 : 2,
        authorName: index < 10 ? 'First Owner' : 'Second Owner',
        hardcoverSlug: null,
        audibleAsin: null,
      }),
    );
    const { service, apple } = harness({ works });

    await service.runScheduledProbe();

    const authors = apple.searchEbook.mock.calls.map((call) => call[1] as string);
    expect(authors.filter((author) => author === 'First Owner')).toHaveLength(8);
    expect(authors.filter((author) => author === 'Second Owner')).toHaveLength(7);
  });

  it('lets a busy owner use the Apple budget a small owner leaves unspent', async () => {
    const works = Array.from({ length: 21 }, (_, index) =>
      work({
        id: `work-${index}`,
        ownerUserId: index === 0 ? 2 : 1,
        authorName: index === 0 ? 'Small Owner' : 'Busy Owner',
        hardcoverSlug: null,
        audibleAsin: null,
      }),
    );
    const { service, apple } = harness({ works });

    await service.runScheduledProbe();

    const authors = apple.searchEbook.mock.calls.map((call) => call[1] as string);
    expect(authors.filter((author) => author === 'Small Owner')).toHaveLength(1);
    expect(authors.filter((author) => author === 'Busy Owner')).toHaveLength(14);
  });

  it('caps Apple requests across the whole scheduled tick', async () => {
    const works = Array.from({ length: 17 }, (_, index) => work({ id: `work-${index}`, hardcoverSlug: null, audibleAsin: null }));
    const { service, apple, store } = harness({ works });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledTimes(15);
    expect(store.saveOutcome).toHaveBeenCalledTimes(17);
  });

  it('isolates a non-throttle Apple failure to one work', async () => {
    const works = [work({ id: 'work-1', hardcoverSlug: null }), work({ id: 'work-2', hardcoverSlug: null })];
    const { service, apple, store } = harness({ works });
    apple.searchEbook.mockRejectedValueOnce(new TypeError('Apple failed')).mockResolvedValueOnce(null);

    await service.runScheduledProbe();

    expect(store.recordFailure).toHaveBeenCalledWith(['work-1'], 'TypeError', expect.any(Date));
    expect(store.saveOutcome).toHaveBeenCalledTimes(1);
    expect(store.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'work-2' }), expect.anything(), expect.any(Date), expect.anything());
  });

  it('runs only the Hardcover tier for pending rows during a refresh pass', async () => {
    const { service, store, apple, amazon } = harness();

    await service.enrolAndProbe(
      {
        id: 'monitor-1',
        ownerUserId: 1,
        authorName: 'Author',
        localAuthorId: null,
        providerIds: {},
        formats: {
          ebook: { mode: 'notify', libraryId: null, folderId: null },
          audiobook: { mode: 'notify', libraryId: null, folderId: null },
        },
        paused: false,
        addedAt: '2026-01-01T00:00:00.000Z',
        lastRefreshedAt: null,
      },
      config({ enabled: true, cookie: 'cookie' }),
    );

    expect(store.enrol).not.toHaveBeenCalled();
    expect(store.prune).toHaveBeenCalled();
    expect(apple.searchEbook).not.toHaveBeenCalled();
    expect(amazon.fetchProductPage).not.toHaveBeenCalled();
    expect(Object.keys(store.saveOutcome.mock.calls[0]?.[1])).toEqual(['ebook', 'audiobook']);
  });

  it('leaves non-pending rows for the scheduled sweep during a refresh pass', async () => {
    const probeWork = work({
      releases: [release('ebook', { status: 'dated', releaseDate: '2026-10-01', datePrecision: 'day', source: 'apple' }), release('audiobook')],
    });
    const { service, store } = harness({ works: [probeWork] });

    await service.enrolAndProbe({ id: 'monitor-1', ownerUserId: 1 } as never, config());

    expect(Object.keys(store.saveOutcome.mock.calls[0]?.[1])).toEqual(['audiobook']);
  });

  it('does not enrol during refresh when disabled', async () => {
    const { service, store } = harness({ settings: { releaseProbeEnabled: false } });

    await service.enrolAndProbe({ id: 'monitor-1' } as never, config());

    expect(store.enrol).not.toHaveBeenCalled();
  });

  it('keeps pre-Amazon decisions and pauses later Amazon use after throttling', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const { service, amazon, store } = harness({ configs: new Map([[1, enabled]]) });
    amazon.fetchProductPage.mockImplementation(() => {
      amazon.pausedUntil.mockReturnValue(Date.now() + 6 * 60 * 60 * 1000);
      return Promise.reject(new ProviderThrottleError(undefined, 'bot challenge'));
    });

    await service.runScheduledProbe();
    await service.runScheduledProbe();

    expect(amazon.fetchProductPage).toHaveBeenCalledOnce();
    expect(store.saveOutcome).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.amazon\] \[fail\] workId="work-1" userId=1 durationMs=\d+ errorClass=ProviderThrottleError error=".+" - amazon tier paused$/,
      ),
    );
    warn.mockRestore();
  });

  it('does not spend Amazon budget while the client is paused', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const { service, amazon } = harness({ configs: new Map([[1, enabled]]) });
    amazon.pausedUntil.mockReturnValue(Date.now() + 6 * 60 * 60 * 1000);

    await service.runScheduledProbe();

    expect(amazon.fetchProductPage).not.toHaveBeenCalled();
    expect(amazon.fetchSearchPage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/amazonPages=0/));
    log.mockRestore();
  });

  it('walks past a missing Amazon seed and uses the next matching family page', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const hardcoverResult = [
      hardcoverBook('the-infinite-extent', [
        { reading_format_id: 4, release_date: '2027-01-10', users_count: 0 },
        { reading_format_id: 2, release_date: '2026-09-10', asin: 'B000000001', users_count: 20 },
        { reading_format_id: 2, release_date: '2026-09-10', asin: 'B000000002', users_count: 10 },
      ]),
    ];
    const { service, amazon, store } = harness({ configs: new Map([[1, enabled]]), hardcoverResult });
    amazon.fetchProductPage.mockResolvedValueOnce({ notFound: true }).mockResolvedValueOnce({
      html: `<input id="ASIN" value="B000000002"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></ul>`,
    });

    await service.runScheduledProbe();

    expect(amazon.fetchProductPage).toHaveBeenNthCalledWith(1, 'B000000001', enabled.amazon, undefined);
    expect(amazon.fetchProductPage).toHaveBeenNthCalledWith(2, 'B000000002', enabled.amazon, undefined);
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-10-01', source: 'amazon' });
  });

  it('accepts a matching Amazon seed page', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({ hardcoverSlug: null });
    const { service, amazon, store } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></ul>`,
    });

    await service.runScheduledProbe();

    expect(amazon.fetchSearchPage).not.toHaveBeenCalled();
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', releaseDate: '2026-10-01', source: 'amazon' });
  });

  it('does not fetch a linked print swatch page', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({ hardcoverSlug: null });
    const { service, amazon } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li><li class="swatchElement"><a href="/dp/1234567890"><span class="a-button-text">Paperback</span></a></li></ul>`,
    });

    await service.runScheduledProbe();

    expect(amazon.fetchProductPage).toHaveBeenCalledOnce();
    expect(amazon.fetchProductPage.mock.calls.some(([asin]) => asin === '1234567890')).toBe(false);
  });

  it('returns unknown Amazon evidence when a wanted linked format cannot be fetched within budget', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const { service, amazon } = harness();
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Audible Audiobook</span></li><li class="swatchElement"><a href="/dp/B000000099"><span class="a-button-text">Kindle Edition</span></a></li></ul>`,
    });
    const expected = { status: 'expected', releaseDate: null, precision: null, source: null, asin: null, overlay: 'clear' } as const;
    const dated = { status: 'dated', releaseDate: '2026-10-01', precision: 'day', source: 'audible', asin: null, overlay: 'set' } as const;
    const now = new Date();
    const run = {
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: 0, owner: 0 },
      amazon: { tick: 1, owner: 1 },
      stats: { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 },
      disabled: false,
    };

    const evidence = await Reflect.apply(
      (service as unknown as { amazonEvidence: (...args: unknown[]) => Promise<unknown> }).amazonEvidence,
      service,
      [work(), null, { ebook: expected, audiobook: dated }, enabled, run],
    );

    expect(evidence).toBeUndefined();
    expect(amazon.fetchProductPage).toHaveBeenCalledOnce();
    expect(run.stats.amazonPages).toBe(1);
  });

  it('records a null Amazon date when the wanted linked format page was fetched', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const { service, amazon } = harness();
    amazon.fetchProductPage
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B012345678"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Audible Audiobook</span></li><li class="swatchElement"><a href="/dp/B000000099"><span class="a-button-text">Kindle Edition</span></a></li></ul>`,
      })
      .mockResolvedValueOnce({
        html: `<input id="ASIN" value="B000000099"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle Edition</span></li></ul>`,
      });
    const expected = { status: 'expected', releaseDate: null, precision: null, source: null, asin: null, overlay: 'clear' } as const;
    const dated = { status: 'dated', releaseDate: '2026-10-01', precision: 'day', source: 'audible', asin: null, overlay: 'set' } as const;
    const now = new Date();
    const run = {
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: 0, owner: 0 },
      amazon: { tick: 2, owner: 2 },
      stats: { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 },
      disabled: false,
    };

    const evidence = await Reflect.apply(
      (service as unknown as { amazonEvidence: (...args: unknown[]) => Promise<unknown> }).amazonEvidence,
      service,
      [work(), null, { ebook: expected, audiobook: dated }, enabled, run],
    );

    expect(evidence).toMatchObject({ listing: 'found', formats: { ebook: { asin: 'B000000099', date: null } } });
    expect(amazon.fetchProductPage).toHaveBeenCalledTimes(2);
    expect(run.stats.amazonPages).toBe(2);
  });

  it('matches an Amazon search card whose title contains the author byline', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({ hardcoverSlug: null, audibleAsin: null });
    const { service, amazon, store } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchSearchPage.mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B000000003"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B000000003">Kindle</a></div>`,
    });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B000000003"><span id="productTitle">The Infinite Extent</span><div id="bylineInfo">James S. A. Corey</div><div id="availability">Released on November 2, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></ul>`,
    });

    await service.runScheduledProbe();

    expect(amazon.fetchSearchPage).toHaveBeenCalledOnce();
    expect(amazon.fetchProductPage).toHaveBeenCalledWith('B000000003', enabled.amazon, undefined);
    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'dated', source: 'amazon' });
  });

  it('keeps pre-Amazon evidence when a matched search result fails product verification', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({ hardcoverSlug: null, audibleAsin: null });
    const { service, amazon, store } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchSearchPage.mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B000000003"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B000000003">Kindle</a></div>`,
    });
    amazon.fetchProductPage.mockResolvedValue({
      html: `<input id="ASIN" value="B000000003"><span id="productTitle">A Different Book</span><div id="bylineInfo">James S. A. Corey</div>`,
    });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'expected', source: null });
  });

  it('records an Amazon search miss as an unlisted family', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({ hardcoverSlug: null, audibleAsin: null });
    const { service, amazon, store } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook.decision).toMatchObject({ status: 'unlisted', source: 'amazon_search' });
  });

  it('asks Amazon whenever the provider is enabled, cookie or not, and never when it is off', async () => {
    const probeWork = work({ hardcoverSlug: null, audibleAsin: null });
    const withoutCookie = harness({ works: [probeWork], configs: new Map([[1, config({ enabled: true, cookie: '' })]]) });
    withoutCookie.amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });
    const switchedOff = harness({ works: [probeWork], configs: new Map([[1, config({ enabled: false, cookie: 'cookie' })]]) });

    await withoutCookie.service.runScheduledProbe();
    await switchedOff.service.runScheduledProbe();

    expect(withoutCookie.amazon.fetchSearchPage).toHaveBeenCalledOnce();
    expect(switchedOff.amazon.fetchSearchPage).not.toHaveBeenCalled();
    expect(switchedOff.amazon.fetchProductPage).not.toHaveBeenCalled();
  });

  it('caps Amazon page fetches across the whole scheduled tick', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const works = Array.from({ length: 25 }, (_, index) => work({ id: `work-${index}`, hardcoverSlug: null, audibleAsin: null }));
    const { service, amazon, store } = harness({ works, configs: new Map([[1, enabled]]) });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.runScheduledProbe();

    expect(amazon.fetchSearchPage).toHaveBeenCalledTimes(20);
    expect(store.saveOutcome).toHaveBeenCalledTimes(25);
  });

  it('caps Amazon at six pages for one work while leaving the run budget for the next work', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const first = work({ id: 'work-1', audibleAsin: null });
    const second = work({ id: 'work-2', hardcoverSlug: null, audibleAsin: null });
    const hardcoverResult = [
      hardcoverBook(
        'the-infinite-extent',
        Array.from({ length: 8 }, (_, index) => ({ reading_format_id: 4, asin: `B00000000${index}`, release_date: null })),
      ),
    ];
    const { service, amazon } = harness({ works: [first, second], configs: new Map([[1, enabled]]), hardcoverResult });
    amazon.fetchProductPage.mockResolvedValue({ notFound: true });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.runScheduledProbe();

    expect(amazon.fetchProductPage).toHaveBeenCalledTimes(6);
    expect(amazon.fetchSearchPage).toHaveBeenCalledOnce();
  });

  it('splits the per-tick Amazon budget across owners', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const works = Array.from({ length: 25 }, (_, index) =>
      work({
        id: `work-${index}`,
        ownerUserId: index < 13 ? 1 : 2,
        authorName: index < 13 ? 'First Owner' : 'Second Owner',
        hardcoverSlug: null,
        audibleAsin: null,
      }),
    );
    const { service, amazon } = harness({
      works,
      configs: new Map([
        [1, enabled],
        [2, enabled],
      ]),
    });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.runScheduledProbe();

    const queries = amazon.fetchSearchPage.mock.calls.map((call) => call[0] as string);
    expect(queries.filter((query) => query.endsWith('First Owner'))).toHaveLength(10);
    expect(queries.filter((query) => query.endsWith('Second Owner'))).toHaveLength(10);
  });

  it('restates a date the owner chose while still asking what would have dated the format', async () => {
    const chosen = release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ ebookReleaseDate: '2027-03-04', ebookDatePrecision: 'day', releases: [chosen, release('audiobook')] });
    const { service, store, apple } = harness({ works: [probeWork], appleResult: { releaseDate: '2027-05-20', trackId: 1 } });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.ebook.decision).toEqual({
      status: 'dated',
      releaseDate: '2027-03-04',
      precision: 'day',
      source: 'user',
      asin: null,
      overlay: 'set',
    });
    expect(outcome.ebook.rescheduleOnly).toBe(true);
    expect(outcome.ebook.suggested).toEqual({ releaseDate: '2027-05-20', precision: 'day', source: 'apple' });
    // The other format of the same work is still the probe's to decide.
    expect(outcome.audiobook.decision).toMatchObject({ status: 'dated', source: 'audible' });
  });

  it('takes no suggestion from an automatic decision that never landed on a date', async () => {
    const chosen = release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ ebookReleaseDate: '2027-03-04', ebookDatePrecision: 'day', releases: [chosen, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.ebook.decision).toMatchObject({ source: 'user', releaseDate: '2027-03-04' });
    expect(outcome.ebook.suggested).toBeUndefined();
  });

  it('never hands the owner their own audio date back as an Audible suggestion', async () => {
    const chosen = release('audiobook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ audioReleaseDate: '2027-03-04', audioDatePrecision: 'day', releases: [release('ebook'), chosen] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.audiobook.decision).toMatchObject({ source: 'user', releaseDate: '2027-03-04' });
    expect(outcome.audiobook.suggested).toBeUndefined();
  });

  it('suggests an audio date the catalog column no longer agrees with', async () => {
    const chosen = release('audiobook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ audioReleaseDate: '2027-06-01', audioDatePrecision: 'day', releases: [release('ebook'), chosen] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.audiobook.decision).toMatchObject({ source: 'user', releaseDate: '2027-03-04' });
    expect(outcome.audiobook.suggested).toEqual({ releaseDate: '2027-06-01', precision: 'day', source: 'audible' });
  });

  it('drops a stored Audible suggestion when the catalog no longer carries Audible evidence', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const chosen = release('audiobook', {
      status: 'dated',
      releaseDate: '2027-03-04',
      datePrecision: 'day',
      source: 'user',
      autoReleaseDate: '2027-06-01',
      autoDatePrecision: 'day',
      autoSource: 'audible',
    });
    const probeWork = work({
      audioReleaseDate: '2027-03-04',
      audioDatePrecision: 'day',
      sources: ['hardcover'],
      releases: [release('ebook'), chosen],
    });
    const hardcoverResult = [
      hardcoverBook('the-infinite-extent', [{ reading_format_id: 2, release_date: '2027-07-15', asin: 'B000000099', users_count: 20 }]),
    ];
    const { service, store } = harness({ works: [probeWork], hardcoverResult });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].audiobook.suggested).toEqual({
      releaseDate: '2027-07-15',
      precision: 'day',
      source: 'hardcover_edition',
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[monitored\.release_probe\.sweep\] \[end\] .+ suggested=1 ledgerResets=/));
    log.mockRestore();
  });

  it('keeps a stored Audible suggestion ahead of Hardcover while the catalog still carries Audible evidence', async () => {
    const chosen = release('audiobook', {
      status: 'dated',
      releaseDate: '2027-03-04',
      datePrecision: 'day',
      source: 'user',
      autoReleaseDate: '2027-06-01',
      autoDatePrecision: 'day',
      autoSource: 'audible',
    });
    const probeWork = work({
      audioReleaseDate: '2027-03-04',
      audioDatePrecision: 'day',
      sources: ['hardcover', 'audible'],
      releases: [release('ebook'), chosen],
    });
    const hardcoverResult = [
      hardcoverBook('the-infinite-extent', [{ reading_format_id: 2, release_date: '2027-07-15', asin: 'B000000099', users_count: 20 }]),
    ];
    const { service, store } = harness({ works: [probeWork], hardcoverResult });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].audiobook.suggested).toEqual({
      releaseDate: '2027-06-01',
      precision: 'day',
      source: 'audible',
    });
  });

  it('schedules a format the owner dated by what the automatic check found', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    try {
      const chosen = release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
      const probeWork = work({
        ebookReleaseDate: '2027-03-04',
        ebookDatePrecision: 'day',
        audioReleaseDate: null,
        audioDatePrecision: null,
        sources: ['hardcover'],
        releases: [chosen, release('audiobook')],
      });
      const { service, store } = harness({ works: [probeWork], appleResult: { releaseDate: '2026-09-25', trackId: 1 } });

      await service.runScheduledProbe();

      const [, outcome, now] = store.saveOutcome.mock.calls[0] ?? [];
      expect((outcome.ebook.nextCheckAt as Date).getTime() - (now as Date).getTime()).toBe(86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries Apple in one hour for a user row whose automatic check was deferred', async () => {
    const chosen = release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ ebookReleaseDate: '2027-03-04', ebookDatePrecision: 'day', releases: [chosen, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });
    Reflect.set(service, 'newRun', (now: Date) => ({
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: 0, owner: 0 },
      amazon: { tick: 0, owner: 0 },
      stats: { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 },
      disabled: false,
    }));

    await service.runScheduledProbe();

    const [, outcome, now] = store.saveOutcome.mock.calls[0] ?? [];
    expect((outcome.ebook.nextCheckAt as Date).getTime() - (now as Date).getTime()).toBe(60 * 60 * 1000);
  });

  it('deletes a user row instead of rescheduling it after the format becomes owned', async () => {
    const chosen = release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({ ownedFormats: ['ebook'], releases: [chosen, release('audiobook')] });
    const { service, store } = harness({ works: [probeWork] });

    await service.runScheduledProbe();

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook).toBeNull();
  });

  it('does not count an automatic date equal to the owner date as a suggestion', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const chosen = release('audiobook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' });
    const probeWork = work({
      audioReleaseDate: '2027-03-04',
      audioDatePrecision: 'day',
      sources: ['hardcover', 'audible'],
      releases: [release('ebook'), chosen],
    });

    await harness({ works: [probeWork] }).service.runScheduledProbe();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[monitored\.release_probe\.sweep\] \[end\] .+ suggested=0 ledgerResets=/));
    log.mockRestore();
  });

  it('counts a suggestion in the sweep summary only while its date is new to the row', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const chosen = { status: 'dated' as const, releaseDate: '2027-03-04', datePrecision: 'day' as const, source: 'user' as const };
    const fresh = work({ audioReleaseDate: '2027-06-01', audioDatePrecision: 'day', releases: [release('ebook'), release('audiobook', chosen)] });
    const seen = work({
      audioReleaseDate: '2027-06-01',
      audioDatePrecision: 'day',
      releases: [release('ebook'), release('audiobook', { ...chosen, autoReleaseDate: '2027-06-01' })],
    });

    await harness({ works: [fresh] }).service.runScheduledProbe();
    await harness({ works: [seen] }).service.runScheduledProbe();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[monitored\.release_probe\.sweep\] \[end\] .+ suggested=1 ledgerResets=/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[monitored\.release_probe\.sweep\] \[end\] .+ suggested=0 ledgerResets=/));
    log.mockRestore();
  });

  it('counts only formats the compare-and-swap applied', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = harness();
    store.saveOutcome.mockResolvedValue({ ledgerResets: 0, appliedFormats: ['audiobook'], skippedFormats: ['ebook'] });

    await service.runScheduledProbe();

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/\[monitored\.release_probe\.sweep\] \[end\] .+ dated=1 expected=0 unlisted=0 suggested=0 ledgerResets=0/),
    );
    log.mockRestore();
  });

  it('spends the Amazon tier on a format the owner dated when the automatic check needs it', async () => {
    const enabled = config({ enabled: true, cookie: 'cookie' });
    const probeWork = work({
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: null,
      audioDatePrecision: null,
      sources: ['hardcover'],
      hardcoverSlug: null,
      audibleAsin: null,
      releases: [
        release('ebook', { status: 'dated', releaseDate: '2027-01-01', datePrecision: 'day', source: 'user' }),
        release('audiobook', { status: 'dated', releaseDate: '2027-01-02', datePrecision: 'day', source: 'user' }),
      ],
    });
    const { service, store, apple, amazon } = harness({ works: [probeWork], configs: new Map([[1, enabled]]) });
    amazon.fetchSearchPage.mockResolvedValue({ html: '<main>No matching books</main>' });

    await service.runScheduledProbe();

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    expect(amazon.fetchSearchPage).toHaveBeenCalledOnce();
    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.ebook.decision).toMatchObject({ source: 'user', releaseDate: '2027-01-01' });
    expect(outcome.ebook.suggested).toBeUndefined();
  });

  it('leaves a date the owner chose out of a refresh pass', async () => {
    const probeWork = work({
      releases: [release('ebook'), release('audiobook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' })],
    });
    const { service, store } = harness({ works: [probeWork] });

    await service.enrolAndProbe({ id: 'monitor-1', ownerUserId: 1 } as never, config());

    expect(Object.keys(store.saveOutcome.mock.calls[0]?.[1])).toEqual(['ebook']);
  });

  it('reports ledger reset counts in the completed work outcome', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = harness({ works: [work({ audioReleaseDate: '2027-01-10' })] });
    store.saveOutcome.mockImplementation((_work: unknown, outcome: Record<string, unknown>) =>
      Promise.resolve({ ledgerResets: 2, appliedFormats: Object.keys(outcome), skippedFormats: [] }),
    );

    await service.runScheduledProbe();

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.ledger_reset\] \[end\] workId="work-1" userId=1 format=audiobook deleted=2 durationMs=\d+ - stale release ledger rows removed$/,
      ),
    );
    log.mockRestore();
  });

  it('stops an in-flight sweep and clears rows when the setting turns off before save', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const works = [work({ id: 'work-1', hardcoverSlug: null }), work({ id: 'work-2', hardcoverSlug: null })];
    const { service, store, settings } = harness({ works });
    settings.getMonitoredSettings.mockResolvedValueOnce({ releaseProbeEnabled: true }).mockResolvedValue({ releaseProbeEnabled: false });

    await service.runScheduledProbe();

    expect(store.saveOutcome).not.toHaveBeenCalled();
    expect(store.clearAll).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[monitored.release_probe.sweep] [end]'));
    log.mockRestore();
  });
});

describe('MonitoredReleaseProbeService on-demand work refresh', () => {
  const monitor = { id: 'monitor-1', ownerUserId: 1 };

  it('runs the external tiers for one work and rate-limits the next call', async () => {
    const probeWork = work({ ebookReleaseDate: '2026-09-10', audioReleaseDate: null, sources: ['hardcover'] });
    const { service, store, hardcover, apple } = harness({ works: [probeWork] });

    await service.refreshWork(monitor, 'work-1');

    expect(hardcover.fetchEditionsBySlugs).toHaveBeenCalledOnce();
    expect(apple.searchEbook).toHaveBeenCalledOnce();
    expect(store.saveOutcome).toHaveBeenCalledOnce();
    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 429 });
    expect(store.saveOutcome).toHaveBeenCalledOnce();
  });

  it('rate-limits each work on its own', async () => {
    const { service, store } = harness();

    await service.refreshWork(monitor, 'work-1');
    await service.refreshWork(monitor, 'work-2');

    expect(store.saveOutcome).toHaveBeenCalledTimes(2);
  });

  it('does not release another request cooldown slot when both calls start in the same millisecond', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      let resolve!: (value: ReleaseProbeWork) => void;
      const { service, store } = harness();
      store.findWork.mockImplementationOnce(() => new Promise<ReleaseProbeWork>((done) => (resolve = done)));

      const first = service.refreshWork(monitor, 'work-1');
      await vi.waitFor(() => expect(store.findWork).toHaveBeenCalledOnce());
      await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 429 });
      resolve(work());
      await first;

      await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 429 });
      expect(store.findWork).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('refuses while the release probe is switched off', async () => {
    const { service, store } = harness({ settings: { releaseProbeEnabled: false } });

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 409 });
    expect(store.findWork).not.toHaveBeenCalled();
  });

  it('stops an in-flight work refresh and clears rows when the setting turns off before save', async () => {
    const { service, store, settings } = harness();
    settings.getMonitoredSettings.mockResolvedValueOnce({ releaseProbeEnabled: true }).mockResolvedValue({ releaseProbeEnabled: false });

    await service.refreshWork(monitor, 'work-1');

    expect(store.saveOutcome).not.toHaveBeenCalled();
    expect(store.clearAll).toHaveBeenCalledOnce();
  });

  it('answers 404 for a work that is no longer in the catalog', async () => {
    const { service, store } = harness();
    store.findWork.mockResolvedValue(null);

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 404 });
  });

  it('enrols the monitor first and still stores rows for an unenrolled work', async () => {
    const bare = work({ releases: [] });
    const { service, store } = harness({ works: [bare] });

    await service.refreshWork(monitor, 'work-1');

    expect(store.enrol).toHaveBeenCalledWith(monitor, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(Object.keys(store.saveOutcome.mock.calls[0]?.[1])).toEqual(['ebook', 'audiobook']);
  });

  it('refreshes the suggestion behind a format the owner dated and counts it', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const probeWork = work({
      ebookReleaseDate: '2027-03-04',
      ebookDatePrecision: 'day',
      releases: [release('ebook', { status: 'dated', releaseDate: '2027-03-04', datePrecision: 'day', source: 'user' }), release('audiobook')],
    });
    const { service, store, apple } = harness({ works: [probeWork], appleResult: { releaseDate: '2027-05-20', trackId: 1 } });

    await service.refreshWork(monitor, 'work-1');

    expect(apple.searchEbook).toHaveBeenCalledOnce();
    const outcome = store.saveOutcome.mock.calls[0]?.[1];
    expect(outcome.ebook.decision).toMatchObject({ source: 'user', releaseDate: '2027-03-04' });
    expect(outcome.ebook.suggested).toEqual({ releaseDate: '2027-05-20', precision: 'day', source: 'apple' });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[monitored\.release_probe\.work_refresh\] \[end\] .+ suggested=1 failed=0 - on-demand release probe completed$/),
    );
    log.mockRestore();
  });

  it('decides without Hardcover when the owner has no token', async () => {
    const unconfigured = config();
    unconfigured.hardcover = { enabled: false, apiKey: '' };
    const { service, store, hardcover } = harness({ configs: new Map([[1, unconfigured]]) });

    await service.refreshWork(monitor, 'work-1');

    expect(hardcover.fetchEditionsBySlugs).not.toHaveBeenCalled();
    expect(store.saveOutcome).toHaveBeenCalledOnce();
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  it('keeps stored Hardcover evidence when an on-demand refresh has no Hardcover token', async () => {
    const unconfigured = config();
    unconfigured.hardcover = { enabled: false, apiKey: '' };
    const stored = release('ebook', {
      status: 'dated',
      releaseDate: '2027-04-20',
      datePrecision: 'day',
      source: 'hardcover_edition',
      checkedAt: new Date(Date.now() - 30 * 86_400_000),
    });
    const probeWork = work({
      ebookReleaseDate: '2027-04-20',
      ebookDatePrecision: 'day',
      releases: [stored, release('audiobook')],
    });
    const { service, store } = harness({ works: [probeWork], configs: new Map([[1, unconfigured]]) });

    await service.refreshWork(monitor, 'work-1');

    expect(store.saveOutcome.mock.calls[0]?.[1].ebook).toMatchObject({
      decision: { status: 'dated', releaseDate: '2027-04-20', source: 'hardcover_edition' },
      rescheduleOnly: true,
    });
  });

  it('does not back off a renamed Hardcover slug during an on-demand refresh', async () => {
    const missing = work({ hardcoverSlug: 'renamed-slug' });
    const { service, store } = harness({ works: [missing], hardcoverResult: [] });

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({
      status: 502,
      message: 'Release date providers could not be reached',
    });

    expect(store.recordFailure).not.toHaveBeenCalled();
    expect(store.saveOutcome).not.toHaveBeenCalled();
  });

  it('answers 502 and logs the work refresh failure when Hardcover processing fails', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, store } = harness({ hardcoverError: new TypeError('Hardcover failed') });

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({
      status: 502,
      message: 'Release date providers could not be reached',
    });

    expect(store.recordFailure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[monitored\.release_probe\.work_refresh\] \[fail\] workId="work-1" userId=1 durationMs=\d+ errorClass=BadGatewayException error="Release date providers could not be reached" - on-demand release probe failed$/,
      ),
    );

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({ status: 502 });
    expect(store.findWork).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when a work provider fails inside the per-work runner', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, store } = harness({ appleError: new TypeError('Apple failed') });

    await expect(service.refreshWork(monitor, 'work-1')).rejects.toMatchObject({
      status: 502,
      message: 'Release date providers could not be reached',
    });

    expect(store.recordFailure).not.toHaveBeenCalled();
  });
});

describe('MonitoredReleaseProbeService user dates', () => {
  it('stores an owner date as a dated user row that the overlay follows', async () => {
    const { service, store } = harness();
    store.saveOutcome.mockResolvedValue({ ledgerResets: 3, appliedFormats: ['ebook'], skippedFormats: [] });

    await expect(service.setUserReleaseDate({ id: 'work-1', monitorAuthorId: 'monitor-1', ownerUserId: 1 }, 'ebook', '2027-04-02')).resolves.toBe(3);

    const [ref, outcome, now] = store.saveOutcome.mock.calls[0] ?? [];
    expect(ref).toEqual({ id: 'work-1', monitorAuthorId: 'monitor-1', ownerUserId: 1 });
    expect(outcome.ebook.decision).toEqual({
      status: 'dated',
      releaseDate: '2027-04-02',
      precision: 'day',
      source: 'user',
      asin: null,
      overlay: 'set',
    });
    expect((outcome.ebook.nextCheckAt as Date).getTime() - (now as Date).getTime()).toBe(86_400_000);
  });

  it('hands a cleared format back to the store', async () => {
    const { service, store } = harness();

    await expect(service.clearUserReleaseDate('work-1', 'audiobook')).resolves.toBe(true);

    expect(store.clearUserReleaseDate).toHaveBeenCalledWith('work-1', 'audiobook', expect.any(Date));
  });

  it('rejects setting an owner date while the probe is disabled', async () => {
    const { service, store } = harness({ settings: { releaseProbeEnabled: false } });

    await expect(
      service.setUserReleaseDate({ id: 'work-1', monitorAuthorId: 'monitor-1', ownerUserId: 1 }, 'ebook', '2027-04-02'),
    ).rejects.toMatchObject({ status: 409, message: 'The release date probe is turned off' });

    expect(store.saveOutcome).not.toHaveBeenCalled();
  });
});
