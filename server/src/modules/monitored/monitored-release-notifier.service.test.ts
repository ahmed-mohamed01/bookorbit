import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { NotificationType } from '@bookorbit/types';
import type { MonitoredAuthorConfig } from '@bookorbit/types';

import { MonitoredReleaseNotifier } from './monitored-release-notifier.service';
import type { MonitoredDueRelease } from './monitored-store.service';

function monitor(patch: Partial<MonitoredAuthorConfig> = {}): MonitoredAuthorConfig {
  return {
    id: 'monitor-1',
    ownerUserId: 7,
    authorName: 'Adrian Tchaikovsky',
    localAuthorId: null,
    providerIds: {},
    formats: {
      ebook: { mode: 'notify', libraryId: null, folderId: null },
      audiobook: { mode: 'notify', libraryId: null, folderId: null },
    },
    paused: false,
    addedAt: '2026-03-15T10:00:00.000Z',
    lastRefreshedAt: null,
    ...patch,
  };
}

function release(patch: Partial<MonitoredDueRelease> = {}): MonitoredDueRelease {
  return {
    workId: 'work-1',
    title: 'Children of Memory',
    seriesName: 'Children of Time',
    seriesIndex: '3',
    format: 'ebook',
    releaseDate: '2026-09-01',
    storedDate: '2026-09-01',
    claimed: false,
    ...patch,
  };
}

describe('MonitoredReleaseNotifier', () => {
  const notify = vi.fn().mockResolvedValue(undefined);
  const notifier = new MonitoredReleaseNotifier({ notify } as never);

  beforeEach(() => vi.clearAllMocks());

  it('addresses the monitor owner alone and links to the author page', async () => {
    await notifier.notifyRelease(monitor(), [release()]);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationType.MonitoredReleaseAvailable,
        scope: { kind: 'user', userId: 7 },
        actionUrl: '/monitored/authors/monitor-1',
      }),
    );
  });

  it('names the book, its series position, the format and the date', async () => {
    await notifier.notifyRelease(monitor(), [release({ format: 'audiobook' })]);

    const payload = notify.mock.calls[0][0];
    expect(payload.title).toBe('Children of Memory is out now');
    expect(payload.message).toBe('The audiobook of Children of Memory (Children of Time #3) by Adrian Tchaikovsky released on 2026-09-01.');
  });

  // notifications.title is a varchar(255) upstream; an insert that overflows it is retried forever.
  it('clamps an over-long title so the notification row can be inserted', async () => {
    await notifier.notifyRelease(monitor(), [release({ title: 'A'.repeat(400) })]);

    const payload = notify.mock.calls[0][0];
    expect(payload.title).toBe(`${'A'.repeat(197)}... is out now`);
    expect(payload.title.length).toBeLessThanOrEqual(255);
  });

  it('omits the series clause for a standalone', async () => {
    await notifier.notifyRelease(monitor(), [release({ seriesName: null, seriesIndex: null })]);

    expect(notify.mock.calls[0][0].message).toBe('The ebook of Children of Memory by Adrian Tchaikovsky released on 2026-09-01.');
  });

  // A coarse provider date must not be reported as a specific day it never gave us.
  it('says only as much about the date as the catalog knows', async () => {
    await notifier.notifyRelease(monitor(), [release({ releaseDate: '2026-01-01', storedDate: '2026' })]);
    expect(notify.mock.calls[0][0].message).toContain('released in 2026.');

    notify.mockClear();
    await notifier.notifyRelease(monitor(), [release({ releaseDate: '2026-09-01', storedDate: '2026-09' })]);
    expect(notify.mock.calls[0][0].message).toContain('released in September 2026.');
  });

  it('carries the work, format and date in meta so a client can act on it', async () => {
    await notifier.notifyRelease(monitor(), [release()]);

    expect(notify.mock.calls[0][0].meta).toEqual({
      monitorAuthorId: 'monitor-1',
      workId: 'work-1',
      formats: ['ebook'],
      releaseDates: { ebook: '2026-09-01' },
    });
  });

  // One work, both formats due together: one message, the way the Releases tab shows one card.
  it('names both formats in one message when they released on the same day', async () => {
    await notifier.notifyRelease(monitor(), [release(), release({ format: 'audiobook' })]);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0];
    expect(payload.title).toBe('Children of Memory is out now');
    expect(payload.message).toBe('The ebook and audiobook of Children of Memory (Children of Time #3) by Adrian Tchaikovsky released on 2026-09-01.');
    expect(payload.meta).toEqual({
      monitorAuthorId: 'monitor-1',
      workId: 'work-1',
      formats: ['ebook', 'audiobook'],
      releaseDates: { ebook: '2026-09-01', audiobook: '2026-09-01' },
    });
  });

  it('gives each format its own date when they differ', async () => {
    await notifier.notifyRelease(monitor(), [release(), release({ format: 'audiobook', releaseDate: '2026-09-15', storedDate: '2026-09-15' })]);

    expect(notify.mock.calls[0][0].message).toBe(
      'The ebook of Children of Memory (Children of Time #3) by Adrian Tchaikovsky released on 2026-09-01, and the audiobook released on 2026-09-15.',
    );
  });

  it('logs dispatch failures with timing and error class fields', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    notifier.logDispatchFailure(monitor(), [release(), release({ format: 'audiobook' })], Date.now(), new Error('gateway down'));

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\[monitored\.release\.notify\] \[fail\].*formats=ebook,audiobook durationMs=\d+ errorClass=Error/),
    );
  });
});
