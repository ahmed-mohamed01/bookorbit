import { lookup } from 'dns/promises';

import { PrivateAddressException, ensureSafeUrl, isLinkLocalAddress, type SafeRemoteHostOptions } from './ssrf.utils';

export interface SelfHostedUrlOptions {
  allowedProtocols: ReadonlySet<string>;
}

/**
 * Parse a user-supplied self-hosted server URL and return a normalized origin+path (trailing
 * slashes stripped), or null when the URL is unparseable or does not use an allowed scheme.
 * Shared by every fork integration that fetches a user-supplied, typically-LAN server URL on a
 * schedule (Audiobookshelf, Storyteller, ...); rejecting a disallowed scheme is part of the SSRF
 * mitigation for that first outbound request.
 */
export function parseAndNormalizeSelfHostedUrl(raw: string, options: SelfHostedUrlOptions): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!options.allowedProtocols.has(parsed.protocol)) {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

// Private/LAN targets are the normal case for a self-hosted integration, so they are always allowed;
// link-local stays blocked because that range (cloud metadata endpoints) is never a legitimate host.
export function selfHostedSafeRemoteHostOptions(): SafeRemoteHostOptions {
  return { allowLocal: true, allowPrivate: true, blockLinkLocal: true };
}

/**
 * The single outbound-URL gate for a self-hosted integration. `ensureSafeRemoteHost` returns early
 * for `localhost`, `*.localhost` and `*.local` names whenever `allowLocal` or `allowPrivate` is set -
 * which every self-hosted integration sets, since a server on the LAN is the normal case - so such a
 * name never reaches the address check and `blockLinkLocal` alone would not see it. Resolve those
 * names here and apply the same link-local rule.
 */
export async function ensureSafeSelfHostedUrl(rawUrl: string): Promise<void> {
  await ensureSafeUrl(rawUrl, selfHostedSafeRemoteHostOptions());
  await assertLocalNameIsNotLinkLocal(rawUrl);
}

/**
 * Exactly the names `ensureSafeRemoteHost` short-circuits on. It must stay exactly those: a name it
 * still checks would be resolved twice here for nothing, and a name it skips that this misses
 * reaches `fetch` with the one rule this gate keeps on never applied. `.localhost` is not loopback
 * by construction - it is whatever the host's resolver answers.
 */
function isLocallyResolvedName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');
}

async function assertLocalNameIsNotLinkLocal(rawUrl: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl.trim()).hostname.trim().toLowerCase();
  } catch {
    return;
  }
  if (!isLocallyResolvedName(hostname)) return;

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
