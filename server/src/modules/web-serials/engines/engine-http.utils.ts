import { BadGatewayException, BadRequestException, GatewayTimeoutException, HttpException, ServiceUnavailableException } from '@nestjs/common';

import { readBoundedBytes, readBoundedText, ResponseTooLargeError } from '../../../common/utils/bounded-response';
import { safeFetch } from '../../../common/utils/safe-fetch';
import { ensureSafeSelfHostedUrl, selfHostedSafeRemoteHostOptions } from '../../../common/utils/self-hosted-service-url.utils';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from '../web-serials-error.utils';

export const ENGINE_HTTP_TIMEOUT_MS = 15_000;
export const ENGINE_JSON_LIMIT_BYTES = 8 * 1024 * 1024;
export const ENGINE_COVER_LIMIT_BYTES = 5 * 1024 * 1024;

export const ENGINE_STREAM_HEADERS_TIMEOUT_MS = 30_000;
export const ENGINE_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const ENGINE_CREDENTIALS_REJECTED_MESSAGE = 'The remote service rejected the configured credentials';

/**
 * Never a 401 or 403: the web client treats those as an expired BookOrbit session and logs the user out.
 * The job runner recognises it with instanceof to tell bad engine credentials from a source failure.
 */
export class EngineCredentialsRejectedException extends BadGatewayException {
  constructor(message: string = ENGINE_CREDENTIALS_REJECTED_MESSAGE) {
    super(codedError(message, WebSerialErrorCode.EngineCredentialsRejected));
  }
}

/** What an engine said about a failed call: its HTTP status and, from the novel sources service, its error code. */
export interface EngineFailure {
  status: number;
  code: string | null;
}

const ENGINE_FAILURES = new WeakMap<HttpException, EngineFailure>();

/** Failures are classified from this structure first, so a reworded message never changes whether a unit is retried. */
export function withEngineFailure<T extends HttpException>(exception: T, failure: EngineFailure): T {
  ENGINE_FAILURES.set(exception, failure);
  return exception;
}

export function engineFailureOf(error: unknown): EngineFailure | null {
  return error instanceof HttpException ? (ENGINE_FAILURES.get(error) ?? null) : null;
}

export interface EngineRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function engineEndpointUrl(baseUrl: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new BadRequestException(codedError('The configured service URL is invalid', WebSerialErrorCode.EngineUrlInvalid));
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new BadRequestException(codedError('The configured service URL must use HTTP or HTTPS', WebSerialErrorCode.EngineUrlInvalid));
  }

  const target = new URL(base.href);
  const prefix = base.pathname.replace(/\/+$/, '');
  const splitAt = path.indexOf('?');
  const pathname = splitAt === -1 ? path : path.slice(0, splitAt);
  target.pathname = `${prefix}/${pathname.replace(/^\/+/, '')}`;
  target.search = splitAt === -1 ? '' : path.slice(splitAt + 1);
  target.hash = '';
  return target;
}

export async function fetchEngineResponse(baseUrl: string, path: string, init: RequestInit, options: EngineRequestOptions = {}): Promise<Response> {
  return fetchEngine(baseUrl, path, init, options.timeoutMs ?? ENGINE_HTTP_TIMEOUT_MS, options.signal);
}

export interface EngineStreamOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  headersTimeoutMs?: number;
}

/**
 * A download response whose body errors when no bytes arrive for the idle timeout, or when the caller's signal aborts.
 * Without this a stalled engine would hold a job slot until undici's own multi-minute timeouts.
 */
export async function fetchEngineStream(baseUrl: string, path: string, init: RequestInit, options: EngineStreamOptions = {}): Promise<Response> {
  const idleTimeoutMs = options.idleTimeoutMs ?? ENGINE_STREAM_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const headersTimer = setTimeout(() => controller.abort(), options.headersTimeoutMs ?? ENGINE_STREAM_HEADERS_TIMEOUT_MS);
  headersTimer.unref();
  let response: Response;
  try {
    response = await fetchEngine(baseUrl, path, init, null, controller.signal);
  } catch (error) {
    options.signal?.removeEventListener('abort', onCallerAbort);
    throw error;
  } finally {
    clearTimeout(headersTimer);
  }
  if (!response.body) {
    options.signal?.removeEventListener('abort', onCallerAbort);
    return response;
  }

  const reader = response.body.getReader();
  let idleTimer: NodeJS.Timeout | null = null;
  const stopTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const finish = () => {
    stopTimer();
    options.signal?.removeEventListener('abort', onCallerAbort);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
      idleTimer.unref();
      try {
        const { done, value } = await reader.read();
        stopTimer();
        if (done) {
          finish();
          out.close();
        } else {
          out.enqueue(value);
        }
      } catch {
        finish();
        out.error(new GatewayTimeoutException(codedError('The remote download stalled or was cancelled', WebSerialErrorCode.EngineTimeout)));
      }
    },
    async cancel(reason) {
      finish();
      controller.abort();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function readEngineJson<T>(response: Response): Promise<T> {
  const text = await readEngineText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BadGatewayException(codedError('The remote service returned invalid JSON', WebSerialErrorCode.EngineError));
  }
}

export async function readEngineText(response: Response): Promise<string> {
  try {
    return await readBoundedText(response, ENGINE_JSON_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new BadGatewayException(codedError('The remote service response was too large', WebSerialErrorCode.EngineError));
    }
    throw error;
  }
}

export async function readEngineCover(response: Response): Promise<Buffer> {
  try {
    return await readBoundedBytes(response, ENGINE_COVER_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new BadGatewayException('The remote cover was too large');
    }
    throw error;
  }
}

export function assertEngineResponseOk(response: Response): void {
  if (response.ok) return;
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new EngineCredentialsRejectedException();
  }
  const failure = { status: response.status, code: null };
  if (response.status >= 500) {
    throw withEngineFailure(
      new ServiceUnavailableException(codedError(`The remote service answered with status ${response.status}`, WebSerialErrorCode.EngineUnreachable)),
      failure,
    );
  }
  throw withEngineFailure(
    new BadGatewayException(codedError(`The remote service rejected the request with status ${response.status}`, WebSerialErrorCode.EngineError)),
    failure,
  );
}

export function basicAuthHeaders(username: string | null, password: string | null): Record<string, string> {
  if (username === null && password === null) return {};
  return { Authorization: `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}` };
}

export function responseContentType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function responseSize(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function responseFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1] ?? disposition.match(/filename=([^;]+)/i)?.[1];
  let candidate = fallback;
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded.trim());
    } catch {
      candidate = encoded.trim();
    }
  } else if (plain) {
    candidate = plain.trim();
  }
  const leaf = candidate.split(/[\\/]/).at(-1)?.trim();
  return leaf || fallback;
}

async function fetchEngine(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number | null,
  callerSignal?: AbortSignal,
): Promise<Response> {
  await ensureSafeSelfHostedUrl(baseUrl);
  const url = engineEndpointUrl(baseUrl, path);
  const timeoutSignal = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
  const signal = combineSignals(callerSignal, timeoutSignal);
  try {
    return await safeFetch(url.href, { ...init, redirect: 'manual', ...(signal ? { signal } : {}) }, selfHostedSafeRemoteHostOptions());
  } catch (error) {
    if (signal?.aborted) {
      if (callerSignal?.aborted) throw new GatewayTimeoutException('The remote operation was cancelled');
      throw new GatewayTimeoutException(codedError('The remote service did not answer in time', WebSerialErrorCode.EngineTimeout));
    }
    if (error instanceof BadRequestException) throw error;
    throw new ServiceUnavailableException(codedError('The remote service could not be reached', WebSerialErrorCode.EngineUnreachable));
  }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal | null): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The remote service could not be reached';
}
