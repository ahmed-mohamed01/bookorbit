import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookup } from 'dns/promises';
import { PrivateAddressException } from '../../common/utils/ssrf.utils';
import { ensureSafeStorytellerUrl, parseAndNormalizeServerUrl } from './storyteller-url.utils';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));

const mockedLookup = vi.mocked(lookup);

describe('parseAndNormalizeServerUrl', () => {
  it('strips trailing slashes and keeps the sub-path', () => {
    expect(parseAndNormalizeServerUrl('https://storyteller.example.com/api//')).toBe('https://storyteller.example.com/api');
  });

  it('rejects a non-http(s) scheme and an unparseable URL', () => {
    expect(parseAndNormalizeServerUrl('ftp://storyteller.example.com')).toBeNull();
    expect(parseAndNormalizeServerUrl('not a url')).toBeNull();
  });
});

describe('ensureSafeStorytellerUrl mDNS link-local guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a .local name that resolves to a link-local address', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.10.10', family: 4 }] as never);

    await expect(ensureSafeStorytellerUrl('http://storyteller.local:8000/api')).rejects.toBeInstanceOf(PrivateAddressException);
    expect(mockedLookup).toHaveBeenCalledWith('storyteller.local', { all: true, verbatim: true });
  });

  it('accepts a .local name that resolves to an ordinary private LAN address', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }] as never);

    await expect(ensureSafeStorytellerUrl('http://storyteller.local:8000/api')).resolves.toBeUndefined();
  });

  it('accepts a .local name whose lookup fails, leaving the request itself to fail', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(ensureSafeStorytellerUrl('http://storyteller.local:8000/api')).resolves.toBeUndefined();
  });
});
