import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as fetchModule from '../../metadata-fetch/fetch-with-throttle';
import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import { AMAZON_CLIENT_PAUSE_MS, AmazonProductPageClient } from './amazon-product-page.client';

vi.mock('../../metadata-fetch/fetch-with-throttle', () => ({ fetchWithThrottle: vi.fn() }));

const AMAZON = { domain: 'amazon.com', cookie: '' };

describe('AmazonProductPageClient', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches a product page with the configured domain and cookie', async () => {
    vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('<html>book</html>', { status: 200 }));
    const client = new AmazonProductPageClient();

    await expect(client.fetchProductPage('B012345678', { domain: 'amazon.co.uk', cookie: 'session=abc' })).resolves.toEqual({
      html: '<html>book</html>',
    });
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledWith(
      'https://www.amazon.co.uk/dp/B012345678',
      expect.objectContaining({ headers: expect.objectContaining({ cookie: 'session=abc' }) }),
    );
  });

  it('returns a not-found marker for a product 404', async () => {
    vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('', { status: 404 }));
    await expect(new AmazonProductPageClient().fetchProductPage('B012345678', { domain: 'amazon.com', cookie: '' })).resolves.toEqual({
      notFound: true,
    });
  });

  it('builds a stripbooks search URL', async () => {
    vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('<html>results</html>', { status: 200 }));

    await expect(new AmazonProductPageClient().fetchSearchPage('The Infinite Extent', { domain: 'amazon.com', cookie: '' })).resolves.toEqual({
      html: '<html>results</html>',
    });
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledWith('https://www.amazon.com/s?k=The%20Infinite%20Extent&i=stripbooks', expect.any(Object));
  });

  it('enforces the gap between consecutive requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.mocked(fetchModule.fetchWithThrottle).mockImplementation(() => Promise.resolve(new Response('<html></html>', { status: 200 })));
    const client = new AmazonProductPageClient();

    await client.fetchSearchPage('first', { domain: 'amazon.com', cookie: '' });
    const second = client.fetchSearchPage('second', { domain: 'amazon.com', cookie: '' });
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(799);
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('returns the latest queued slot when its waiter aborts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.mocked(fetchModule.fetchWithThrottle).mockImplementation(() => Promise.resolve(new Response('<html></html>', { status: 200 })));
    const client = new AmazonProductPageClient();
    const controller = new AbortController();

    await client.fetchSearchPage('first', { domain: 'amazon.com', cookie: '' });
    const aborted = client.fetchSearchPage('aborted', { domain: 'amazon.com', cookie: '' }, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const next = client.fetchSearchPage('next', { domain: 'amazon.com', cookie: '' });
    await vi.advanceTimersByTimeAsync(799);
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(2);
  });

  it.each([503, 429])('surfaces HTTP %s as a throttle', async (status) => {
    if (status === 429) vi.mocked(fetchModule.fetchWithThrottle).mockRejectedValue(new ProviderThrottleError());
    else vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('', { status }));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(new AmazonProductPageClient().fetchSearchPage('book', { domain: 'amazon.com', cookie: '' })).rejects.toBeInstanceOf(
      ProviderThrottleError,
    );
  });

  it('turns another non-ok response into a gateway exception', async () => {
    vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('', { status: 500 }));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(new AmazonProductPageClient().fetchSearchPage('book', { domain: 'amazon.com', cookie: '' })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('pauses every request for six hours after a throttle, without fetching or queuing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.mocked(fetchModule.fetchWithThrottle).mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new AmazonProductPageClient();

    await expect(client.fetchSearchPage('book', AMAZON)).rejects.toBeInstanceOf(ProviderThrottleError);
    const pausedUntil = Date.now() + AMAZON_CLIENT_PAUSE_MS;
    expect(client.pausedUntil()).toBe(pausedUntil);

    await expect(client.fetchProductPage('B012345678', AMAZON)).rejects.toBeInstanceOf(ProviderThrottleError);

    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledOnce();
    expect(client.pausedUntil()).toBe(pausedUntil);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('- requests paused'))).toEqual([
      [
        `[monitored.release_probe.amazon] [fail] durationMs=0 pausedUntil=${new Date(pausedUntil).toISOString()} errorClass=ProviderThrottleError error="Provider throttled (HTTP 503)" - requests paused`,
      ],
    ]);
  });

  it('requests again once the pause has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    vi.mocked(fetchModule.fetchWithThrottle)
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
      .mockImplementation(() => Promise.resolve(new Response('<html>book</html>', { status: 200 })));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new AmazonProductPageClient();

    await expect(client.fetchSearchPage('book', AMAZON)).rejects.toBeInstanceOf(ProviderThrottleError);
    await vi.advanceTimersByTimeAsync(AMAZON_CLIENT_PAUSE_MS);

    await expect(client.fetchSearchPage('book', AMAZON)).resolves.toEqual({ html: '<html>book</html>' });
    expect(fetchModule.fetchWithThrottle).toHaveBeenCalledTimes(2);
  });

  it('detects a bot challenge and sanitizes failure logs', async () => {
    vi.mocked(fetchModule.fetchWithThrottle).mockResolvedValue(new Response('<div>validateCaptcha</div>', { status: 200 }));
    const log = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(new AmazonProductPageClient().fetchProductPage('BAD"ASIN', { domain: 'amazon.com', cookie: '' })).rejects.toBeInstanceOf(
      ProviderThrottleError,
    );
    expect(log.mock.calls[0][0]).toContain('asin="BAD\\"ASIN"');
  });
});
