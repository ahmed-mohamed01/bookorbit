import { BadGatewayException, BadRequestException } from '@nestjs/common';

import {
  assertEngineResponseOk,
  basicAuthHeaders,
  fetchEngineResponse,
  readEngineCover,
  readEngineJson,
  responseContentType,
} from './engine-http.utils';
import type { EngineConnection } from './web-serial-engine';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from '../web-serials-error.utils';

const GRAPHQL_DETAIL_MAX_LENGTH = 200;

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export async function suwayomiGraphql<T>(conn: EngineConnection, query: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  const response = await fetchEngineResponse(
    conn.url,
    '/api/graphql',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...basicAuthHeaders(conn.username, conn.password) },
      body: JSON.stringify({ query }),
    },
    { signal, timeoutMs },
  );
  assertEngineResponseOk(response);
  const envelope = await readEngineJson<GraphqlEnvelope<T>>(response);
  if (envelope.errors?.length || envelope.data === undefined) {
    const detail = graphqlErrorDetail(envelope.errors);
    throw new BadGatewayException(
      codedError(`The remote service could not complete the GraphQL request${detail ? `: ${detail}` : ''}`, WebSerialErrorCode.EngineError),
    );
  }
  return envelope.data;
}

/** Suwayomi reports a source's own failure (a 503, a timeout, a Cloudflare page) only here, so its text decides the retry. */
function graphqlErrorDetail(errors: GraphqlEnvelope<unknown>['errors']): string {
  const message = errors?.find((error) => typeof error?.message === 'string' && error.message.trim())?.message ?? '';
  return message
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GRAPHQL_DETAIL_MAX_LENGTH);
}

export async function fetchSuwayomiImage(conn: EngineConnection, pathOrUrl: string): Promise<{ body: Buffer; contentType: string }> {
  const path = internalResourcePath(conn.url, pathOrUrl);
  const response = await fetchEngineResponse(conn.url, path, {
    method: 'GET',
    headers: basicAuthHeaders(conn.username, conn.password),
  });
  assertEngineResponseOk(response);
  const contentType = responseContentType(response);
  if (!contentType.startsWith('image/')) {
    void response.body?.cancel().catch(() => undefined);
    throw new BadGatewayException('The remote service did not return an image');
  }
  return { body: await readEngineCover(response), contentType };
}

function internalResourcePath(baseUrl: string, value: string): string {
  try {
    const parsed = new URL(value);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) throw new BadRequestException('The remote resource URL is outside the configured service');
    return `${parsed.pathname}${parsed.search}`;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if (!value.startsWith('/')) throw new BadRequestException('The remote resource path is invalid');
    return value;
  }
}
