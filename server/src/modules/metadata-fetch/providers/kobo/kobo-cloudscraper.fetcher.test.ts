import { execFile } from 'child_process';
import { existsSync } from 'fs';

import { fetchKoboHtmlWithCloudscraper, KoboCloudscraperUnavailableError, KoboCloudscraperFetchResult } from './kobo-cloudscraper.fetcher';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(existsSync);

describe('fetchKoboHtmlWithCloudscraper', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it('runs the configured Python executable and parses cloudscraper output', async () => {
    const output: KoboCloudscraperFetchResult = {
      status: 200,
      url: 'https://www.kobo.com/us/en/ebook/fourth-wing-1',
      headers: { Server: 'cloudflare' },
      html: '<h1>Fourth Wing</h1>',
      attempts: 3,
      challenge: false,
    };
    mockExecFileSuccess(output);

    await expect(
      fetchKoboHtmlWithCloudscraper('https://www.kobo.com/us/en/search?query=Fourth+Wing', {
        maxAttempts: 15,
        pythonPath: '/tmp/python',
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({
      ...output,
      headers: { server: 'cloudflare' },
    });

    expect(execFileMock).toHaveBeenCalledWith(
      '/tmp/python',
      ['-c', expect.any(String), expect.stringContaining('"maxAttempts":15')],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );

    const payload = getCloudscraperPayload(0);
    expect(payload).toEqual(
      expect.objectContaining({
        maxAttempts: 15,
        requestTimeoutSec: 10,
        deadlineSec: 29,
      }),
    );
  });

  it('falls back to the next Python candidate when the first is unavailable', async () => {
    mockExecFileError(makeExecError('spawn python3 ENOENT', { code: 'ENOENT' }));
    mockExecFileSuccess({
      status: 200,
      url: 'https://www.kobo.com/us/en/ebook/dune',
      headers: {},
      html: '<h1>Dune</h1>',
      attempts: 1,
      challenge: false,
    });

    const result = await fetchKoboHtmlWithCloudscraper('https://www.kobo.com/us/en/search?query=Dune', {
      timeoutMs: 30_000,
    });

    expect(result.url).toBe('https://www.kobo.com/us/en/ebook/dune');
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'python3', expect.any(Array), expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(2, 'python', expect.any(Array), expect.any(Object), expect.any(Function));
  });

  it('reports cloudscraper as unavailable when every Python candidate is missing the module', async () => {
    const stderr = JSON.stringify({ errorClass: 'ModuleNotFoundError', error: "No module named 'cloudscraper'", unavailable: true });
    mockExecFileError(makeExecError('module missing', { stderr }));
    mockExecFileError(makeExecError('module missing', { stderr }));

    await expect(fetchKoboHtmlWithCloudscraper('https://www.kobo.com/us/en/search?query=Dune', { timeoutMs: 30_000 })).rejects.toBeInstanceOf(
      KoboCloudscraperUnavailableError,
    );
  });
});

function getCloudscraperPayload(callIndex: number): Record<string, unknown> {
  const args = execFileMock.mock.calls[callIndex]?.[1];
  if (!Array.isArray(args) || typeof args[2] !== 'string') {
    throw new Error('missing cloudscraper payload');
  }
  return JSON.parse(args[2]) as Record<string, unknown>;
}

function mockExecFileSuccess(result: KoboCloudscraperFetchResult): void {
  execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
    callback?.(null, JSON.stringify(result), '');
    return undefined as never;
  });
}

function mockExecFileError(error: Error): void {
  execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
    callback?.(error, '', (error as { stderr?: string }).stderr ?? '');
    return undefined as never;
  });
}

function makeExecError(message: string, fields: Partial<Error & { code: string; stderr: string }>): Error {
  return Object.assign(new Error(message), fields);
}
