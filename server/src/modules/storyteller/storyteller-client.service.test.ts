import { access, mkdtemp, readFile, rm, truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSafeUrl } from '../../common/utils/ssrf.utils';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import type { StorytellerSession } from './storyteller-client.types';

// The client now runs every outbound URL through the shared SSRF gate; the gate itself is covered
// by its own tests, and resolving a fixture hostname here would only buy a DNS lookup.
vi.mock('../../common/utils/ssrf.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/utils/ssrf.utils')>()),
  ensureSafeUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedEnsureSafeUrl = vi.mocked(ensureSafeUrl);

const SERVER_URL = 'https://storyteller.example.com';
const USERNAME = 'bookorbit-service';
const PASSWORD = 'correct-horse-battery-staple';
const TOKEN = 'token-one';
const REFRESHED_TOKEN = 'token-two';
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120 * 60_000;
const IDLE_TIMEOUT_MS = 400;

function client(): StorytellerClientService {
  return new StorytellerClientService({ requestTimeoutMs: REQUEST_TIMEOUT_MS, transferTimeoutMs: TRANSFER_TIMEOUT_MS });
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

function tokenResponse(value = TOKEN, expiresIn: unknown = 3_600_000): Response {
  return json({ access_token: value, token_type: 'bearer', expires_in: expiresIn });
}

function zipBytes(payload = 'read-along'): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Buffer.from(payload, 'utf8')]);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** A server that accepts the connection and then says nothing until the client gives up. */
function blackhole(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
  });
}

/** A body that delivers each chunk after `gapMs`, then closes. */
function drippingBody(chunks: Uint8Array[], gapMs: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const next = chunks[index];
          index += 1;
          if (next) controller.enqueue(next);
          else controller.close();
          resolve();
        }, gapMs);
      });
    },
  });
}

/** A body that reports whether the client cancelled it instead of leaving the socket to rot. */
function trackedBody(): { body: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
}

/** A body that delivers one chunk and then stops sending without closing the stream. */
function stallingBody(first: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
  });
}

/** A body that delivers one chunk and then dies with a connection error instead of closing. */
function erroringBody(first: Uint8Array, cause: Error): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return undefined;
      }
      return Promise.reject(cause);
    },
  });
}

async function consumeUploadBody(body: BodyInit | null | undefined, gapMs: number): Promise<number> {
  if (!(body instanceof ReadableStream)) throw new Error('expected a streaming upload body');
  const reader = body.getReader();
  let bytes = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

type FetchMock = (url: unknown, init?: RequestInit) => Promise<Response>;

describe('StorytellerClientService', () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchMock>>;
  let session: StorytellerSession;
  let tempDir: string;
  let logs: string[];

  function call(index: number): { url: URL; init: RequestInit; headers: Record<string, string> } {
    const [target, init] = fetchMock.mock.calls[index];
    return { url: new URL(String(target)), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
  }

  function bodyOf(init: RequestInit): string {
    return typeof init.body === 'string' ? init.body : '';
  }

  function tokenCalls(): unknown[] {
    return fetchMock.mock.calls.filter((entry) => String(entry[0]).includes('/api/v2/token'));
  }

  function tunedSession(requestTimeoutMs: number, transferTimeoutMs: number): StorytellerSession {
    return new StorytellerClientService({ requestTimeoutMs, transferTimeoutMs }).createSession({
      serverUrl: SERVER_URL,
      username: USERNAME,
      password: PASSWORD,
    });
  }

  /** A session whose idle deadline is short enough to observe without waiting on the real one. */
  function impatientSession(requestTimeoutMs: number): StorytellerSession {
    return tunedSession(requestTimeoutMs, TRANSFER_TIMEOUT_MS);
  }

  function record(...responses: Response[]): void {
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(String(message));
      });
    }
    fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal('fetch', fetchMock);
    tempDir = await mkdtemp(join(tmpdir(), 'storyteller-client-'));
    session = client().createSession({ serverUrl: `${SERVER_URL}/`, username: USERNAME, password: PASSWORD });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('rejects a server URL that is not http(s)', () => {
      expect(() => client().createSession({ serverUrl: 'ftp://storyteller.example.com', username: USERNAME, password: PASSWORD })).toThrow(
        StorytellerClientError,
      );
      expect(() => client().createSession({ serverUrl: 'not a url', username: USERNAME, password: PASSWORD })).toThrow(StorytellerClientError);
    });

    it('rejects a server URL carrying credentials', () => {
      expect(() =>
        client().createSession({ serverUrl: 'https://user:secret@storyteller.example.com', username: USERNAME, password: PASSWORD }),
      ).toThrow(/must not carry credentials/);
    });

    it('strips a trailing slash from the server URL', async () => {
      record(tokenResponse(), json([]));
      await session.listBooks();

      expect(call(0).url.toString()).toBe(`${SERVER_URL}/api/v2/token`);
      expect(call(1).url.pathname).toBe('/api/v2/books');
    });
  });

  describe('token handling', () => {
    it('mints a token once and reuses it', async () => {
      record(tokenResponse(), json([]), json([]));

      await session.listBooks();
      await session.listBooks();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const mint = call(0);
      expect(mint.init.method).toBe('POST');
      expect(mint.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(bodyOf(mint.init)).toContain(`usernameOrEmail=${encodeURIComponent(USERNAME)}`);
      expect(call(1).headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call(2).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('mints once for a burst of parallel calls on a cold session', async () => {
      record(tokenResponse(), json({ uuid: 'book-1' }), json({ uuid: 'book-1' }));

      const [first, second] = await Promise.all([session.getBook('book-1'), session.getBook('book-1')]);

      expect(first?.uuid).toBe('book-1');
      expect(second?.uuid).toBe('book-1');
      expect(tokenCalls()).toHaveLength(1);
    });

    it('reuses the token when the server reports an unusable expires_in', async () => {
      record(tokenResponse(TOKEN, 'whenever'), json([]), json([]));

      await session.listBooks();
      await session.listBooks();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('mints again on a 401 and retries the request exactly once', async () => {
      record(tokenResponse(), text('expired', 401), tokenResponse(REFRESHED_TOKEN), json([{ uuid: 'book-1', title: 'Foundation' }]));

      const books = await session.listBooks();

      expect(books).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(call(2).url.pathname).toBe('/api/v2/token');
      expect(call(3).headers.Authorization).toBe(`Bearer ${REFRESHED_TOKEN}`);
    });

    it('surfaces a second 401 instead of minting forever', async () => {
      record(tokenResponse(), text('nope', 401), tokenResponse(REFRESHED_TOKEN), text('nope', 401));

      await expect(session.listBooks()).rejects.toMatchObject({ name: 'StorytellerClientError', status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('maps a rejected service account to a client error', async () => {
      record(text('bad credentials', 401));

      await expect(session.listBooks()).rejects.toMatchObject({ name: 'StorytellerClientError', status: 401 });
    });

    it('fails when the token response carries no access token', async () => {
      record(json({ token_type: 'bearer' }));

      await expect(session.listBooks()).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'Storyteller did not return an access token',
      });
    });

    it('reports an unreadable body, not a missing token, when the token response errors partway through', async () => {
      record(
        new Response(erroringBody(new TextEncoder().encode('{"access_token":"x'), new Error('socket hang up')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(session.listBooks()).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'Storyteller returned a response that is not JSON',
      });
    });

    it('reports a response that is not JSON, not a missing token, when the token body is truncated but closes cleanly', async () => {
      record(new Response('{"access_token":"x', { status: 200, headers: { 'content-type': 'application/json' } }));

      await expect(session.listBooks()).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'Storyteller returned a response that is not JSON',
      });
    });

    it('reports a response that is not JSON, not a missing token, when the token body is not JSON at all', async () => {
      record(new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } }));

      await expect(session.listBooks()).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'Storyteller returned a response that is not JSON',
      });
    });

    it('reports a timeout, not a missing token, when the token response body stalls', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const impatient = impatientSession(IDLE_TIMEOUT_MS);
      record(
        new Response(stallingBody(new TextEncoder().encode('{"access_token":"x"')), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      let failure: unknown;
      const request = impatient.listBooks().catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

      expect(failure).toBeInstanceOf(StorytellerClientError);
      expect((failure as Error).message).toMatch(/timed out/i);
      expect((failure as Error).message).not.toContain('access token');
      await request;
    });

    it('keeps a network failure while minting retryable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(true);
      expect(tokenCalls()).toHaveLength(2);
    });

    it('never writes the password or the token into a log line', async () => {
      record(tokenResponse(), text('expired', 401), tokenResponse(REFRESHED_TOKEN), json([]));

      await session.listBooks();

      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain(PASSWORD);
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(REFRESHED_TOKEN);
      }
    });

    it('redacts credentials a provider echoes back in an error body', async () => {
      record(tokenResponse(), text(`rejected header Bearer ${TOKEN} for password ${PASSWORD}`, 403));

      const failure = await session.process('book-1').catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StorytellerClientError);
      expect((failure as Error).message).not.toContain(TOKEN);
      expect((failure as Error).message).not.toContain(PASSWORD);
      expect((failure as Error).message).toContain('[redacted]');
      for (const line of logs) {
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(PASSWORD);
      }
    });
  });

  describe('getServerInfo', () => {
    it('merges the version and both capability shapes', async () => {
      record(
        tokenResponse(),
        json({ version: '3.1.0', capabilities: ['readaloud-process', 'book-upload'] }),
        json({ ctcDevices: { available: [] } }),
      );

      await expect(session.getServerInfo()).resolves.toEqual({
        version: '3.1.0',
        capabilities: ['book-upload', 'ctcDevices', 'readaloud-process'],
      });
    });

    it('still reports the version when capabilities are unavailable', async () => {
      record(tokenResponse(), json({ serverVersion: '2.9.0' }), text('not found', 404));

      await expect(session.getServerInfo()).resolves.toEqual({ version: '2.9.0', capabilities: [] });
    });

    it('keeps an HTML error page out of the thrown message', async () => {
      record(
        tokenResponse(),
        new Response('<!DOCTYPE html><html><head><title>404</title></head><body>Not found</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      await expect(session.getServerInfo()).rejects.toMatchObject({ message: 'Storyteller answered 502', status: 502 });
    });

    it('reports an unknown version when the build has neither server route', async () => {
      record(tokenResponse(), text('<!DOCTYPE html>not found', 404), text('<!DOCTYPE html>not found', 404));

      await expect(session.getServerInfo()).resolves.toEqual({ version: null, capabilities: [] });
    });

    it('still fails when the details route answers with a server error', async () => {
      record(tokenResponse(), text('boom', 500), text('boom', 500), text('boom', 500));

      await expect(session.getServerInfo()).rejects.toMatchObject({ name: 'StorytellerClientError', status: 500 });
    });

    it('names the transport cause instead of a bare fetch failure', async () => {
      record(tokenResponse());
      const failure = new TypeError('fetch failed');
      (failure as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8001'), { code: 'ECONNREFUSED' });
      fetchMock.mockRejectedValue(failure);

      await expect(session.getServerInfo()).rejects.toMatchObject({
        message: expect.stringContaining('connect ECONNREFUSED 127.0.0.1:8001'),
      });
    });

    it('gives up on a blackholed server within the request timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      record(tokenResponse());
      fetchMock.mockImplementation(blackhole);

      const probe = expect(session.getServerInfo()).rejects.toMatchObject({ name: 'StorytellerClientError' });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await probe;

      // One mint plus one probe: a hanging server must not buy three attempts and two backoffs.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSettings', () => {
    it('reads the flat settings payload', async () => {
      record(
        tokenResponse(),
        json({
          readaloudLocationType: 'CUSTOM_FOLDER',
          readaloudLocation: '/storyteller/readalongs',
          importMode: 'reference',
          aligner: 'ctc',
        }),
      );

      await expect(session.getSettings()).resolves.toEqual({
        readaloudLocationType: 'CUSTOM_FOLDER',
        readaloudLocation: '/storyteller/readalongs',
        importMode: 'reference',
        aligner: 'ctc',
      });
    });

    it('reads settings nested under a settings key and rejects an unknown location type', async () => {
      record(tokenResponse(), json({ settings: { readaloudLocationType: 'SOMEWHERE_ELSE', readaloudLocation: '/x' } }));

      const settings = await session.getSettings();
      expect(settings.readaloudLocationType).toBeNull();
      expect(settings.readaloudLocation).toBe('/x');
    });
  });

  describe('books', () => {
    it('asks only for aligned books when told to', async () => {
      record(tokenResponse(), json({ books: [{ uuid: 'book-1', title: 'Foundation' }] }));

      const books = await session.listBooks({ alignedOnly: true });

      expect(books.map((book) => book.uuid)).toEqual(['book-1']);
      expect(call(1).url.search).toBe('?alignedOnly=true');
    });

    it('returns null for a book Storyteller does not know', async () => {
      record(tokenResponse(), text('not found', 404));

      await expect(session.getBook('missing')).resolves.toBeNull();
    });

    it('fails rather than reading an unusable 200 as a missing book', async () => {
      record(tokenResponse(), json({ message: 'something else entirely' }));

      // Null is reserved for the 404: a caller that takes this for an absence imports a duplicate.
      await expect(session.getBook('book-1')).rejects.toThrow(/could not be read/);
    });

    it('gives up when response headers arrive but the JSON body stalls', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const impatient = impatientSession(IDLE_TIMEOUT_MS);
      record(tokenResponse(), new Response(stallingBody(new TextEncoder().encode('{"uuid":"book-1"'))));

      let failure: unknown;
      const request = impatient.getBook('book-1').catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

      expect(failure).toBeInstanceOf(StorytellerClientError);
      expect((failure as Error).message).toMatch(/timed out/i);
      expect((failure as Error).message).not.toContain('not JSON');
      await request;
    });

    it('clears the response deadline after consuming the body', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      record(tokenResponse(), json({ uuid: 'book-1', title: 'Foundation' }));

      await session.getBook('book-1');

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('outbound URL safety', () => {
    it('runs every request through the SSRF gate and never follows a redirect', async () => {
      record(tokenResponse(), json([]));

      await session.listBooks();

      expect(mockedEnsureSafeUrl).toHaveBeenCalledWith(`${SERVER_URL}/api/v2/token`, expect.anything());
      expect(mockedEnsureSafeUrl).toHaveBeenCalledWith(`${SERVER_URL}/api/v2/books`, expect.anything());
      for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('manual');
    });

    it('refuses a target the gate rejects without sending the request', async () => {
      mockedEnsureSafeUrl.mockRejectedValueOnce(new Error('URL resolves to a private or local address'));

      await expect(session.listBooks()).rejects.toThrow(/not an allowed request target/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a redirect as a failure instead of carrying the token to it', async () => {
      record(tokenResponse(), new Response(null, { status: 302, headers: { location: 'https://evil.example.com/api/v2/books' } }));

      await expect(session.listBooks()).rejects.toMatchObject({ name: 'StorytellerClientError', status: 302 });
      const refused = logs.find((line) => line.includes('redirect rejected'));
      expect(refused).toContain('status=302');
    });
  });

  describe('importByReference', () => {
    it('reports the created book', async () => {
      record(tokenResponse(), json({ uuid: 'book-9', title: 'Foundation' }));

      await expect(
        session.importByReference({ paths: ['/data/Foundation.epub', '/data/audio'], importMode: 'reference', collectionUuid: 'collection-1' }),
      ).resolves.toEqual({ kind: 'created', uuid: 'book-9' });

      expect(JSON.parse(bodyOf(call(1).init))).toEqual({
        paths: ['/data/Foundation.epub', '/data/audio'],
        importMode: 'reference',
        collection: 'collection-1',
      });
    });

    it('reports an epub2 answer instead of a book', async () => {
      record(tokenResponse(), json({ epub2Detected: true, paths: ['/data/Foundation.epub'] }));

      await expect(session.importByReference({ paths: ['/data/Foundation.epub'], importMode: 'reference' })).resolves.toEqual({
        kind: 'epub2_detected',
        paths: ['/data/Foundation.epub'],
      });
    });

    it('fails when the response holds no book and says so with a complete fail log', async () => {
      record(tokenResponse(), json({ message: 'Unable to create book from provided paths' }));

      await expect(session.importByReference({ paths: ['/data/Foundation.epub'], importMode: 'reference' })).rejects.toThrow(StorytellerClientError);

      const failure = logs.find((line) => line.includes('[storyteller.client.import] [fail]'));
      expect(failure).toMatch(/durationMs=\d+/);
      expect(failure).toContain('errorClass=');
    });
  });

  describe('uploadBook', () => {
    async function writeFixture(name: string, size: number, fill = 1): Promise<string> {
      const path = join(tempDir, name);
      await writeFile(path, Buffer.alloc(size, fill));
      return path;
    }

    it('uploads every file in chunks and finalizes with the generated uuid', async () => {
      const epubPath = await writeFixture('Foundation.epub', 6 * 1024 * 1024);
      const audioPath = await writeFixture('01.mp3', 1024, 2);

      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': String(5 * 1024 * 1024) }),
        noContent({ 'upload-offset': String(6 * 1024 * 1024) }),
        new Response(null, { status: 201, headers: { location: `${SERVER_URL}/api/v2/books/upload/upload-2` } }),
        noContent({ 'upload-offset': '1024' }),
        noContent(),
      );

      const progress: Array<[number, number]> = [];
      const result = await session.uploadBook({
        epubPath,
        audioPaths: [audioPath],
        collectionUuid: 'collection-1',
        onProgress: (uploaded, total) => progress.push([uploaded, total]),
      });

      const metadata = Object.fromEntries(
        (call(1).headers['Upload-Metadata'] ?? '').split(',').map((pair) => {
          const [key, value] = pair.split(' ');
          return [key, Buffer.from(value, 'base64').toString('utf8')];
        }),
      );
      expect(metadata).toEqual({ bookUuid: result.uuid, filename: 'Foundation.epub', filetype: 'application/epub+zip' });
      expect(call(1).headers['Upload-Length']).toBe(String(6 * 1024 * 1024));
      expect(call(1).headers['Tus-Resumable']).toBe('1.0.0');

      expect(call(2).url.pathname).toBe('/api/v2/books/upload/upload-1');
      expect(call(2).init.method).toBe('PATCH');
      expect(call(2).headers['Upload-Offset']).toBe('0');
      expect(call(2).headers['Content-Type']).toBe('application/offset+octet-stream');
      expect(call(2).init.body).toBeInstanceOf(ReadableStream);
      expect((call(2).init as RequestInit & { duplex?: string }).duplex).toBe('half');
      expect(call(3).headers['Upload-Offset']).toBe(String(5 * 1024 * 1024));
      expect(call(3).init.body).toBeInstanceOf(ReadableStream);

      expect(call(6).url.pathname).toBe('/api/v2/books/upload/finalize');
      expect(JSON.parse(bodyOf(call(6).init))).toEqual({ bookUuid: result.uuid, collectionUuid: 'collection-1' });
      expect(progress.at(-1)).toEqual([6 * 1024 * 1024 + 1024, 6 * 1024 * 1024 + 1024]);
    });

    it('stops between chunks once the signal aborts, reclaims the upload and never finalizes', async () => {
      const epubPath = await writeFixture('Cancelled.epub', 1024, 3);
      const controller = new AbortController();
      controller.abort();

      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': '1024' }),
        noContent(),
      );

      await expect(session.uploadBook({ epubPath, audioPaths: [], signal: controller.signal })).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'The upload was cancelled',
      });
      expect(call(3).init.method).toBe('DELETE');
      expect(call(3).url.pathname).toBe('/api/v2/books/upload/upload-1');
      expect(fetchMock.mock.calls.some(([target]) => String(target).includes('/upload/finalize'))).toBe(false);
      expect(logs.some((line) => line.startsWith('[storyteller.client.upload] [fail]'))).toBe(false);
      expect(logs.some((line) => line.startsWith('[storyteller.client.upload] [end]') && line.includes('outcome=cancelled'))).toBe(true);
    });

    it('resumes from the offset the server reports after a failed chunk', async () => {
      const epubPath = await writeFixture('Small.epub', 1024, 3);

      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'upload-offset': '512' } }));
      fetchMock.mockResolvedValueOnce(noContent({ 'upload-offset': '1024' }));
      fetchMock.mockResolvedValueOnce(noContent());

      await session.uploadBook({ epubPath, audioPaths: [] });

      expect(call(3).init.method).toBe('HEAD');
      expect(call(4).init.method).toBe('PATCH');
      expect(call(4).headers['Upload-Offset']).toBe('512');
      expect(call(4).init.body).toBeInstanceOf(ReadableStream);
      expect(call(5).url.pathname).toBe('/api/v2/books/upload/finalize');
    });

    it('resets the failure budget whenever the resumed offset advances', async () => {
      const epubPath = await writeFixture('Progressing.epub', 12, 3);
      let patchAttempts = 0;

      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));
      fetchMock.mockImplementation((_url, init) => {
        if (init?.method === 'PATCH') {
          patchAttempts += 1;
          return Promise.reject(new Error('response lost after upload progress'));
        }
        if (init?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200, headers: { 'upload-offset': String(patchAttempts * 4) } }));
        }
        return Promise.resolve(noContent());
      });

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).resolves.toEqual({ uuid: expect.any(String) });
      expect(patchAttempts).toBe(3);
    });

    it('keeps a slow upload alive while bytes continue to move', async () => {
      const size = 4 * 64 * 1024;
      const epubPath = await writeFixture('Slow.epub', size, 3);
      const impatient = impatientSession(40);

      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const accepted = await consumeUploadBody(init?.body, 20);
        return noContent({ 'upload-offset': String(accepted) });
      });
      fetchMock.mockResolvedValueOnce(noContent());

      await expect(impatient.uploadBook({ epubPath, audioPaths: [] })).resolves.toEqual({ uuid: expect.any(String) });
    });

    it('aborts an upload that makes no progress for the idle window', async () => {
      const epubPath = await writeFixture('Stalled.epub', 16, 4);
      const impatient = impatientSession(30);

      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));
      fetchMock.mockImplementation(async (_url, init) => {
        if (init?.method === 'PATCH') return blackhole(_url, init);
        if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': '0' } });
        return noContent();
      });

      await expect(impatient.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(StorytellerClientError);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(3);
    });

    it('re-reads the offset when a chunk is acknowledged without an Upload-Offset header', async () => {
      const epubPath = await writeFixture('Small.epub', 1024, 3);

      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent(),
        new Response(null, { status: 200, headers: { 'upload-offset': '512' } }),
        noContent({ 'upload-offset': '1024' }),
        noContent(),
      );

      await session.uploadBook({ epubPath, audioPaths: [] });

      expect(call(3).init.method).toBe('HEAD');
      expect(call(4).headers['Upload-Offset']).toBe('512');
    });

    it('refuses an acknowledgement that did not move, or moved past the file', async () => {
      const epubPath = await writeFixture('Small.epub', 1024, 3);

      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': '0' }),
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        noContent({ 'upload-offset': String(1024 + 100) }),
        new Response(null, { status: 200, headers: { 'upload-offset': String(1024 + 100) } }),
      );

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/unexpected upload offset/);
    });

    it('rejects an upload location that leaves the server URL', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      record(tokenResponse(), new Response(null, { status: 201, headers: { location: 'https://evil.example.com/api/v2/books/upload/upload-1' } }));

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/outside its own server URL/);
    });

    it('rejects an upload location that leaves a sub-path installation', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      const subPathSession = client().createSession({ serverUrl: `${SERVER_URL}/storyteller`, username: USERNAME, password: PASSWORD });
      record(tokenResponse(), new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));

      await expect(subPathSession.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/outside its own server URL/);
    });

    // The failure path later sends a DELETE to whatever this returned, with the service account's
    // token. Same-origin is not enough: the remote must not be able to name another route, or the
    // one query parameter the module refuses to send itself.
    it.each([
      ['a different route', '/api/v2/books/some-uuid/cache'],
      ['the upload route with a query', '/api/v2/books/upload/upload-1?originals=true'],
    ])('refuses an upload location naming %s', async (_label, location) => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      record(tokenResponse(), new Response(null, { status: 201, headers: { location } }));

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/upload location/i);
    });

    it('accepts an upload location inside a sub-path installation', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      const subPathSession = client().createSession({ serverUrl: `${SERVER_URL}/storyteller`, username: USERNAME, password: PASSWORD });
      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/storyteller/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': '16' }),
        noContent(),
      );

      await expect(subPathSession.uploadBook({ epubPath, audioPaths: [] })).resolves.toEqual({ uuid: expect.any(String) });
      expect(call(2).url.pathname).toBe('/storyteller/api/v2/books/upload/upload-1');
    });

    it('fails when the upload create call returns no location', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      record(tokenResponse(), new Response(null, { status: 201 }));

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(StorytellerClientError);
    });

    it('fails rather than padding a chunk the file no longer holds', async () => {
      const epubPath = await writeFixture('Shrinking.epub', 1024, 7);

      fetchMock.mockResolvedValueOnce(tokenResponse());
      // The file loses half its bytes between the size probe and the read, so the read comes back
      // short and the rest of the chunk is still the zero-filled buffer.
      fetchMock.mockImplementationOnce(async () => {
        await truncate(epubPath, 512);
        return new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } });
      });
      record(noContent({ 'upload-offset': '1024' }), noContent());

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/ended before its expected size/);
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(false);
    });

    it('bounds a stalled chunk by the idle timeout rather than the transfer ceiling', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      record(tokenResponse(), new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }));
      fetchMock.mockImplementation(blackhole);

      // A stalled chunk that carries only the transfer ceiling would sit on this socket for two hours.
      await expect(impatientSession(IDLE_TIMEOUT_MS).uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(StorytellerClientError);

      // The wedged PATCH and the offset re-read that follows it, each given the request timeout, then
      // the TUS DELETE that hands the transferred bytes back rather than stranding them.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe('DELETE');
    });

    it('gives up when the upload as a whole runs past the transfer ceiling', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      const tight = tunedSession(REQUEST_TIMEOUT_MS, 20);

      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } });
      });
      record(noContent({ 'upload-offset': '16' }), noContent());

      await expect(tight.uploadBook({ epubPath, audioPaths: [] })).rejects.toThrow(/exceeded the transfer ceiling/);
    });

    it('discards the finalize response body', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      const tracked = trackedBody();
      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': '16' }),
        new Response(tracked.body, { status: 200 }),
      );

      await session.uploadBook({ epubPath, audioPaths: [] });

      expect(tracked.wasCancelled()).toBe(true);
    });

    it('deletes every staged upload when finalize fails', async () => {
      const epubPath = await writeFixture('Small.epub', 16, 4);
      record(
        tokenResponse(),
        new Response(null, { status: 201, headers: { location: '/api/v2/books/upload/upload-1' } }),
        noContent({ 'upload-offset': '16' }),
        text('finalize failed', 500),
        noContent(),
      );

      await expect(session.uploadBook({ epubPath, audioPaths: [] })).rejects.toMatchObject({ status: 500 });

      expect(call(4).init.method).toBe('DELETE');
      expect(call(4).url.pathname).toBe('/api/v2/books/upload/upload-1');
      expect(logs.find((line) => line.includes('[storyteller.client.upload_reclaim] [end]'))).toContain('stranded=0');
    });

    it('reports an unreadable local file without naming it', async () => {
      const missingPath = join(tempDir, 'nowhere', 'Missing.epub');

      const failure = await session.uploadBook({ epubPath: missingPath, audioPaths: [] }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StorytellerClientError);
      expect((failure as Error).message).toBe('A file for the Storyteller upload could not be read');
      expect((failure as Error).message).not.toContain(missingPath);
    });
  });

  describe('process', () => {
    it('starts processing', async () => {
      record(tokenResponse(), noContent());

      await session.process('book-1');

      expect(call(1).url.pathname).toBe('/api/v2/books/book-1/process');
      expect(call(1).init.method).toBe('POST');
    });

    it('maps a refusal to a client error carrying the status', async () => {
      record(tokenResponse(), text('media still missing', 409));

      await expect(session.process('book-1')).rejects.toMatchObject({ name: 'StorytellerClientError', status: 409 });
    });
  });

  describe('cancelProcessing', () => {
    it('sends a DELETE to the process route', async () => {
      record(tokenResponse(), noContent());

      await expect(session.cancelProcessing('book-1')).resolves.toBeUndefined();

      expect(call(1).init.method).toBe('DELETE');
      expect(call(1).url.pathname).toBe('/api/v2/books/book-1/process');
    });

    it.each([404, 409])('treats %i as nothing left to cancel', async (status) => {
      record(tokenResponse(), text('nothing running', status));

      await expect(session.cancelProcessing('book-1')).resolves.toBeUndefined();
    });

    it('throws on any other refusal', async () => {
      record(tokenResponse(), text('boom', 500));

      await expect(session.cancelProcessing('book-1')).rejects.toMatchObject({ name: 'StorytellerClientError', status: 500 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('readaloudAvailable', () => {
    it('is true when the file responds to HEAD', async () => {
      record(tokenResponse(), new Response(null, { status: 200, headers: { 'content-type': 'application/epub+zip' } }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(true);
      expect(call(1).init.method).toBe('HEAD');
      expect(call(1).url.search).toBe('?format=readaloud');
    });

    it('is true when the server declares no content type', async () => {
      record(tokenResponse(), new Response(null, { status: 200 }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(true);
    });

    it('is false when the file is not there yet', async () => {
      record(tokenResponse(), new Response(null, { status: 404 }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(false);
    });

    it('refuses a login page answered with 200', async () => {
      record(tokenResponse(), new Response(null, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(false);
    });

    it('falls back to a ranged GET when HEAD is not supported', async () => {
      record(tokenResponse(), new Response(null, { status: 405 }), new Response('P', { status: 206 }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(true);
      expect(call(2).init.method).toBe('GET');
      expect(call(2).headers.Range).toBe('bytes=0-0');
    });

    it('refuses a JSON envelope answered to the ranged GET', async () => {
      record(tokenResponse(), new Response(null, { status: 405 }), json({ message: 'not ready' }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(false);
    });

    it('surfaces a status it cannot interpret', async () => {
      record(tokenResponse(), new Response(null, { status: 405 }), new Response(null, { status: 403 }));

      await expect(session.readaloudAvailable('book-1')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('downloadReadaloud', () => {
    it('streams the archive to the destination', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response(zipBytes(), { status: 200 }));

      await session.downloadReadaloud('book-1', destination);

      expect(await readFile(destination)).toEqual(Buffer.from(zipBytes()));
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('refuses a body that is not a zip archive and leaves nothing behind', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response('<html>not ready</html>', { status: 200 }));

      await expect(session.downloadReadaloud('book-1', destination)).rejects.toThrow(StorytellerClientError);
      await expect(access(destination)).rejects.toThrow();
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('gives up on a transfer that stops delivering bytes', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response(stallingBody(zipBytes()), { status: 200 }));

      await expect(impatientSession(IDLE_TIMEOUT_MS).downloadReadaloud('book-1', destination)).rejects.toThrow(/stalled/);
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('removes the partial file when the transfer ceiling expires', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response(stallingBody(zipBytes()), { status: 200 }));

      await expect(tunedSession(1_000, 20).downloadReadaloud('book-1', destination)).rejects.toThrow(/transfer ceiling/);
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('keeps a slow but steady transfer alive past the idle timeout', async () => {
      const destination = join(tempDir, 'download.epub');
      const chunks = [zipBytes('one'), new Uint8Array([2, 2, 2]), new Uint8Array([3, 3, 3]), new Uint8Array([4, 4, 4])];
      // Every gap is well inside the idle timeout, while the transfer as a whole runs past it.
      record(tokenResponse(), new Response(drippingBody(chunks, IDLE_TIMEOUT_MS / 4), { status: 200 }));

      await impatientSession(IDLE_TIMEOUT_MS).downloadReadaloud('book-1', destination);

      expect(await readFile(destination)).toEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    });

    it('refuses to replace a read-along that already sits at the destination', async () => {
      const destination = join(tempDir, 'download.epub');
      await writeFile(destination, 'an earlier build');
      record(tokenResponse(), new Response(zipBytes(), { status: 200 }));

      await expect(session.downloadReadaloud('book-1', destination)).rejects.toThrow(/already sits at the download destination/);
      expect(await readFile(destination, 'utf8')).toBe('an earlier build');
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('refuses a partial body answered to the download', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response(zipBytes(), { status: 206 }));

      await expect(session.downloadReadaloud('book-1', destination)).rejects.toThrow(/partial body/);
      await expect(access(destination)).rejects.toThrow();
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('refuses a body that stops short of the length the server declared', async () => {
      const destination = join(tempDir, 'download.epub');
      record(tokenResponse(), new Response(zipBytes(), { status: 200, headers: { 'content-length': String(zipBytes().byteLength + 64) } }));

      await expect(session.downloadReadaloud('book-1', destination)).rejects.toThrow(/before the whole file arrived/);
      await expect(access(destination)).rejects.toThrow();
      await expect(access(`${destination}.part`)).rejects.toThrow();
    });

    it('maps a failed download to a client error', async () => {
      record(tokenResponse(), text('not found', 404));

      await expect(session.downloadReadaloud('book-1', join(tempDir, 'download.epub'))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('deleteBook', () => {
    // The collection route is the one whose contract is verified: it reads `books` and
    // `preventReImport` from the JSON body. A per-book DELETE carrying the flag as a query parameter
    // would fail silently either way - defaulting the flag to false, or 404ing into a best-effort
    // catch - so the flag would never actually be applied.
    it('sends the uuid and the re-import flag in the body of the collection route', async () => {
      record(tokenResponse(), noContent());

      await session.deleteBook('book-1', { preventReImport: true });

      expect(call(1).init.method).toBe('DELETE');
      expect(call(1).url.pathname).toBe('/api/v2/books');
      expect(call(1).url.search).toBe('');
      expect(JSON.parse(call(1).init.body as string)).toEqual({ books: ['book-1'], preventReImport: true });
    });

    it('defaults the re-import flag rather than omitting it', async () => {
      record(tokenResponse(), noContent());

      await session.deleteBook('book-1');

      expect(JSON.parse(call(1).init.body as string)).toEqual({ books: ['book-1'], preventReImport: false });
    });
  });

  describe('collections', () => {
    it('reuses a collection that already exists', async () => {
      record(tokenResponse(), json([{ uuid: 'collection-1', name: 'BookOrbit' }]));

      await expect(session.ensureCollection('bookorbit')).resolves.toBe('collection-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('creates the collection when it is missing', async () => {
      record(tokenResponse(), json([]), json({ uuid: 'collection-2', name: 'BookOrbit' }));

      await expect(session.ensureCollection('BookOrbit')).resolves.toBe('collection-2');
      expect(JSON.parse(bodyOf(call(2).init))).toEqual({ name: 'BookOrbit', public: true });
    });

    it('gives up quietly when Storyteller refuses collections', async () => {
      record(tokenResponse(), text('forbidden', 403));

      await expect(session.ensureCollection('BookOrbit')).resolves.toBeNull();

      const failure = logs.find((line) => line.includes('[storyteller.client.collection] [fail]'));
      expect(failure).toMatch(/durationMs=\d+/);
      expect(failure).toContain('errorClass=StorytellerClientError');
    });
  });

  describe('response bodies', () => {
    it('discards the body of every acknowledged write', async () => {
      const tracked = [trackedBody(), trackedBody(), trackedBody()];
      record(tokenResponse(), ...tracked.map((entry) => new Response(entry.body, { status: 200 })));

      await session.process('book-1');
      await session.deleteBook('book-1');
      await session.deleteCache('book-1');

      expect(tracked.map((entry) => entry.wasCancelled())).toEqual([true, true, true]);
    });
  });

  describe('error handling', () => {
    it('retries the readiness probe after a network failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await expect(session.readaloudAvailable('book-1')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry a catalogue read', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(session.listBooks()).rejects.toMatchObject({ name: 'StorytellerClientError', status: null });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a write', async () => {
      record(tokenResponse(), text('boom', 500));

      await expect(session.process('book-1')).rejects.toMatchObject({ status: 500 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('carries errorClass and durationMs on a rejected request log', async () => {
      record(tokenResponse(), text('boom', 500));

      await expect(session.process('book-1')).rejects.toThrow(StorytellerClientError);

      const failure = logs.find((line) => line.includes('[storyteller.client] [fail]') && line.includes('status=500'));
      expect(failure).toMatch(/durationMs=\d+/);
      expect(failure).toContain('errorClass=HttpError500');
    });

    it('reports a response that is not JSON', async () => {
      record(tokenResponse(), new Response('<html></html>', { status: 200 }));

      await expect(session.getSettings()).rejects.toMatchObject({
        name: 'StorytellerClientError',
        message: 'Storyteller returned a response that is not JSON',
      });
    });
  });
});
