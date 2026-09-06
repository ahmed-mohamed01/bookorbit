vi.mock('fs', () => ({
  createWriteStream: vi.fn(() => ({ writable: true })),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('stream/promises', () => ({
  pipeline: vi.fn(),
}));

import { mkdir, rename, stat, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Logger } from '@nestjs/common';

import { WhisperModelService } from './whisper-model.service';

const statMock = vi.mocked(stat);
const mkdirMock = vi.mocked(mkdir);
const renameMock = vi.mocked(rename);
const unlinkMock = vi.mocked(unlink);
const pipelineMock = vi.mocked(pipeline);

const TARGET = '/data/models/ggml-base.en.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_BYTES = 148_000_000;

function makeService(model = 'base.en'): WhisperModelService {
  return new WhisperModelService({ whisperModel: model } as never, { appDataPath: '/data' } as never);
}

function fakeResponse(overrides: { ok?: boolean; status?: number; size?: number | null } = {}): Response {
  const { ok = true, status = 200, size = MODEL_BYTES } = overrides;
  return {
    ok,
    status,
    headers: new Headers(size == null ? {} : { 'content-length': String(size) }),
    body: new ReadableStream({ start: (controller) => controller.close() }),
  } as unknown as Response;
}

function statFileFound(): void {
  statMock.mockResolvedValue({ isFile: () => true, size: MODEL_BYTES } as never);
}

function statMissingTargetWithPart(partSize = MODEL_BYTES): void {
  statMock.mockImplementation((path) => {
    if (String(path).endsWith('.part')) {
      return Promise.resolve({ isFile: () => true, size: partSize } as never);
    }
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
}

describe('WhisperModelService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mkdirMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes through an explicit path that exists without downloading, logging readiness', async () => {
    statFileFound();
    await expect(makeService('/mnt/models/custom.bin').ensureModelReady()).resolves.toBe('/mnt/models/custom.bin');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.model_resolve] [end]'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mode=path'));
  });

  it('throws a clear error for an explicit path that does not exist', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(makeService('/mnt/models/missing.bin').ensureModelReady()).rejects.toThrow(/not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a model name that whisper.cpp does not publish', async () => {
    await expect(makeService('mega-v9').ensureModelReady()).rejects.toThrow(/unknown whisper model/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the cached file without downloading when the named model is already on disk', async () => {
    statFileFound();
    await expect(makeService().ensureModelReady()).resolves.toBe(TARGET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a missing named model from the official repo and renames it into place', async () => {
    statMissingTargetWithPart();
    fetchMock.mockResolvedValue(fakeResponse());

    await expect(makeService().ensureModelReady()).resolves.toBe(TARGET);

    expect(fetchMock).toHaveBeenCalledWith(MODEL_URL, expect.objectContaining({ redirect: 'follow' }));
    expect(mkdirMock).toHaveBeenCalledWith('/data/models', { recursive: true });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith(`${TARGET}.part`, TARGET);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.model_download] [end]'));
  });

  it('fails and removes the partial file when the download returns an HTTP error', async () => {
    statMissingTargetWithPart();
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 404 }));

    await expect(makeService().ensureModelReady()).rejects.toThrow(/HTTP 404/);
    expect(unlinkMock).toHaveBeenCalledWith(`${TARGET}.part`);
    expect(renameMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.model_download] [fail]'));
  });

  it('fails when fewer bytes land on disk than the server announced', async () => {
    statMissingTargetWithPart(1000);
    fetchMock.mockResolvedValue(fakeResponse());

    await expect(makeService().ensureModelReady()).rejects.toThrow(/incomplete/i);
    expect(unlinkMock).toHaveBeenCalledWith(`${TARGET}.part`);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects a download response that declares no content-length', async () => {
    statMissingTargetWithPart();
    fetchMock.mockResolvedValue(fakeResponse({ size: null }));

    await expect(makeService().ensureModelReady()).rejects.toThrow(/content-length/i);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit path pointing at a file too small to be a model', async () => {
    statMock.mockResolvedValue({ isFile: () => true, size: 1000 } as never);
    await expect(makeService('/mnt/models/tiny-junk.bin').ensureModelReady()).rejects.toThrow(/too small/i);
  });

  it('redownloads over a cached file smaller than the floor instead of serving it', async () => {
    statMock.mockImplementation((path) => {
      if (String(path).endsWith('.part')) return Promise.resolve({ isFile: () => true, size: MODEL_BYTES } as never);
      return Promise.resolve({ isFile: () => true, size: 1000 } as never);
    });
    fetchMock.mockResolvedValue(fakeResponse());

    await expect(makeService().ensureModelReady()).resolves.toBe(TARGET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith(`${TARGET}.part`, TARGET);
  });

  it('holds a failed resolution in cooldown instead of re-downloading per caller', async () => {
    statMissingTargetWithPart();
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500 }));

    const service = makeService();
    await expect(service.ensureModelReady()).rejects.toThrow(/HTTP 500/);
    await expect(service.ensureModelReady()).rejects.toThrow(/HTTP 500/);
    await expect(service.ensureModelReady()).rejects.toThrow(/HTTP 500/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not hold cheap stat failures in the download cooldown', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const service = makeService('/missing/model.bin');
    await expect(service.ensureModelReady()).rejects.toThrow(/not found/i);
    await expect(service.ensureModelReady()).rejects.toThrow(/not found/i);

    expect(statMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one download between concurrent callers', async () => {
    statMissingTargetWithPart();
    fetchMock.mockResolvedValue(fakeResponse());

    const service = makeService();
    const [first, second] = await Promise.all([service.ensureModelReady(), service.ensureModelReady()]);

    expect(first).toBe(TARGET);
    expect(second).toBe(TARGET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remembers a resolved model and skips all disk checks afterwards', async () => {
    statFileFound();
    const service = makeService();
    await service.ensureModelReady();

    statMock.mockClear();
    fetchMock.mockClear();

    await expect(service.ensureModelReady()).resolves.toBe(TARGET);
    expect(statMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WhisperModelService boot probe', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeBootService(model: string, enabled: boolean): WhisperModelService {
    return new WhisperModelService({ whisperModel: model, readingAlignmentEnabled: enabled } as never, { appDataPath: '/data' } as never);
  }

  it('reports a cached named model ready at boot without downloading', async () => {
    statMock.mockResolvedValue({ isFile: () => true, size: MODEL_BYTES } as never);
    makeBootService('base.en', true).onApplicationBootstrap();
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.model_probe] [end]')));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('outcome=ready'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports pending_download for an uncached named model and does NOT download at boot', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    makeBootService('base.en', true).onApplicationBootstrap();
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('outcome=pending_download')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports pending_download for a truncated cached model instead of downloading at boot', async () => {
    statMock.mockResolvedValue({ isFile: () => true, size: 1000 } as never);
    makeBootService('base.en', true).onApplicationBootstrap();
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('outcome=pending_download')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays inert at boot when the feature is disabled', () => {
    makeBootService('base.en', false).onApplicationBootstrap();
    expect(statMock).not.toHaveBeenCalled();
  });

  it('logs the resolution failure and a not_ready probe outcome for a missing explicit path', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    makeBootService('/missing/model.bin', true).onApplicationBootstrap();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('outcome=not_ready')));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[reading_alignment.model_resolve] [fail]'));
  });
});
