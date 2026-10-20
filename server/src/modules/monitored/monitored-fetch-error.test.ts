import { describe, expect, it } from 'vitest';
import { HardcoverAuthorGoneError, HardcoverRequestError } from '../metadata-fetch/providers/hardcover/hardcover.errors';
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import { CatalogFetchError, classifyCatalogFetchError } from './monitored-fetch-error';

describe('classifyCatalogFetchError', () => {
  it.each([
    [new HardcoverRequestError('author-contributions', null, { cause: new DOMException('t', 'TimeoutError') }), 'timeout', null],
    [new ProviderThrottleError(120), 'rate_limited', 120],
    [new HardcoverRequestError('author-contributions', 429), 'rate_limited', null],
    [new HardcoverRequestError('author-contributions', 401), 'auth_failed', null],
    [new HardcoverRequestError('author-contributions', 403), 'auth_failed', null],
    [new HardcoverAuthorGoneError(99618), 'author_gone', null],
    [new Error('x'), 'unavailable', null],
  ])('classifies %s as %s', (error, kind, retryAfterSeconds) => {
    expect(classifyCatalogFetchError(error)).toEqual({ kind, retryAfterSeconds });
  });

  it('recognizes only the caller abort reason as job control', () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    expect(classifyCatalogFetchError(reason, controller.signal)).toBe('aborted');
    expect(classifyCatalogFetchError(new Error('other'), controller.signal)).toEqual({ kind: 'unavailable', retryAfterSeconds: null });
  });

  it('preserves the cause and retry hint in an HTTP exception', () => {
    const cause = new Error('upstream');
    const error = new CatalogFetchError('rate_limited', 120, cause);
    expect(error.getStatus()).toBe(503);
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120, cause });
  });
});
