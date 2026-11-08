import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { isImmutableStaticAsset } from './static-cache.utils';

const publicRoot = join('/srv', 'bookorbit', 'public');

describe('isImmutableStaticAsset', () => {
  it.each([
    join(publicRoot, 'assets', 'index-AbCd1234.js'),
    join(publicRoot, 'assets', 'index-AbCd1234.css'),
    join(publicRoot, 'assets', 'lucide', '1.62.0', 'folder-open.svg'),
    join(publicRoot, 'assets', 'lucide', '2.0.0-rc.1', 'catalog.svg'),
    join(publicRoot, 'assets', 'foliate', 'a1b2c3d4e5f6', 'view.js'),
    join(publicRoot, 'assets', 'foliate', 'a1b2c3d4e5f6', 'vendor', 'zip.js'),
  ])('caches %s forever', (filePath) => {
    expect(isImmutableStaticAsset(publicRoot, filePath)).toBe(true);
  });

  it.each([
    join(publicRoot, 'index.html'),
    join(publicRoot, 'sw.js'),
    join(publicRoot, 'registerSW.js'),
    join(publicRoot, 'manifest.webmanifest'),
    join(publicRoot, 'assets', 'foliate', 'view.js'),
    join(publicRoot, 'assets', 'foliate', 'vendor', 'zip.js'),
    join(publicRoot, 'assets', 'provider-icons', 'audible.svg'),
    join(publicRoot, 'assets', 'lucide', 'folder-open.svg'),
    join(publicRoot, 'assets', 'lucide', 'latest', 'folder-open.svg'),
    join(publicRoot, 'assets', 'lucide', '1.62.0', 'nested', 'folder-open.svg'),
    join('/srv', 'other', 'assets', 'index-AbCd1234.js'),
  ])('keeps revalidating %s', (filePath) => {
    expect(isImmutableStaticAsset(publicRoot, filePath)).toBe(false);
  });
});
