import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import { APPLE_CLIENT_PAUSE_MS, AppleBooksClient, appleCountryForAmazonDomain } from './apple-books.client';

describe('AppleBooksClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the first matching title and author', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { trackName: 'Wrong Book', artistName: 'Dennis Taylor', releaseDate: '2026-01-01T00:00:00Z', trackId: 1 },
            {
              trackName: 'The Infinite Extent: Bobiverse, Book 6',
              artistName: 'Dennis E. Taylor',
              releaseDate: '2026-09-10T00:00:00Z',
              trackId: 2,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(new AppleBooksClient().searchEbook('The Infinite Extent', 'Dennis E. Taylor', 'us')).resolves.toEqual({
      releaseDate: '2026-09-10',
      trackId: 2,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.stringContaining('The+Infinite+Extent+Dennis+E.+Taylor') }),
      expect.any(Object),
    );
  });

  it('returns every dated matching listing for the owner to choose from', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { trackName: 'Wrong Book', artistName: 'Dennis E. Taylor', releaseDate: '2026-01-01T00:00:00Z', trackId: 1 },
            {
              trackName: 'The Infinite Extent: Bobiverse, Book 6',
              artistName: 'Dennis E. Taylor',
              releaseDate: '2026-09-10T00:00:00Z',
              trackId: 2,
              trackViewUrl: 'https://books.apple.com/us/book/id2',
            },
            { trackName: 'The Infinite Extent', artistName: 'Dennis E. Taylor', trackId: 3 },
            { trackName: 'The Infinite Extent (Deluxe)', artistName: 'Dennis E. Taylor', releaseDate: '2026-11-24T00:00:00Z', trackId: 4 },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(new AppleBooksClient().searchEbookCandidates('The Infinite Extent', 'Dennis E. Taylor', 'us')).resolves.toEqual([
      {
        trackId: 2,
        trackName: 'The Infinite Extent: Bobiverse, Book 6',
        releaseDate: '2026-09-10',
        trackViewUrl: 'https://books.apple.com/us/book/id2',
      },
      { trackId: 4, trackName: 'The Infinite Extent (Deluxe)', releaseDate: '2026-11-24', trackViewUrl: null },
    ]);
  });

  it('returns no candidates when nothing matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await expect(new AppleBooksClient().searchEbookCandidates('Book', 'Author', 'us')).resolves.toEqual([]);
  });

  it('returns null for an empty or non-matching result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    await expect(new AppleBooksClient().searchEbook('Book', 'Author', 'us')).resolves.toBeNull();
  });

  it.each([403, 429])('turns HTTP %s into a provider throttle', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new AppleBooksClient().searchEbook('Book', 'Author', 'us')).rejects.toBeInstanceOf(ProviderThrottleError);
  });

  it('pauses every search for three hours after a throttle, without fetching or queuing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('', { status: 429 })));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new AppleBooksClient();

    await expect(client.searchEbook('Book', 'Author', 'us')).rejects.toBeInstanceOf(ProviderThrottleError);
    const pausedUntil = Date.now() + APPLE_CLIENT_PAUSE_MS;
    expect(client.pausedUntil()).toBe(pausedUntil);

    await expect(client.searchEbookCandidates('Another Book', 'Author', 'us')).rejects.toBeInstanceOf(ProviderThrottleError);

    expect(fetch).toHaveBeenCalledOnce();
    expect(client.pausedUntil()).toBe(pausedUntil);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('- requests paused'))).toEqual([
      [
        `[monitored.release_probe.apple] [fail] durationMs=0 pausedUntil=${new Date(pausedUntil).toISOString()} errorClass=ProviderThrottleError error="Provider throttled (HTTP 429)" - requests paused`,
      ],
    ]);
  });

  it('searches again once the pause has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 429 })))
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new AppleBooksClient();

    await expect(client.searchEbook('Book', 'Author', 'us')).rejects.toBeInstanceOf(ProviderThrottleError);
    await vi.advanceTimersByTimeAsync(APPLE_CLIENT_PAUSE_MS);

    await expect(client.searchEbook('Book', 'Author', 'us')).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('turns another non-ok response into a gateway exception', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(new AppleBooksClient().searchEbook('Book', 'Author', 'us')).rejects.toMatchObject({ status: 502 });
  });

  it('enforces the gap between consecutive searches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const client = new AppleBooksClient();

    await client.searchEbook('First', 'Author', 'us');
    const second = client.searchEbook('Second', 'Author', 'us');
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_199);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the latest queued slot when its waiter aborts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const client = new AppleBooksClient();
    const controller = new AbortController();

    await client.searchEbook('First', 'Author', 'us');
    const aborted = client.searchEbook('Aborted', 'Author', 'us', controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const next = client.searchEbook('Next', 'Author', 'us');
    await vi.advanceTimersByTimeAsync(3_199);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('appleCountryForAmazonDomain', () => {
  it.each([
    ['amazon.com', 'us'],
    ['amazon.co.uk', 'gb'],
    ['amazon.de', 'de'],
    ['amazon.fr', 'fr'],
    ['amazon.it', 'it'],
    ['amazon.es', 'es'],
    ['amazon.ca', 'ca'],
    ['amazon.com.au', 'au'],
    ['amazon.co.jp', 'jp'],
    ['amazon.in', 'in'],
    ['amazon.com.br', 'br'],
    ['amazon.com.mx', 'mx'],
    ['amazon.nl', 'nl'],
    ['amazon.se', 'se'],
    ['amazon.pl', 'pl'],
    ['amazon.sg', 'sg'],
    ['amazon.ae', 'ae'],
    ['amazon.sa', 'sa'],
    ['amazon.tr', 'tr'],
    ['unknown.example', 'us'],
  ])('maps %s to %s', (domain, country) => expect(appleCountryForAmazonDomain(domain)).toBe(country));
});
