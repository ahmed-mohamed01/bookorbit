import { ensureSafeSelfHostedUrl, parseAndNormalizeSelfHostedUrl } from '../../common/utils/self-hosted-service-url.utils';

const STORYTELLER_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Rejecting non-http(s) is part of the SSRF mitigation for a URL the server itself fetches. */
export function parseAndNormalizeServerUrl(raw: string): string | null {
  return parseAndNormalizeSelfHostedUrl(raw, { allowedProtocols: STORYTELLER_ALLOWED_PROTOCOLS });
}

/** The single outbound-URL gate; `ensureSafeSelfHostedUrl` carries the mDNS `.local` guard. */
export async function ensureSafeStorytellerUrl(rawUrl: string): Promise<void> {
  await ensureSafeSelfHostedUrl(rawUrl);
}
