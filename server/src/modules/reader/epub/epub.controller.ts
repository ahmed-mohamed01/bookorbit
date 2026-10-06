import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { EpubService } from './epub.service';

@Controller('epub')
export class EpubController {
  constructor(private readonly epubService: EpubService) {}

  @Get(':bookId/info')
  getBookInfo(@Param('bookId', ParseIntPipe) bookId: number, @Query('fileId') fileId: string | undefined, @CurrentUser() user: RequestUser) {
    return this.epubService.getBookInfo(bookId, this.parseFileId(fileId), user);
  }

  @Get(':bookId/media-overlay')
  getMediaOverlay(@Param('bookId', ParseIntPipe) bookId: number, @Query('fileId') fileId: string | undefined, @CurrentUser() user: RequestUser) {
    return this.epubService.getMediaOverlayPlaylist(bookId, this.parseFileId(fileId), user);
  }

  @Get(':bookId/media-overlay/file/*')
  async getMediaOverlayFile(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('*') encodedPath: string,
    @Query('fileId') fileId: string | undefined,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const filePath = this.decodePathParam(encodedPath);
    const { data, contentType, size, status, contentRange } = await this.epubService.streamMediaOverlayFile(
      bookId,
      filePath,
      this.parseFileId(fileId),
      this.header(request, 'range'),
      user,
    );

    this.setRangeHeaders(reply, status, contentType, contentRange, true);
    reply.header('Content-Length', data.length);
    if (!contentRange && size > 0) reply.header('X-Content-Length-Full', size);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.send(data);
  }

  @Get(':bookId/file/*')
  async getFile(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('*') encodedPath: string,
    @Query('fileId') fileId: string | undefined,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const filePath = this.decodePathParam(encodedPath);
    const file = await this.epubService.streamFile(
      bookId,
      filePath,
      this.parseFileId(fileId),
      {
        range: this.header(request, 'range'),
        ifRange: this.header(request, 'if-range'),
        ifNoneMatch: this.header(request, 'if-none-match'),
      },
      user,
    );

    this.setRangeHeaders(reply, file.status, file.contentType, file.contentRange, file.acceptsRanges);
    if (file.etag) reply.header('ETag', file.etag);
    // The book is only readable after an access check, so shared caches must not keep it.
    reply.header('Cache-Control', 'private, max-age=3600');
    if (file.status === 304) return reply.send();
    if (file.size > 0) reply.header('Content-Length', file.size);
    // Fastify answers HEAD through this route: an empty stream keeps the Content-Length above,
    // where no body would reset it to 0 and the real body would be read in full and dropped.
    reply.send(request.method === 'HEAD' ? Readable.from([]) : file.openBody());
  }

  private header(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  }

  private setRangeHeaders(reply: FastifyReply, status: number, contentType: string, contentRange: string | null, acceptsRanges: boolean) {
    reply.code(status);
    reply.header('Content-Type', contentType);
    if (acceptsRanges) reply.header('Accept-Ranges', 'bytes');
    if (contentRange) reply.header('Content-Range', contentRange);
  }

  private parseFileId(fileId: string | undefined): number | undefined {
    if (fileId === undefined) return undefined;
    const value = fileId.trim();
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('Invalid fileId');
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('Invalid fileId');
    }
    return parsed;
  }

  private decodePathParam(encodedPath: string): string {
    try {
      return encodedPath
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
    } catch {
      throw new BadRequestException('Invalid file path');
    }
  }
}
