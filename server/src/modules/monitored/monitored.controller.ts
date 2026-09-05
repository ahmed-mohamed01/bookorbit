import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, UseFilters } from '@nestjs/common';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { FastifyReply } from 'fastify';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { imageContentTypeFromPath } from '../../common/image-content-type';
import type { RequestUser } from '../../common/types/request-user';
import {
  CreateMonitoredBookDto,
  ListMonitoredAuthorsDto,
  ListMonitoredBooksDto,
  ListMonitoredReleasesDto,
  ListOwnedMonitoredAuthorIdsDto,
  MonitorAuthorDto,
  MonitoredAuthorDetailQueryDto,
  MonitoredCoverQueryDto,
  GrabWorkReleaseDto,
  MonitoredSearchQueryDto,
  RequestFromWorkDto,
  SearchWorkReleasesDto,
  UpdateMonitoredWorkDto,
  UpdateMonitoredAuthorDto,
  UpdateMonitoredBookDto,
} from './dto/monitored.dto';
import { MonitoredCoverService } from './monitored-cover.service';
import { MonitoredExceptionFilter } from './monitored-exception.filter';
import { MonitoredService } from './monitored.service';

@Controller('monitored')
@UseFilters(MonitoredExceptionFilter)
export class MonitoredController {
  constructor(
    private readonly service: MonitoredService,
    private readonly monitoredCoverService: MonitoredCoverService,
  ) {}

  @Get()
  getSummary(@CurrentUser() user: RequestUser) {
    return this.service.getSummary(user);
  }

  @Get('cover')
  async getCover(@Query() query: MonitoredCoverQueryDto, @CurrentUser() user: RequestUser, @Res() res: FastifyReply) {
    const { buffer, contentType } = await this.monitoredCoverService.getCover(query.url, user.id);
    // Provider cover URLs are content-addressed, so the response is immutable.
    res.header('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(contentType).send(buffer);
  }

  @Get('authors')
  listAuthors(@CurrentUser() user: RequestUser, @Query() query: ListMonitoredAuthorsDto) {
    return this.service.listAuthors(user, query);
  }

  @Post('authors')
  @RequirePermission(Permission.BookRequestAccess)
  createAuthor(@Body() dto: MonitorAuthorDto, @CurrentUser() user: RequestUser) {
    return this.service.createAuthor(dto, user);
  }

  @Get('authors/ids')
  listOwnedAuthorIds(@CurrentUser() user: RequestUser, @Query() query: ListOwnedMonitoredAuthorIdsDto) {
    return this.service.listOwnedAuthorIds(user, query);
  }

  @Get('authors/:id/portrait')
  async getAuthorPortrait(@Param('id') id: string, @CurrentUser() user: RequestUser, @Res() reply: FastifyReply) {
    const portraitPath = await this.service.getAuthorPortraitPath(id, user);
    if (!portraitPath) {
      reply.status(404).send({ message: `No portrait for monitored author ${id}` });
      return;
    }

    let mtimeMs: number;
    try {
      ({ mtimeMs } = await stat(portraitPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404).send({ message: `No portrait for monitored author ${id}` });
        return;
      }
      throw error;
    }
    reply.header('Cache-Control', 'no-cache');
    reply.header('ETag', `"${Math.floor(mtimeMs)}"`);
    reply.type(imageContentTypeFromPath(portraitPath));
    reply.send(createReadStream(portraitPath));
  }

  @Get('authors/:id')
  getAuthor(@Param('id') id: string, @Query() query: MonitoredAuthorDetailQueryDto, @CurrentUser() user: RequestUser) {
    return this.service.getAuthor(id, user, query);
  }

  @Patch('authors/:id')
  @RequirePermission(Permission.BookRequestAccess)
  updateAuthor(@Param('id') id: string, @Body() dto: UpdateMonitoredAuthorDto, @CurrentUser() user: RequestUser) {
    return this.service.updateAuthor(id, dto, user);
  }

  @Delete('authors/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.BookRequestAccess)
  deleteAuthor(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.deleteAuthor(id, user);
  }

  @Post('authors/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.BookRequestAccess)
  refreshAuthor(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.refreshAuthor(id, user);
  }

  @Get('books')
  listBooks(@CurrentUser() user: RequestUser, @Query() query: ListMonitoredBooksDto) {
    return this.service.listBooks(user, query);
  }

  @Post('books')
  @RequirePermission(Permission.BookRequestAccess)
  createBook(@Body() dto: CreateMonitoredBookDto, @CurrentUser() user: RequestUser) {
    return this.service.createBook(dto, user);
  }

  @Patch('books/:id')
  @RequirePermission(Permission.BookRequestAccess)
  updateBook(@Param('id') id: string, @Body() dto: UpdateMonitoredBookDto, @CurrentUser() user: RequestUser) {
    return this.service.updateBook(id, dto, user);
  }

  @Delete('books/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.BookRequestAccess)
  deleteBook(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.deleteBook(id, user);
  }

  @Get('releases')
  listReleases(@CurrentUser() user: RequestUser, @Query() query: ListMonitoredReleasesDto) {
    return this.service.listReleases(user, query);
  }

  @Get('search')
  searchAuthors(@Query() query: MonitoredSearchQueryDto, @CurrentUser() user: RequestUser) {
    return this.service.searchAuthors(query.q, user);
  }

  @Post('works/:workId/request')
  @RequirePermission(Permission.BookRequestAccess)
  requestFromWork(@Param('workId') workId: string, @Body() dto: RequestFromWorkDto, @CurrentUser() user: RequestUser) {
    return this.service.requestFromWork(user, workId, dto);
  }

  @Patch('works/:workId')
  @RequirePermission(Permission.BookRequestAccess)
  updateWork(@Param('workId') workId: string, @Body() dto: UpdateMonitoredWorkDto, @CurrentUser() user: RequestUser) {
    return this.service.updateWork(user, workId, dto);
  }

  @Post('works/:workId/releases/search')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.BookRequestAccess)
  searchWorkReleases(@Param('workId') workId: string, @Body() dto: SearchWorkReleasesDto, @CurrentUser() user: RequestUser) {
    return this.service.searchWorkReleases(user, workId, dto.format);
  }

  @Post('works/:workId/releases/grab')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.BookRequestAccess)
  grabWorkRelease(@Param('workId') workId: string, @Body() dto: GrabWorkReleaseDto, @CurrentUser() user: RequestUser) {
    return this.service.grabWorkRelease(user, workId, dto);
  }
}
