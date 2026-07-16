import { AUDIOBOOKSHELF_ALLOWED_PROTOCOLS } from './audiobookshelf.constants';

/**
 * Parse a user-supplied Audiobookshelf server URL and return a normalized origin+path
 * (trailing slashes stripped), or null when the URL is unparseable or does not use an
 * http/https scheme. Rejecting non-http(s) schemes is part of the SSRF mitigation for the
 * first user-supplied URL the server fetches on a schedule.
 */
export function parseAndNormalizeServerUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!AUDIOBOOKSHELF_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}
