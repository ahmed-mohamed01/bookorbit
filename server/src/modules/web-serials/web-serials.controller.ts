import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type {
  MoveWebSerialJobResult,
  WebSerialCapabilities,
  WebSerialCatalogEntry,
  WebSerialClearFinishedResult,
  WebSerialDiscoverResult,
  WebSerialJob,
  WebSerialJobDetail,
  WebSerialJobList,
  WebSerialMoveCandidates,
  WebSerialNovelProviders,
  WebSerialPublishedRequest,
  WebSerialSearchResult,
  WebSerialSeriesDetail,
  WebSerialSeriesLookup,
  WebSerialSourceOptions,
  WebSerialSuggestResult,
} from '@bookorbit/types';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import {
  CreateWebSerialJobDto,
  ListWebSerialJobsDto,
  ListWebSerialPublishedRequestsDto,
  MoveWebSerialJobDto,
  RecordWebSerialPublishedRequestDto,
  RefreshWebSerialsDto,
  ResolveWebSerialUrlDto,
  SearchWebSerialsDto,
  SeriesMatchDto,
  SuggestWebSerialsDto,
  UpdateWebSerialNovelProvidersDto,
  WebSerialDiscoverParamsDto,
  WebSerialJobScopeDto,
  WebSerialSeriesKeyParamsDto,
} from './dto';
import { WebSerialsCatalogService } from './web-serials-catalog.service';
import { WebSerialsDiscoverService } from './web-serials-discover.service';
import { WebSerialsCoverService } from './web-serials-cover.service';
import { WebSerialJobsService } from './web-serials-jobs.service';
import { WebSerialsNovelProvidersService } from './web-serials-novel-providers.service';
import { WebSerialJobMoveService } from './web-serials-job-move.service';
import { WebSerialsPublishedRequestsService } from './web-serials-published-requests.service';
import { WebSerialsNovelIndexService } from './web-serials-novel-index.service';

@Controller('web-serials')
export class WebSerialsController {
  constructor(
    private readonly catalog: WebSerialsCatalogService,
    private readonly jobs: WebSerialJobsService,
    private readonly moves: WebSerialJobMoveService,
    private readonly coverService: WebSerialsCoverService,
    private readonly novelProviders: WebSerialsNovelProvidersService,
    private readonly discoverService: WebSerialsDiscoverService,
    private readonly novelIndex: WebSerialsNovelIndexService,
    private readonly publishedRequests: WebSerialsPublishedRequestsService,
  ) {}

  @Get('capabilities')
  @RequirePermission(Permission.WebSerialAccess)
  getCapabilities(@CurrentUser() user: RequestUser): Promise<WebSerialCapabilities> {
    return this.catalog.getCapabilities(user);
  }

  @Get('search')
  @RequirePermission(Permission.WebSerialAccess)
  search(@Query() query: SearchWebSerialsDto, @CurrentUser() user: RequestUser): Promise<WebSerialSearchResult> {
    return this.catalog.search(query.q, query.kind ?? 'all', user, query.refresh === true, query.phase ?? 'full');
  }

  @Get('suggest')
  @RequirePermission(Permission.WebSerialAccess)
  suggest(@Query() query: SuggestWebSerialsDto, @CurrentUser() user: RequestUser): Promise<WebSerialSuggestResult> {
    return this.novelIndex.suggest(query.q, user);
  }

  @Get('discover')
  @RequirePermission(Permission.WebSerialAccess)
  discover(@Query() query: SearchWebSerialsDto, @CurrentUser() user: RequestUser): Promise<WebSerialDiscoverResult> {
    return this.discoverService.discover(query.q, query.kind ?? 'all', user, query.refresh === true);
  }

  @Get('discover/:kind/:matchId')
  @RequirePermission(Permission.WebSerialAccess)
  getDiscoverEntry(@Param() params: WebSerialDiscoverParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialCatalogEntry> {
    return this.discoverService.getEntry(params.kind, params.matchId, user);
  }

  @Get('discover/:kind/:matchId/sources')
  @RequirePermission(Permission.WebSerialAccess)
  getDiscoverSources(
    @Param() params: WebSerialDiscoverParamsDto,
    @Query() query: RefreshWebSerialsDto,
    @CurrentUser() user: RequestUser,
  ): Promise<WebSerialSourceOptions> {
    return this.discoverService.getSources(params.kind, params.matchId, user, query.refresh === true);
  }

  @Get('discover/:kind/:matchId/cover')
  @RequirePermission(Permission.WebSerialAccess)
  async getDiscoverCover(@Param() params: WebSerialDiscoverParamsDto, @Res() reply: FastifyReply): Promise<void> {
    const { body, contentType } = await this.discoverService.getCover(params.kind, params.matchId);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(contentType).send(body);
  }

  @Get('novel-providers')
  @RequirePermission(Permission.WebSerialAccess)
  getNovelProviders(@CurrentUser() user: RequestUser): Promise<WebSerialNovelProviders> {
    return this.novelProviders.getProviders(user);
  }

  @Put('novel-providers')
  @RequirePermission(Permission.WebSerialAccess)
  updateNovelProviders(@Body() dto: UpdateWebSerialNovelProvidersDto, @CurrentUser() user: RequestUser): Promise<WebSerialNovelProviders> {
    return this.novelProviders.updateProviders(user, dto);
  }

  @Post('published-requests')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.WebSerialAccess)
  recordPublishedRequest(@Body() dto: RecordWebSerialPublishedRequestDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.publishedRequests.record(user, dto);
  }

  @Get('published-requests')
  @RequirePermission(Permission.WebSerialAccess)
  listPublishedRequests(@Query() query: ListWebSerialPublishedRequestsDto, @CurrentUser() user: RequestUser): Promise<WebSerialPublishedRequest[]> {
    return this.publishedRequests.list(user, query.kind, query.matchId);
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  resolve(@Body() dto: ResolveWebSerialUrlDto, @CurrentUser() user: RequestUser): Promise<WebSerialSeriesDetail> {
    return this.catalog.resolve(dto.url, user);
  }

  @Get('series/:seriesKey')
  @RequirePermission(Permission.WebSerialAccess)
  getSeries(
    @Param() params: WebSerialSeriesKeyParamsDto,
    @Query() query: SeriesMatchDto,
    @CurrentUser() user: RequestUser,
  ): Promise<WebSerialSeriesDetail> {
    return this.catalog.getSeriesDetail(params.seriesKey, user, query.matchId);
  }

  @Get('series/:seriesKey/lookup')
  @RequirePermission(Permission.WebSerialAccess)
  getSeriesLookup(@Param() params: WebSerialSeriesKeyParamsDto, @Query() query: SeriesMatchDto): Promise<WebSerialSeriesLookup> {
    return this.catalog.getSeriesLookup(params.seriesKey, query.matchId);
  }

  @Get('series/:seriesKey/sources')
  @RequirePermission(Permission.WebSerialAccess)
  getSeriesSources(@Param() params: WebSerialSeriesKeyParamsDto, @Query() query: RefreshWebSerialsDto): Promise<WebSerialSourceOptions> {
    return this.catalog.getSeriesSources(params.seriesKey, query.refresh === true);
  }

  @Get('series/:seriesKey/cover')
  @RequirePermission(Permission.WebSerialAccess)
  async getCover(@Param() params: WebSerialSeriesKeyParamsDto, @Res() reply: FastifyReply): Promise<void> {
    const { body, contentType } = await this.coverService.getCover(params.seriesKey);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(contentType).send(body);
  }

  @Post('jobs')
  @RequirePermission(Permission.WebSerialAccess)
  createJob(@Body() dto: CreateWebSerialJobDto, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.createJob(dto, user);
  }

  @Get('jobs')
  @RequirePermission(Permission.WebSerialAccess)
  listJobs(@Query() query: ListWebSerialJobsDto, @CurrentUser() user: RequestUser): Promise<WebSerialJobList> {
    return this.jobs.listJobs(user, query.scope, query.limit, query.offset);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  cancelJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.cancelJob(id, user);
  }

  @Post('jobs/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  retryJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.retryJob(id, user);
  }

  @Get('jobs/:id/move-candidates')
  @RequirePermission(Permission.WebSerialAccess)
  getMoveCandidates(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialMoveCandidates> {
    return this.moves.getMoveCandidates(id, user);
  }

  @Post('jobs/:id/move')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  moveJob(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoveWebSerialJobDto,
    @CurrentUser() user: RequestUser,
  ): Promise<MoveWebSerialJobResult> {
    return this.moves.moveJob(id, dto, user);
  }

  @Post('jobs/clear-finished')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  clearFinished(@Query() query: WebSerialJobScopeDto, @CurrentUser() user: RequestUser): Promise<WebSerialClearFinishedResult> {
    return this.jobs.clearFinished(user, query.scope);
  }

  @Get('jobs/:id')
  @RequirePermission(Permission.WebSerialAccess)
  getJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJobDetail> {
    return this.jobs.getJobDetail(id, user);
  }

  @Post('jobs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  pauseJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.pauseJob(id, user);
  }

  @Post('jobs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  resumeJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.resumeJob(id, user);
  }

  @Post('jobs/:id/move-to-top')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  moveJobToTop(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<WebSerialJob> {
    return this.jobs.moveJobToTop(id, user);
  }

  @Delete('jobs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.WebSerialAccess)
  removeJob(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<void> {
    return this.jobs.removeJob(id, user);
  }

  @Post('jobs/:id/items/:itemId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess)
  retryItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<WebSerialJobDetail> {
    return this.jobs.retryItem(id, itemId, user);
  }

  @Post('queue/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess, Permission.ManageAppSettings)
  pauseQueue(@CurrentUser() user: RequestUser): Promise<{ queuePaused: boolean }> {
    return this.jobs.pauseQueue(user);
  }

  @Post('queue/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WebSerialAccess, Permission.ManageAppSettings)
  resumeQueue(@CurrentUser() user: RequestUser): Promise<{ queuePaused: boolean }> {
    return this.jobs.resumeQueue(user);
  }
}
