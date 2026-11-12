import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AudioConvertService } from './audio-convert.service';
import { AudioConvertEncoderDto, AudioConvertPreviewQueryDto, AudioConvertRunDto, UpdateAudioConvertSettingsDto } from './dto/audio-convert.dto';

@Controller('audio-convert')
export class AudioConvertController {
  constructor(private readonly service: AudioConvertService) {}

  /** Any signed-in user: the client hides the tool and the book button when it is off. */
  @Get('enabled')
  enabled() {
    return this.service.enabled();
  }

  @Get('settings')
  @RequirePermission(Permission.ManageAppSettings)
  getSettings() {
    return this.service.getSettings();
  }

  @Patch('settings')
  @RequirePermission(Permission.ManageAppSettings)
  updateSettings(@Body() dto: UpdateAudioConvertSettingsDto, @CurrentUser() user: RequestUser) {
    return this.service.updateSettings(dto, user);
  }

  @Get('libraries/:libraryId/preview')
  @RequirePermission(Permission.ManageLibraries)
  @RequireLibraryAccess('editor')
  preview(@Param('libraryId', ParseIntPipe) libraryId: number, @Query() query: AudioConvertPreviewQueryDto, @CurrentUser() user: RequestUser) {
    return this.service.preview(libraryId, query, user);
  }

  @Post('libraries/:libraryId/run')
  @RequirePermission(Permission.ManageLibraries)
  @RequireLibraryAccess('editor')
  @HttpCode(HttpStatus.OK)
  run(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: AudioConvertRunDto, @CurrentUser() user: RequestUser) {
    return this.service.run(libraryId, dto, user);
  }

  @Get('libraries/:libraryId/status')
  @RequirePermission(Permission.ManageLibraries)
  @RequireLibraryAccess('editor')
  status(@Param('libraryId', ParseIntPipe) libraryId: number) {
    return this.service.status(libraryId);
  }

  @Post('libraries/:libraryId/stop')
  @RequirePermission(Permission.ManageLibraries)
  @RequireLibraryAccess('editor')
  @HttpCode(HttpStatus.OK)
  stop(@Param('libraryId', ParseIntPipe) libraryId: number) {
    return this.service.stop(libraryId);
  }

  @Get('books/:bookId/convert')
  @RequirePermission(Permission.ManageLibraries)
  plan(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.plan(bookId, user);
  }

  @Post('books/:bookId/convert')
  @RequirePermission(Permission.ManageLibraries)
  @HttpCode(HttpStatus.OK)
  convertBook(@Param('bookId', ParseIntPipe) bookId: number, @Body() dto: AudioConvertEncoderDto, @CurrentUser() user: RequestUser) {
    return this.service.convertBook(bookId, dto, user);
  }

  @Post('books/:bookId/convert/stop')
  @RequirePermission(Permission.ManageLibraries)
  @HttpCode(HttpStatus.OK)
  stopBook(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.stopBook(bookId, user);
  }

  @Post('jobs/:jobId/skip')
  @RequirePermission(Permission.ManageLibraries)
  @HttpCode(HttpStatus.OK)
  skip(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: RequestUser) {
    return this.service.skip(jobId, user);
  }

  @Post('jobs/:jobId/convert-now')
  @RequirePermission(Permission.ManageLibraries)
  @HttpCode(HttpStatus.OK)
  convertNow(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: RequestUser) {
    return this.service.convertNow(jobId, user);
  }
}
