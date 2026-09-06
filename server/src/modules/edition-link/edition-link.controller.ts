import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Permission, type EditionLink, type EditionLinkCandidate, type EditionLinkForBook } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { CandidatesQueryDto } from './dto/candidates-query.dto';
import { LinkEditionDto } from './dto/link-edition.dto';
import { EditionLinkService } from './edition-link.service';
import type { BookEditionLink } from './schema/edition-link.schema';

// Serialize a DB row into the shared client contract. Explicit so tsc guards the wire shape: if the
// schema drifts (createdBy nullability, a renamed/removed column), this mapper stops compiling.
function toEditionLinkDto(row: BookEditionLink): EditionLink {
  return {
    id: row.id,
    textBookId: row.textBookId,
    audioBookId: row.audioBookId,
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

@Controller('edition-links')
export class EditionLinkController {
  constructor(private readonly service: EditionLinkService) {}

  @Get('for-book/:bookId')
  async getForBook(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<EditionLinkForBook> {
    const { link, proposed, counterpart } = await this.service.getForBook(user, bookId);
    return { link: link ? toEditionLinkDto(link) : null, proposed, counterpart };
  }

  @Get('candidates/:bookId')
  searchCandidates(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Query() query: CandidatesQueryDto,
  ): Promise<EditionLinkCandidate[]> {
    return this.service.searchCandidates(user, bookId, query.q);
  }

  @Post('link/:bookId')
  @RequirePermission(Permission.LibraryEditMetadata)
  async link(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number, @Body() dto: LinkEditionDto): Promise<EditionLink> {
    return toEditionLinkDto(await this.service.link(user, bookId, dto.counterpartId));
  }

  @Delete('link/:bookId')
  @RequirePermission(Permission.LibraryEditMetadata)
  async unlink(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number): Promise<EditionLink> {
    return toEditionLinkDto(await this.service.unlink(user, bookId));
  }
}
