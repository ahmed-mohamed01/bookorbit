import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyFailure } from '../web-serials-failure.utils';
import { suwayomiGraphql } from './suwayomi-graphql';

const fetchEngineResponse = vi.fn();
vi.mock('./engine-http.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./engine-http.utils')>()),
  fetchEngineResponse: (...args: unknown[]) => fetchEngineResponse(...args),
}));

const CONN = { url: 'http://suwayomi:4567', username: null, password: null };

function envelope(errors: Array<{ message?: string }>): Response {
  return new Response(JSON.stringify({ errors }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => fetchEngineResponse.mockReset());

describe('suwayomiGraphql', () => {
  it('keeps the source failure Suwayomi reported, so a passing outage is retried', async () => {
    fetchEngineResponse.mockResolvedValue(envelope([{ message: 'HttpException: HTTP error 503\n at source.fetch' }]));
    const failure = await suwayomiGraphql(CONN, 'query { x }').catch((error: unknown) => error);

    expect((failure as Error).message).toBe(
      'The remote service could not complete the GraphQL request: HttpException: HTTP error 503 at source.fetch',
    );
    expect(classifyFailure(failure)).toBe('source_unavailable');
  });

  it('classifies a blocked source and a missing series from the GraphQL message', async () => {
    fetchEngineResponse.mockResolvedValue(envelope([{ message: 'HTTP error 403 Forbidden' }]));
    expect(classifyFailure(await suwayomiGraphql(CONN, 'query { x }').catch((error: unknown) => error))).toBe('source_blocked');
    fetchEngineResponse.mockResolvedValue(envelope([{}, { message: 'Manga not found' }]));
    expect(classifyFailure(await suwayomiGraphql(CONN, 'query { x }').catch((error: unknown) => error))).toBe('not_found');
  });

  it('caps the kept message', async () => {
    fetchEngineResponse.mockResolvedValue(envelope([{ message: 'x'.repeat(1000) }]));
    const failure = (await suwayomiGraphql(CONN, 'query { x }').catch((error: unknown) => error)) as Error;
    expect(failure.message.length).toBeLessThan(300);
  });
});
