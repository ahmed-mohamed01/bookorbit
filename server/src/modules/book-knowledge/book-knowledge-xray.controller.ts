import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KnowledgeXrayRunDto } from './dto/book-knowledge.dto';
import { BookKnowledgeXrayService } from './book-knowledge-xray.service';

/** Admin and benchmark entry point for the X-Ray split build: start a whole-book build (or a dry run that only plans and estimates), poll it, cancel it, read its payload. */
@Controller('book-knowledge/xray/runs')
@RequirePermission(Permission.ManageAppSettings)
export class BookKnowledgeXrayController {
  constructor(private readonly xray: BookKnowledgeXrayService) {}
  @Post()
  @HttpCode(202)
  start(@CurrentUser() user: RequestUser, @Body() body: KnowledgeXrayRunDto) {
    return this.xray.start(body.bookId, user, body);
  }
  @Get(':id')
  get(@CurrentUser() _user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    void _user;
    return this.xray.get(`bk-xray-${id}`);
  }
  @Delete(':id')
  cancel(@CurrentUser() _user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    void _user;
    return this.xray.cancel(`bk-xray-${id}`);
  }
  @Get(':id/payload')
  payload(@CurrentUser() _user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    void _user;
    return this.xray.payload(`bk-xray-${id}`);
  }
}
