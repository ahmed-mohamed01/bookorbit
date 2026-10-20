import { ServiceUnavailableException } from '@nestjs/common';
import type { MonitoredFetchErrorKind } from '@bookorbit/types';
import { HardcoverAuthorGoneError, HardcoverRequestError } from '../metadata-fetch/providers/hardcover/hardcover.errors';
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';

type CatalogErrorKind = Exclude<MonitoredFetchErrorKind, 'not_configured'>;

export class CatalogFetchError extends ServiceUnavailableException {
  constructor(
    readonly kind: CatalogErrorKind,
    readonly retryAfterSeconds: number | null,
    cause: unknown,
  ) {
    super('Hardcover bibliography fetch failed', { cause });
  }
}

export function classifyCatalogFetchError(
  error: unknown,
  signal?: AbortSignal,
): { kind: CatalogErrorKind; retryAfterSeconds: number | null } | 'aborted' {
  if (signal?.aborted && error === signal.reason) return 'aborted';
  if (error instanceof ProviderThrottleError) return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds ?? null };
  if (error instanceof HardcoverAuthorGoneError) return { kind: 'author_gone', retryAfterSeconds: null };
  if (error instanceof HardcoverRequestError) {
    if (error.cause instanceof Error && error.cause.name === 'TimeoutError') return { kind: 'timeout', retryAfterSeconds: null };
    if (error.status === 429) return { kind: 'rate_limited', retryAfterSeconds: null };
    if (error.status === 401 || error.status === 403) return { kind: 'auth_failed', retryAfterSeconds: null };
  }
  return { kind: 'unavailable', retryAfterSeconds: null };
}
