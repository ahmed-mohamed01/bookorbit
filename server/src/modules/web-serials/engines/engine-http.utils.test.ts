import { BadGatewayException, BadRequestException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetch } from '../../../common/utils/safe-fetch';
import { ensureSafeSelfHostedUrl } from '../../../common/utils/self-hosted-service-url.utils';
import {
  assertEngineResponseOk,
  EngineCredentialsRejectedException,
  basicAuthHeaders,
  ENGINE_JSON_LIMIT_BYTES,
  engineEndpointUrl,
  fetchEngineResponse,
  fetchEngineStream,
  readEngineCover,
  readEngineJson,
  responseContentType,
  responseFileName,
  responseSize,
} from './engine-http.utils';

vi.mock('../../../common/utils/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../../../common/utils/self-hosted-service-url.utils', () => ({
  ensureSafeSelfHostedUrl: vi.fn().mockResolvedValue(undefined),
  selfHostedSafeRemoteHostOptions: vi.fn().mockReturnValue({ marker: true }),
}));

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
  vi.mocked(ensureSafeSelfHostedUrl).mockReset().mockResolvedValue(undefined);
});

describe('engineEndpointUrl', () => {
  it('joins the path onto the base path and keeps the query', () => {
    expect(engineEndpointUrl('http://h:1/prefix/', '/api/x?a=1&b=2').href).toBe('http://h:1/prefix/api/x?a=1&b=2');
    expect(engineEndpointUrl('http://h:1', 'api/x').href).toBe('http://h:1/api/x');
  });

  it('keeps encoded path segments intact and drops a base query and hash', () => {
    expect(engineEndpointUrl('http://h:1/?q=1#frag', '/static/a%20b.epub?token=t').href).toBe('http://h:1/static/a%20b.epub?token=t');
  });

  it('rejects invalid and non-http base URLs', () => {
    expect(() => engineEndpointUrl('not a url', '/x')).toThrow(BadRequestException);
    expect(() => engineEndpointUrl('ftp://h/', '/x')).toThrow(BadRequestException);
  });
});

describe('fetchEngineResponse', () => {
  it('validates the base URL, never follows redirects and passes safe host options', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('ok'));
    await fetchEngineResponse('http://h:1', '/x', { method: 'GET' });
    expect(ensureSafeSelfHostedUrl).toHaveBeenCalledWith('http://h:1');
    const [url, init, options] = vi.mocked(safeFetch).mock.calls[0];
    expect(url).toBe('http://h:1/x');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(options).toEqual({ marker: true });
  });

  it('streams the body through unchanged and aborts nothing while bytes keep flowing', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('hello'));
    const response = await fetchEngineStream('http://h:1', '/x', { method: 'GET' });
    const signal = vi.mocked(safeFetch).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await expect(response.text()).resolves.toBe('hello');
    expect(signal?.aborted).toBe(false);
  });

  it('errors a stalled download body after the idle timeout and aborts the request', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(safeFetch).mockImplementation((_url, init) => {
      fetchSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('a'));
          fetchSignal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body));
    });
    const response = await fetchEngineStream('http://h:1', '/x', { method: 'GET' }, { idleTimeoutMs: 20 });
    await expect(response.text()).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('aborts an in-progress download when the caller signal fires', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(safeFetch).mockImplementation((_url, init) => {
      fetchSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          fetchSignal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body));
    });
    const caller = new AbortController();
    const response = await fetchEngineStream('http://h:1', '/x', { method: 'GET' }, { signal: caller.signal });
    const reading = response.text();
    caller.abort();
    await expect(reading).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('propagates an unsafe URL rejection', async () => {
    vi.mocked(ensureSafeSelfHostedUrl).mockRejectedValue(new BadRequestException('private'));
    await expect(fetchEngineResponse('http://10.0.0.1', '/x', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('maps network failures to service unavailable', async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const failure = await fetchEngineResponse('http://h:1', '/x', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toEqual({
      message: 'The remote service could not be reached',
      errorCode: 'WEB_SERIAL_ENGINE_UNREACHABLE',
    });
  });

  it('maps a timeout to gateway timeout', async () => {
    vi.mocked(safeFetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(fetchEngineResponse('http://h:1', '/x', {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('reports a caller cancellation', async () => {
    const controller = new AbortController();
    vi.mocked(safeFetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = fetchEngineResponse('http://h:1', '/x', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
  });
});

describe('assertEngineResponseOk', () => {
  it.each([
    [401, EngineCredentialsRejectedException],
    [403, EngineCredentialsRejectedException],
    [500, ServiceUnavailableException],
    [404, BadGatewayException],
  ])('maps %i', (status, type) => {
    expect(() => assertEngineResponseOk(new Response('', { status }))).toThrow(type);
  });

  it.each([401, 403])('never answers the BookOrbit client with %i, which would log the user out', (status) => {
    try {
      assertEngineResponseOk(new Response('', { status }));
      expect.unreachable();
    } catch (error) {
      expect((error as BadGatewayException).getStatus()).toBe(502);
    }
  });

  it('accepts success', () => {
    expect(() => assertEngineResponseOk(new Response('', { status: 200 }))).not.toThrow();
  });

  it.each([
    [401, 'WEB_SERIAL_ENGINE_CREDENTIALS_REJECTED'],
    [503, 'WEB_SERIAL_ENGINE_UNREACHABLE'],
    [404, 'WEB_SERIAL_ENGINE_ERROR'],
  ])('gives a %i answer the error code the client translates', (status, errorCode) => {
    try {
      assertEngineResponseOk(new Response('', { status }));
      expect.unreachable();
    } catch (error) {
      expect((error as BadGatewayException).getResponse()).toMatchObject({ errorCode });
      expect((error as Error).message).toMatch(/remote service/);
    }
  });
});

describe('body readers', () => {
  it('parses JSON and rejects invalid JSON', async () => {
    await expect(readEngineJson(new Response('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(readEngineJson(new Response('<html>'))).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects oversized JSON by content length', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(ENGINE_JSON_LIMIT_BYTES + 1) } });
    await expect(readEngineJson(response)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects an oversized cover', async () => {
    const response = new Response(Buffer.alloc(16), { headers: { 'content-length': String(6 * 1024 * 1024) } });
    await expect(readEngineCover(response)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('header helpers', () => {
  it('builds basic auth only when credentials exist', () => {
    expect(basicAuthHeaders(null, null)).toEqual({});
    expect(basicAuthHeaders('u', null).Authorization).toBe(`Basic ${Buffer.from('u:').toString('base64')}`);
    expect(basicAuthHeaders('u', 'p').Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('normalises the content type', () => {
    expect(responseContentType(new Response('', { headers: { 'content-type': 'Image/PNG; charset=x' } }))).toBe('image/png');
    expect(responseContentType(new Response(''))).toBe('text/plain');
  });

  it('reads a safe content length', () => {
    expect(responseSize(new Response('', { headers: { 'content-length': '12' } }))).toBe(12);
    expect(responseSize(new Response('', { headers: { 'content-length': 'x' } }))).toBeNull();
    expect(responseSize(new Response('', { headers: { 'content-length': '-1' } }))).toBeNull();
    expect(responseSize({ headers: new Headers() } as Response)).toBeNull();
  });

  it('extracts and sanitises the file name', () => {
    const named = (disposition: string) => responseFileName(new Response('', { headers: { 'content-disposition': disposition } }), 'fallback.bin');
    expect(named('attachment; filename="a b.cbz"')).toBe('a b.cbz');
    expect(named("attachment; filename*=UTF-8''%E3%81%82.epub")).toBe('あ.epub');
    expect(named('attachment; filename=plain.cbz')).toBe('plain.cbz');
    expect(named('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(named('attachment; filename="..\\\\x.cbz"')).toBe('x.cbz');
    expect(named('attachment')).toBe('fallback.bin');
    expect(named("attachment; filename*=UTF-8''%E0%A4%A")).toBe('%E0%A4%A');
  });
});
