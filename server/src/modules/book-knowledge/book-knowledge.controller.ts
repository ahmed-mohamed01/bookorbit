import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Permission } from '@bookorbit/types';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResolvesMergedBook } from '../../common/decorators/resolves-merged-book.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KnowledgeScopeDto, KnowledgeTermsDto, KnowledgeAskDto, KnowledgeBuildDto, KnowledgeSettingsDto } from './dto/book-knowledge.dto';
import { KnowledgeTermKeyPipe } from './book-knowledge-term-key.pipe';
import { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeTermsService } from './book-knowledge-terms.service';
import { BookKnowledgeCardService } from './book-knowledge-card.service';
import { BookKnowledgeAskService } from './book-knowledge-ask.service';
import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';

const ANSWER_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

async function withReaderSignal<T>(reply: FastifyReply, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const hangUp = new AbortController();
  const handleClose = () => {
    if (!reply.raw.writableEnded) hangUp.abort();
  };
  reply.raw.on('close', handleClose);
  try {
    return await operation(hangUp.signal);
  } finally {
    reply.raw.off('close', handleClose);
  }
}

@Controller('books/:bookId/knowledge')
export class BookKnowledgeController {
  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly terms: BookKnowledgeTermsService,
    private readonly cards: BookKnowledgeCardService,
    private readonly questions: BookKnowledgeAskService,
  ) {}
  @Get()
  @ResolvesMergedBook({ params: ['bookId'] })
  status(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser, @Query() query: KnowledgeScopeDto) {
    return this.knowledge.status(bookId, user, query.scope);
  }
  @Post('build')
  @HttpCode(200)
  @ResolvesMergedBook({ params: ['bookId'] })
  build(
    @Param('bookId', ParseIntPipe) bookId: number,
    @CurrentUser() user: RequestUser,
    @Query() query: KnowledgeScopeDto,
    @Body() _body: KnowledgeBuildDto,
  ) {
    void _body;
    return this.knowledge.build(bookId, user, query.scope);
  }
  @Get('terms')
  @ResolvesMergedBook({ params: ['bookId'] })
  list(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser, @Query() query: KnowledgeTermsDto) {
    return this.terms.list(bookId, user, query);
  }
  @Get('terms/:termKey')
  @ResolvesMergedBook({ params: ['bookId'] })
  detail(
    @Param('bookId', ParseIntPipe) bookId: number,
    @CurrentUser() user: RequestUser,
    @Param('termKey', KnowledgeTermKeyPipe) key: string,
    @Query() query: KnowledgeScopeDto,
  ) {
    return this.terms.detail(bookId, user, key, query.scope);
  }
  @Post('terms/:termKey/card')
  @HttpCode(200)
  @Throttle(ANSWER_THROTTLE)
  @ResolvesMergedBook({ params: ['bookId'] })
  card(
    @Param('bookId', ParseIntPipe) bookId: number,
    @CurrentUser() user: RequestUser,
    @Param('termKey', KnowledgeTermKeyPipe) key: string,
    @Query() query: KnowledgeScopeDto,
    @Body() _body: KnowledgeBuildDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void _body;
    return withReaderSignal(reply, (signal) => this.cards.card(bookId, user, key, query.scope, signal));
  }
  @Post('ask')
  @HttpCode(200)
  @Throttle(ANSWER_THROTTLE)
  @ResolvesMergedBook({ params: ['bookId'] })
  ask(
    @Param('bookId', ParseIntPipe) bookId: number,
    @CurrentUser() user: RequestUser,
    @Query() query: KnowledgeScopeDto,
    @Body() body: KnowledgeAskDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return withReaderSignal(reply, (signal) => this.questions.ask(bookId, user, body.question, query.scope, signal));
  }
}
@Controller('book-knowledge/settings')
@RequirePermission(Permission.ManageAppSettings)
export class BookKnowledgeSettingsController {
  constructor(private readonly settings: BookKnowledgeSettingsService) {}
  @Get() get(@CurrentUser() _user: RequestUser) {
    void _user;
    return this.settings.get();
  }
  @Put() update(@CurrentUser() _user: RequestUser, @Body() body: KnowledgeSettingsDto) {
    return this.settings.update(body, _user.id);
  }
}
