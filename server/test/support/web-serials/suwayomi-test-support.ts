/* eslint-disable @typescript-eslint/require-await */
import { vi } from 'vitest';

import { safeFetch } from '../../../src/common/utils/safe-fetch';
import type { EngineConnection } from '../../../src/modules/web-serials/engines/web-serial-engine';

export const conn: EngineConnection = { url: 'http://suwayomi:4567/', username: 'bookorbit', password: 'secret' };
export const BASIC = `Basic ${Buffer.from('bookorbit:secret').toString('base64')}`;

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: string;
}

export function gql(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function installGraphql(respond: (query: string, call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.mocked(safeFetch).mockImplementation(async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      query: typeof init?.body === 'string' ? (JSON.parse(init.body).query as string) : '',
    };
    calls.push(call);
    if (url.pathname === '/api/graphql') return respond(call.query, call);
    return new Response('<html>web ui</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  });
  return calls;
}
