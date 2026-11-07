export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

export function cacheControlFor(pathname: string): string {
  const path = pathname.replace(/\\/g, '/').split('?')[0];
  if (/(?:^|\/)(?:index\.html|sw\.js|registerSW\.js|manifest\.webmanifest|theme-init\.js)$/.test(path)) return REVALIDATE_CACHE_CONTROL;
  if (/\/assets\/foliate\/[a-f0-9]{12}\//.test(path)) return IMMUTABLE_CACHE_CONTROL;
  if (/\/assets\/(?:foliate|provider-icons)\//.test(path)) return 'public, max-age=3600';
  if (/\/assets\/.*-[A-Za-z0-9_-]{8}\.(?:js|css|wasm|woff2?|png|svg|jpe?g|webp|json)$/.test(path)) return IMMUTABLE_CACHE_CONTROL;
  return 'public, max-age=3600';
}
