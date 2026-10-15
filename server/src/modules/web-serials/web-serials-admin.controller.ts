import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Optional, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type {
  WebSerialEngineHealth,
  WebSerialLookupHealth,
  WebSerialMangaExtension,
  WebSerialMangaExtensionPage,
  WebSerialMangaSource,
  WebSerialNovelSource,
  WebSerialNovelIndexStatus,
  WebSerialNovelSourceEntry,
  WebSerialSettings,
} from '@bookorbit/types';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import {
  MangaExtensionParamsDto,
  MangaExtensionQueryDto,
  NovelSourceParamsDto,
  NovelSourceQueryDto,
  TestWebSerialEngineDto,
  UpdateWebSerialSettingsDto,
  WebSerialExtensionRepoDto,
} from './dto';
import { WebSerialsLookupService } from './lookup/web-serials-lookup.service';
import { WebSerialsExtensionsService } from './web-serials-extensions.service';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsNovelSourcesService } from './web-serials-novel-sources.service';
import { WebSerialsNovelIndexFillerService } from './web-serials-novel-index-filler.service';

@Controller('web-serials/admin')
export class WebSerialsAdminController {
  constructor(
    private readonly settingsService: WebSerialsSettingsService,
    private readonly lookupService: WebSerialsLookupService,
    private readonly extensionsService: WebSerialsExtensionsService,
    @Optional() private readonly novelSourcesService?: WebSerialsNovelSourcesService,
    @Optional() private readonly novelIndexFiller?: WebSerialsNovelIndexFillerService,
  ) {}

  @Get('settings')
  @RequirePermission(Permission.ManageAppSettings)
  getSettings(): Promise<WebSerialSettings> {
    return this.settingsService.getSettings();
  }

  @Put('settings')
  @RequirePermission(Permission.ManageAppSettings)
  updateSettings(@Body() dto: UpdateWebSerialSettingsDto, @CurrentUser() user: RequestUser): Promise<WebSerialSettings> {
    return this.settingsService.updateSettings(dto, user);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  testConnection(@Body() dto: TestWebSerialEngineDto, @CurrentUser() user: RequestUser): Promise<WebSerialEngineHealth> {
    return this.settingsService.testConnection(user, dto);
  }

  @Post('lookup/test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  testLookup(): Promise<WebSerialLookupHealth> {
    return this.lookupService.test();
  }

  @Get('novel-sources')
  @RequirePermission(Permission.ManageAppSettings)
  listNovelSources(): Promise<WebSerialNovelSource[]> {
    return this.settingsService.listNovelSources();
  }

  @Get('novel-source-catalog')
  @RequirePermission(Permission.ManageAppSettings)
  listAvailableNovelSources(@Query() query: NovelSourceQueryDto): Promise<WebSerialNovelSourceEntry[]> {
    return this.novelSourcesService!.available(query.lang ?? 'English');
  }

  @Get('novel-source-catalog/installed')
  @RequirePermission(Permission.ManageAppSettings)
  listInstalledNovelSources(): Promise<WebSerialNovelSourceEntry[]> {
    return this.novelSourcesService!.installed();
  }

  @Post('novel-source-catalog/:id/install')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageAppSettings)
  installNovelSource(@Param() params: NovelSourceParamsDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.novelSourcesService!.change(params.id, 'install', user);
  }

  @Post('novel-source-catalog/:id/update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageAppSettings)
  updateNovelSource(@Param() params: NovelSourceParamsDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.novelSourcesService!.change(params.id, 'update', user);
  }

  @Delete('novel-source-catalog/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageAppSettings)
  removeNovelSource(@Param() params: NovelSourceParamsDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.novelSourcesService!.change(params.id, 'remove', user);
  }

  @Get('novel-index')
  @RequirePermission(Permission.ManageAppSettings)
  getNovelIndex(): Promise<WebSerialNovelIndexStatus> {
    return this.novelIndexFiller!.status();
  }

  @Post('novel-index/:id/fill')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  fillNovelIndex(@Param() params: NovelSourceParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialNovelIndexStatus> {
    return this.novelIndexFiller!.fillNow(params.id, user);
  }

  @Post('novel-index/:id/rebuild')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  rebuildNovelIndex(@Param() params: NovelSourceParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialNovelIndexStatus> {
    return this.novelIndexFiller!.rebuild(params.id, user);
  }

  @Get('manga-sources')
  @RequirePermission(Permission.ManageAppSettings)
  listMangaSources(): Promise<WebSerialMangaSource[]> {
    return this.settingsService.listMangaSources();
  }

  @Get('manga-extensions')
  @RequirePermission(Permission.ManageAppSettings)
  listMangaExtensions(@Query() query: MangaExtensionQueryDto, @CurrentUser() user: RequestUser): Promise<WebSerialMangaExtensionPage> {
    return this.extensionsService.listExtensions(query, user);
  }

  @Post('manga-extensions/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  refreshMangaExtensions(@CurrentUser() user: RequestUser): Promise<{ total: number }> {
    return this.extensionsService.refreshExtensions(user);
  }

  @Post('manga-extensions/:pkgName/install')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  installMangaExtension(@Param() params: MangaExtensionParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialMangaExtension> {
    return this.extensionsService.updateExtension(params.pkgName, 'install', user);
  }

  @Post('manga-extensions/:pkgName/uninstall')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  uninstallMangaExtension(@Param() params: MangaExtensionParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialMangaExtension> {
    return this.extensionsService.updateExtension(params.pkgName, 'uninstall', user);
  }

  @Post('manga-extensions/:pkgName/update')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageAppSettings)
  updateMangaExtension(@Param() params: MangaExtensionParamsDto, @CurrentUser() user: RequestUser): Promise<WebSerialMangaExtension> {
    return this.extensionsService.updateExtension(params.pkgName, 'update', user);
  }

  @Get('manga-extensions/:pkgName/icon')
  @RequirePermission(Permission.ManageAppSettings)
  async getMangaExtensionIcon(@Param() params: MangaExtensionParamsDto, @CurrentUser() user: RequestUser, @Res() reply: FastifyReply): Promise<void> {
    const icon = await this.extensionsService.getExtensionIcon(params.pkgName, user);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(icon.contentType).send(icon.body);
  }

  @Get('manga-repos')
  @RequirePermission(Permission.ManageAppSettings)
  listMangaRepos(@CurrentUser() user: RequestUser): Promise<string[]> {
    return this.extensionsService.listRepos(user);
  }

  @Post('manga-repos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageAppSettings)
  addMangaRepo(@Body() dto: WebSerialExtensionRepoDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.extensionsService.addRepo(dto.url, user);
  }

  @Delete('manga-repos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageAppSettings)
  removeMangaRepo(@Query() query: WebSerialExtensionRepoDto, @CurrentUser() user: RequestUser): Promise<void> {
    return this.extensionsService.removeRepo(query.url, user);
  }
}
