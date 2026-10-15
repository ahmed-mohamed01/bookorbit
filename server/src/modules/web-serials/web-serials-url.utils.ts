import { ensureSafeSelfHostedUrl, parseAndNormalizeSelfHostedUrl } from '../../common/utils/self-hosted-service-url.utils';

const ENGINE_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Rejecting non-http(s) is part of the SSRF mitigation for a URL the server itself fetches. */
export function parseAndNormalizeEngineUrl(raw: string): string | null {
  return parseAndNormalizeSelfHostedUrl(raw, { allowedProtocols: ENGINE_ALLOWED_PROTOCOLS });
}

export async function ensureSafeEngineUrl(rawUrl: string): Promise<void> {
  await ensureSafeSelfHostedUrl(rawUrl);
}
