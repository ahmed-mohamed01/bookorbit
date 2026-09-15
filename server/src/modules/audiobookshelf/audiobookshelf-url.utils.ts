import { lookup } from 'dns/promises';

import { PrivateAddressException, ensureSafeUrl, isLinkLocalAddress, type SafeRemoteHostOptions } from '../../common/utils/ssrf.utils';
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

// Private/LAN targets are the normal case for a self-hosted Audiobookshelf, so they are always
// allowed; link-local stays blocked because that range (cloud metadata endpoints) is never a
// legitimate ABS host.
export function audiobookshelfSafeRemoteHostOptions(): SafeRemoteHostOptions {
  return { allowLocal: true, allowPrivate: true, blockLinkLocal: true };
}

/**
 * The single outbound-URL gate for ABS. `ensureSafeRemoteHost` returns early for `localhost`,
 * `*.localhost` and `*.local` names whenever `allowLocal` or `allowPrivate` is set - which ABS sets,
 * since a self-hosted server on the LAN is the normal case - so such a name never reaches the address
 * check and `blockLinkLocal` alone would not see it. Resolve `.local` mDNS names here and apply the
 * same link-local rule. A name that does not resolve is let through, matching upstream's treatment of
 * an unresolvable `.local`; the request itself fails a moment later anyway.
 */
export async function ensureSafeAudiobookshelfUrl(rawUrl: string): Promise<void> {
  await ensureSafeUrl(rawUrl, audiobookshelfSafeRemoteHostOptions());
  await assertMdnsHostIsNotLinkLocal(rawUrl);
}

async function assertMdnsHostIsNotLinkLocal(rawUrl: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl.trim()).hostname.trim().toLowerCase();
  } catch {
    return;
  }
  if (!hostname.endsWith('.local')) return;

  let resolved: { address: string }[];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return;
  }
  if (resolved.some((entry) => isLinkLocalAddress(entry.address))) {
    throw new PrivateAddressException();
  }
}
