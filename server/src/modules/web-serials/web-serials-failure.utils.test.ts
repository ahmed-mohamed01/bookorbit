import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EngineCredentialsRejectedException, withEngineFailure } from './engines/engine-http.utils';

import {
  classifyFailure,
  failedUnitsMessage,
  failureText,
  isEngineJobGone,
  isRetryableFailure,
  type FailureReason,
} from './web-serials-failure.utils';

describe('classifyFailure', () => {
  it.each<[string, unknown, FailureReason]>([
    ['our own timeout', new GatewayTimeoutException('The remote service did not answer in time'), 'source_unavailable'],
    ['engine answering 5xx', new ServiceUnavailableException('The remote service answered with status 522'), 'source_unavailable'],
    ['engine not reachable', new ServiceUnavailableException('The remote service could not be reached'), 'engine_unreachable'],
    ['engine credentials', new UnauthorizedException('The remote service rejected the configured credentials'), 'unknown'],
    ['graphql failure', new BadGatewayException('The remote service could not complete the GraphQL request'), 'unknown'],
    [
      'graphql failure carrying the source error',
      new BadGatewayException('The remote service could not complete the GraphQL request: HTTP error 502'),
      'source_unavailable',
    ],
    [
      'engine status, whatever the text',
      withEngineFailure(new BadGatewayException('Upstream request failed'), { status: 502, code: 'SITE_FAILED' }),
      'source_unavailable',
    ],
    ['challenge code', withEngineFailure(new BadGatewayException('Upstream request failed'), { status: 502, code: 'CHALLENGE' }), 'source_blocked'],
    ['plugin error code', withEngineFailure(new BadGatewayException('HTTP error 503'), { status: 502, code: 'PLUGIN_ERROR' }), 'unknown'],
    ['engine 410', withEngineFailure(new BadGatewayException('rejected'), { status: 410, code: null }), 'not_found'],
    ['engine 409 falls back to the text', withEngineFailure(new BadGatewayException('timed out'), { status: 409, code: null }), 'source_unavailable'],
    ['suwayomi error state', 'The chapter download failed', 'source_images_failed'],
    ['cdn failure', 'java.io.IOException: All CDN attempts failed', 'source_images_failed'],
    ['cloudflare 522', 'HttpException: HTTP error 522 (Cloudflare)', 'source_unavailable'],
    ['suwayomi timeout', 'TimeoutCancellationException: Timed out waiting for 30000 ms', 'source_unavailable'],
    ['lncrawl fetch failure', '3 chapters could not be fetched', 'source_unavailable'],
    ['lncrawl blocked', 'The chapters could not be fetched: HTTP 403 Forbidden', 'source_blocked'],
    ['lncrawl missing', 'The chapters could not be fetched: HTTP 404 Not Found', 'not_found'],
    ['unrelated text', 'dock refused', 'unknown'],
    ['non-text value', 42, 'unknown'],
  ])('%s', (_name, input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  it('classifies a plain Error by its message', () => {
    expect(classifyFailure(new Error('ECONNRESET'))).toBe('source_unavailable');
  });
});

describe('failureText and retry rules', () => {
  it('names the source and never says remote service', () => {
    const reasons: FailureReason[] = ['source_unavailable', 'source_images_failed', 'source_blocked', 'not_found', 'engine_unreachable'];
    for (const reason of reasons) expect(failureText(reason, 'Mangabat')).not.toMatch(/remote service/i);
    expect(failureText('source_unavailable', 'Mangabat')).toBe("Mangabat isn't responding right now.");
    expect(failureText('source_images_failed', 'Mangabat')).toBe("Mangabat's image server failed for this chapter.");
    expect(failureText('source_blocked', 'Mangabat')).toBe('Mangabat refused the request (it may be blocking automated downloads).');
    expect(failureText('not_found', 'Mangabat')).toBe('Mangabat no longer has this chapter.');
    expect(failureText('engine_unreachable', 'Mangabat')).toBe('The download service is not reachable.');
    expect(failureText('unknown', 'Mangabat')).toBeNull();
  });

  it('retries only transient reasons', () => {
    expect(['source_unavailable', 'source_images_failed', 'engine_unreachable'].every((r) => isRetryableFailure(r as FailureReason))).toBe(true);
    expect(['source_blocked', 'not_found', 'unknown'].some((r) => isRetryableFailure(r as FailureReason))).toBe(false);
  });
});

describe('failedUnitsMessage', () => {
  it('states a shared reason once', () => {
    expect(failedUnitsMessage(new Map([['source_unavailable', 2]]), 2, 'chapter', 'Mangabat')).toBe(
      "2 chapters could not be downloaded: Mangabat isn't responding right now. Try again later.",
    );
  });

  it('does not suggest trying again for a permanent reason', () => {
    expect(failedUnitsMessage(new Map([['not_found', 1]]), 1, 'chapter', 'Mangabat')).toBe(
      '1 chapter could not be downloaded: Mangabat no longer has this chapter.',
    );
  });

  it.each([
    [
      'mixed reasons',
      new Map<FailureReason, number>([
        ['source_unavailable', 1],
        ['not_found', 1],
      ]),
      2,
    ],
    ['unknown reason', new Map<FailureReason, number>([['unknown', 2]]), 2],
    ['reasons missing after a resume', new Map<FailureReason, number>([['source_unavailable', 1]]), 3],
  ])('falls back to the count message for %s', (_name, counts, failed) => {
    expect(failedUnitsMessage(counts, failed, 'chapter', 'Mangabat')).toBe(`${failed} chapters could not be downloaded from Mangabat.`);
  });
});

describe('engine job lost', () => {
  it('recognises a 404 from polling a job handle and treats the loss as retryable', () => {
    expect(isEngineJobGone(new BadGatewayException('The remote service rejected the request with status 404'))).toBe(true);
    expect(isEngineJobGone(new BadGatewayException('The remote service rejected the request with status 400'))).toBe(false);
    expect(isEngineJobGone(new Error('status 404'))).toBe(false);
    expect(isRetryableFailure('engine_job_lost')).toBe(true);
    expect(failureText('engine_job_lost', 'Src')).toBe('The download service lost track of this download.');
  });

  it('words the reason texts for the unit that failed', () => {
    expect(failureText('not_found', 'Src', 'volume')).toBe('Src no longer has this volume.');
    expect(failureText('source_images_failed', 'Src', 'book')).toBe("Src's image server failed for this book.");
    expect(failureText('not_found', 'Src')).toBe('Src no longer has this chapter.');
  });
});

describe('engine rejections', () => {
  it('tells rejected credentials from a source failure and keeps them out of the retry path', () => {
    const reason = classifyFailure(new EngineCredentialsRejectedException());
    expect(reason).toBe('engine_credentials');
    expect(isRetryableFailure(reason)).toBe(false);
  });

  it('treats a 404 on an engine job and a stalled-stream timeout as retryable', () => {
    expect(isEngineJobGone(new BadGatewayException('The remote service rejected the request with status 404'))).toBe(true);
    expect(isRetryableFailure(classifyFailure(new GatewayTimeoutException('The remote service stopped sending data')))).toBe(true);
  });
});
