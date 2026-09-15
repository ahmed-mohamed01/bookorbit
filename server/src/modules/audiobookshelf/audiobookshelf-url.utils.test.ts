import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookup } from 'dns/promises';
import { PrivateAddressException } from '../../common/utils/ssrf.utils';
import { audiobookshelfSafeRemoteHostOptions, ensureSafeAudiobookshelfUrl, parseAndNormalizeServerUrl } from './audiobookshelf-url.utils';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));

const mockedLookup = vi.mocked(lookup);

describe('parseAndNormalizeServerUrl', () => {
  it('strips trailing slashes and keeps the sub-path', () => {
    expect(parseAndNormalizeServerUrl('https://abs.example.com/audiobooks//')).toBe('https://abs.example.com/audiobooks');
  });

  it('rejects a non-http(s) scheme and an unparseable URL', () => {
    expect(parseAndNormalizeServerUrl('ftp://abs.example.com')).toBeNull();
    expect(parseAndNormalizeServerUrl('not a url')).toBeNull();
  });
});

describe('audiobookshelfSafeRemoteHostOptions', () => {
  it('allows LAN targets but keeps link-local blocked', () => {
    expect(audiobookshelfSafeRemoteHostOptions()).toEqual({ allowLocal: true, allowPrivate: true, blockLinkLocal: true });
  });
});

describe('ensureSafeAudiobookshelfUrl mDNS link-local guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a .local name that resolves to a link-local address', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.10.10', family: 4 }] as never);

    await expect(ensureSafeAudiobookshelfUrl('http://abs.local:13378/api/me')).rejects.toBeInstanceOf(PrivateAddressException);
    expect(mockedLookup).toHaveBeenCalledWith('abs.local', { all: true, verbatim: true });
  });

  it('accepts a .local name that resolves to an ordinary private LAN address', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }] as never);

    await expect(ensureSafeAudiobookshelfUrl('http://abs.local:13378/api/me')).resolves.toBeUndefined();
  });

  it('accepts a .local name whose lookup fails, leaving the request itself to fail', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(ensureSafeAudiobookshelfUrl('http://abs.local:13378/api/me')).resolves.toBeUndefined();
  });
});
