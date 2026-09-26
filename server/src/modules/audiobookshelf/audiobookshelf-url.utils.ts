import type { SafeRemoteHostOptions } from '../../common/utils/ssrf.utils';
import {
  ensureSafeSelfHostedUrl,
  parseAndNormalizeSelfHostedUrl,
  selfHostedSafeRemoteHostOptions,
} from '../../common/utils/self-hosted-service-url.utils';
import { AUDIOBOOKSHELF_ALLOWED_PROTOCOLS } from './audiobookshelf.constants';

/**
 * Parse a user-supplied Audiobookshelf server URL and return a normalized origin+path (trailing
 * slashes stripped), or null when the URL is unparseable or does not use an http/https scheme.
 * Thin wrapper over the shared self-hosted-service URL guard (also used by Storyteller); rejecting
 * non-http(s) schemes is part of the SSRF mitigation for the first user-supplied URL the server
 * fetches on a schedule.
 */
export function parseAndNormalizeServerUrl(raw: string): string | null {
  return parseAndNormalizeSelfHostedUrl(raw, { allowedProtocols: AUDIOBOOKSHELF_ALLOWED_PROTOCOLS });
}

// Private/LAN targets are the normal case for a self-hosted Audiobookshelf, so they are always
// allowed; link-local stays blocked because that range (cloud metadata endpoints) is never a
// legitimate ABS host.
export function audiobookshelfSafeRemoteHostOptions(): SafeRemoteHostOptions {
  return selfHostedSafeRemoteHostOptions();
}

/**
 * The single outbound-URL gate for ABS. See `ensureSafeSelfHostedUrl` for the mDNS `.local`
 * link-local guard this delegates to.
 */
export async function ensureSafeAudiobookshelfUrl(rawUrl: string): Promise<void> {
  await ensureSafeSelfHostedUrl(rawUrl);
}
