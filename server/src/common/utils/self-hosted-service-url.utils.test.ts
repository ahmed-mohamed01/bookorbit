import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookup } from 'dns/promises';
import { PrivateAddressException } from './ssrf.utils';
import { ensureSafeSelfHostedUrl, parseAndNormalizeSelfHostedUrl, selfHostedSafeRemoteHostOptions } from './self-hosted-service-url.utils';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));

const mockedLookup = vi.mocked(lookup);
const HTTP_HTTPS = new Set(['http:', 'https:']);

describe('parseAndNormalizeSelfHostedUrl', () => {
  it('strips trailing slashes and keeps the sub-path', () => {
    expect(parseAndNormalizeSelfHostedUrl('https://service.example.com/api//', { allowedProtocols: HTTP_HTTPS })).toBe(
      'https://service.example.com/api',
    );
  });

  it('rejects a scheme outside the allowed set and an unparseable URL', () => {
    expect(parseAndNormalizeSelfHostedUrl('ftp://service.example.com', { allowedProtocols: HTTP_HTTPS })).toBeNull();
    expect(parseAndNormalizeSelfHostedUrl('not a url', { allowedProtocols: HTTP_HTTPS })).toBeNull();
  });

  it('honours a caller-specific allowed protocol set', () => {
    const onlyHttps = new Set(['https:']);
    expect(parseAndNormalizeSelfHostedUrl('http://service.example.com', { allowedProtocols: onlyHttps })).toBeNull();
    expect(parseAndNormalizeSelfHostedUrl('https://service.example.com', { allowedProtocols: onlyHttps })).toBe('https://service.example.com');
  });
});

describe('selfHostedSafeRemoteHostOptions', () => {
  it('allows LAN targets but keeps link-local blocked', () => {
    expect(selfHostedSafeRemoteHostOptions()).toEqual({ allowLocal: true, allowPrivate: true, blockLinkLocal: true });
  });
});

describe('ensureSafeSelfHostedUrl mDNS link-local guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a .local name that resolves to a link-local address', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.10.10', family: 4 }] as never);

    await expect(ensureSafeSelfHostedUrl('http://service.local:8080/api')).rejects.toBeInstanceOf(PrivateAddressException);
    expect(mockedLookup).toHaveBeenCalledWith('service.local', { all: true, verbatim: true });
  });

  it('accepts a .local name that resolves to an ordinary private LAN address', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }] as never);

    await expect(ensureSafeSelfHostedUrl('http://service.local:8080/api')).resolves.toBeUndefined();
  });

  it('accepts a .local name whose lookup fails, leaving the request itself to fail', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(ensureSafeSelfHostedUrl('http://service.local:8080/api')).resolves.toBeUndefined();
  });

  it('resolves an ordinary LAN hostname once via the SSRF check and skips a redundant mDNS lookup', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.1.20', family: 4 }] as never);

    await expect(ensureSafeSelfHostedUrl('http://service.example.com/api')).resolves.toBeUndefined();
    expect(mockedLookup).toHaveBeenCalledTimes(1);
    expect(mockedLookup).toHaveBeenCalledWith('service.example.com', { all: true, verbatim: true });
  });
});
