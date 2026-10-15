import { describe, expect, it } from 'vitest';

import { parseAndNormalizeEngineUrl } from './web-serials-url.utils';

describe('parseAndNormalizeEngineUrl', () => {
  it('strips trailing slashes and keeps the sub-path', () => {
    expect(parseAndNormalizeEngineUrl('http://suwayomi.lan:4567/')).toBe('http://suwayomi.lan:4567');
    expect(parseAndNormalizeEngineUrl('https://host.example.com/crawler//')).toBe('https://host.example.com/crawler');
  });

  it('rejects other schemes and unparseable input', () => {
    expect(parseAndNormalizeEngineUrl('ftp://host')).toBeNull();
    expect(parseAndNormalizeEngineUrl('file:///etc/passwd')).toBeNull();
    expect(parseAndNormalizeEngineUrl('not a url')).toBeNull();
  });
});
