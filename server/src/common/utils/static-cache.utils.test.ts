import { describe, expect, it } from 'vitest';
import { cacheControlFor } from './static-cache.utils';

describe('cacheControlFor', () => {
  it.each(['/assets/AccentPicker-B7p9f2ef.js', '/assets/AcquisitionLagScatterChart-BBsIaulw.js', '/assets/foliate/012345abcdef/reader.js'])(
    'keeps content-versioned asset %s immutable',
    (path) => {
      expect(cacheControlFor(path)).toBe('public, max-age=31536000, immutable');
    },
  );
  it.each(['/index.html', '/sw.js', '/registerSW.js', '/manifest.webmanifest', '/theme-init.js'])('revalidates %s', (path) => {
    expect(cacheControlFor(path)).toBe('no-cache');
  });
  it.each(['/assets/foliate/reader.js', '/assets/provider-icons/icon.png', '/assets/unhashed.js'])('briefly caches %s', (path) => {
    expect(cacheControlFor(path)).toBe('public, max-age=3600');
  });
});
