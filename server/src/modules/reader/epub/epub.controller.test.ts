import { BadRequestException } from '@nestjs/common';
import { PassThrough, Readable } from 'stream';

import { EpubController } from './epub.controller';

describe('EpubController', () => {
  const epubService = {
    getBookInfo: vi.fn(),
    getMediaOverlayPlaylist: vi.fn(),
    streamMediaOverlayFile: vi.fn(),
    streamFile: vi.fn(),
  };

  const controller = new EpubController(epubService as any);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes undefined fileId when query is absent', async () => {
    const user = { id: 5, isSuperuser: false, permissions: [] } as any;
    epubService.getBookInfo.mockResolvedValue({ title: 'ok' });

    await controller.getBookInfo(11, undefined, user);

    expect(epubService.getBookInfo).toHaveBeenCalledWith(11, undefined, user);
  });

  it('parses numeric fileId query values', async () => {
    const user = { id: 5, isSuperuser: false, permissions: [] } as any;
    epubService.getBookInfo.mockResolvedValue({ title: 'ok' });

    await controller.getBookInfo(11, ' 12 ', user);

    expect(epubService.getBookInfo).toHaveBeenCalledWith(11, 12, user);
  });

  it.each(['abc', '12abc', '-1', '0'])('rejects invalid fileId query: %s', (fileId) => {
    expect(() => controller.getBookInfo(11, fileId, { id: 5, isSuperuser: false, permissions: [] } as any)).toThrow(
      new BadRequestException('Invalid fileId'),
    );
  });

  function fileResult(overrides: Record<string, unknown> = {}) {
    const stream = new PassThrough();
    return {
      stream,
      result: {
        openBody: vi.fn(() => stream),
        contentType: 'application/xhtml+xml',
        size: 321,
        status: 200,
        contentRange: null,
        etag: null,
        acceptsRanges: false,
        ...overrides,
      },
    };
  }

  const makeReply = () => ({ code: vi.fn(), header: vi.fn(), send: vi.fn() });
  const user = { id: 1, isSuperuser: false, permissions: [] } as any;

  it('decodes wildcard file path, sets headers, and streams payload', async () => {
    const reply = makeReply();
    const { stream, result } = fileResult();
    epubService.streamFile.mockResolvedValue(result);

    await controller.getFile(9, 'OPS/text/Chapter%201.xhtml', '13', user, { method: 'GET', headers: {} } as any, reply as any);

    expect(epubService.streamFile).toHaveBeenCalledWith(
      9,
      'OPS/text/Chapter 1.xhtml',
      13,
      { range: undefined, ifRange: undefined, ifNoneMatch: undefined },
      user,
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/xhtml+xml');
    expect(reply.header).toHaveBeenCalledWith('Content-Length', 321);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    expect(reply.header).not.toHaveBeenCalledWith('Accept-Ranges', expect.anything());
    expect(reply.header).not.toHaveBeenCalledWith('Content-Range', expect.anything());
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('forwards range conditions and answers with partial content', async () => {
    const reply = makeReply();
    const { result } = fileResult({
      contentType: 'video/mp4',
      size: 100,
      status: 206,
      contentRange: 'bytes 0-99/5000',
      etag: '"v1"',
      acceptsRanges: true,
    });
    epubService.streamFile.mockResolvedValue(result);
    const headers = { range: 'bytes=0-99', 'if-range': '"v1"', 'if-none-match': '"v0"' };

    await controller.getFile(9, 'OEBPS/Audio/00001.mp4', '13', user, { method: 'GET', headers } as any, reply as any);

    expect(epubService.streamFile).toHaveBeenCalledWith(
      9,
      'OEBPS/Audio/00001.mp4',
      13,
      { range: 'bytes=0-99', ifRange: '"v1"', ifNoneMatch: '"v0"' },
      user,
    );
    expect(reply.code).toHaveBeenCalledWith(206);
    expect(reply.header).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
    expect(reply.header).toHaveBeenCalledWith('Content-Range', 'bytes 0-99/5000');
    expect(reply.header).toHaveBeenCalledWith('Content-Length', 100);
    expect(reply.header).toHaveBeenCalledWith('ETag', '"v1"');
  });

  it('answers a HEAD request without opening the body', async () => {
    const reply = makeReply();
    const { result } = fileResult({ acceptsRanges: true });
    epubService.streamFile.mockResolvedValue(result);

    await controller.getFile(9, 'OEBPS/Audio/00001.mp4', '13', user, { method: 'HEAD', headers: {} } as any, reply as any);

    expect(reply.header).toHaveBeenCalledWith('Content-Length', 321);
    expect(result.openBody).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith(expect.any(Readable));
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const reply = makeReply();
    const { result } = fileResult({ status: 304, size: 0, etag: '"v1"', acceptsRanges: true });
    epubService.streamFile.mockResolvedValue(result);

    await controller.getFile(9, 'OEBPS/Audio/00001.mp4', '13', user, { method: 'GET', headers: { 'if-none-match': '"v1"' } } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(304);
    expect(reply.header).toHaveBeenCalledWith('ETag', '"v1"');
    expect(reply.header).not.toHaveBeenCalledWith('Content-Length', expect.anything());
    expect(result.openBody).not.toHaveBeenCalled();
  });

  it('delegates media-overlay playlist requests', async () => {
    const user = { id: 5, isSuperuser: false, permissions: [] } as any;
    epubService.getMediaOverlayPlaylist.mockResolvedValue({ items: [] });

    await controller.getMediaOverlay(11, '12', user);

    expect(epubService.getMediaOverlayPlaylist).toHaveBeenCalledWith(11, 12, user);
  });

  it('sets range headers for media-overlay audio files', async () => {
    const user = { id: 1, isSuperuser: false, permissions: [] } as any;
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn(),
      send: vi.fn(),
    };
    epubService.streamMediaOverlayFile.mockResolvedValue({
      data: Buffer.from('2345'),
      contentType: 'audio/mpeg',
      size: 10,
      status: 206,
      contentRange: 'bytes 2-5/10',
    });

    await controller.getMediaOverlayFile(9, 'OPS/audio/ch1.mp3', '13', user, { headers: { range: 'bytes=2-5' } } as any, reply as any);

    expect(epubService.streamMediaOverlayFile).toHaveBeenCalledWith(9, 'OPS/audio/ch1.mp3', 13, 'bytes=2-5', user);
    expect(reply.code).toHaveBeenCalledWith(206);
    expect(reply.header).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
    expect(reply.header).toHaveBeenCalledWith('Content-Range', 'bytes 2-5/10');
    expect(reply.send).toHaveBeenCalledWith(Buffer.from('2345'));
  });

  it('does not set content-length when size is zero', async () => {
    const reply = makeReply();
    const { result } = fileResult({ contentType: 'application/xml', size: 0 });
    epubService.streamFile.mockResolvedValue(result);

    await controller.getFile(9, 'META-INF/container.xml', undefined, user, { method: 'GET', headers: {} } as any, reply as any);

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/xml');
    expect(reply.header).not.toHaveBeenCalledWith('Content-Length', expect.anything());
  });

  it('rejects malformed encoded file paths', async () => {
    await expect(
      controller.getFile(9, 'OPS/text/%E0%A4%A', undefined, { id: 1, isSuperuser: false, permissions: [] } as any, { headers: {} } as any, {} as any),
    ).rejects.toThrow(new BadRequestException('Invalid file path'));
  });
});
