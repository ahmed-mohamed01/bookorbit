import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';

import { WebSerialErrorCode } from '@bookorbit/types';
import { safeFetch } from '../../../common/utils/safe-fetch';
import { ensureSafeSelfHostedUrl, selfHostedSafeRemoteHostOptions } from '../../../common/utils/self-hosted-service-url.utils';
import { EngineCredentialsRejectedException } from '../engines/engine-http.utils';
import { codedError } from '../web-serials-error.utils';

const MAX_REDIRECTS = 5;

export interface FileIndexRequest {
  headers?: Record<string, string>;
  /** Sent only to the origin of the first URL, so a redirect to another host never receives the credentials. */
  authorization?: string | null;
  signal: AbortSignal;
}

/**
 * GET for an admin-configured file index, which may sit on the LAN like any engine. Unlike an engine, a public listing
 * often redirects (to HTTPS, or a CDN), so redirects are followed with every hop checked against the same policy.
 */
export async function fetchFileIndex(rawUrl: string, request: FileIndexRequest): Promise<Response> {
  const origin = new URL(rawUrl).origin;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = { ...request.headers };
    if (request.authorization && new URL(current).origin === origin) headers.Authorization = request.authorization;
    const response = await fetchOnce(current, headers, request.signal);
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location) throw new BadGatewayException(codedError('The file index redirected without a location', WebSerialErrorCode.EngineError));
    current = new URL(location, current).href;
  }
  throw new BadGatewayException(codedError('The file index redirected too many times', WebSerialErrorCode.EngineError));
}

export function assertFileIndexOk(response: Response): void {
  if (response.ok || response.status === 304) return;
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403)
    throw new EngineCredentialsRejectedException('The file index rejected the configured credentials');
  if (response.status >= 500) {
    throw new ServiceUnavailableException(codedError(`The file index answered with status ${response.status}`, WebSerialErrorCode.EngineUnreachable));
  }
  throw new BadGatewayException(codedError(`The file index answered with status ${response.status}`, WebSerialErrorCode.EngineError));
}

async function fetchOnce(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  if (!/^https?:\/\//i.test(url))
    throw new BadGatewayException(codedError('The file index redirected to an unsupported address', WebSerialErrorCode.EngineError));
  await ensureSafeSelfHostedUrl(url);
  try {
    return await safeFetch(url, { headers, redirect: 'manual', signal }, selfHostedSafeRemoteHostOptions());
  } catch (error) {
    if (signal.aborted) throw new GatewayTimeoutException(codedError('The file index did not answer in time', WebSerialErrorCode.EngineTimeout));
    if (error instanceof BadGatewayException) throw error;
    throw new ServiceUnavailableException(codedError('The file index could not be reached', WebSerialErrorCode.EngineUnreachable));
  }
}
