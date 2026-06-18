import { Controller, Get, Query } from '@nestjs/common';

import type { ReleaseNotesResponse } from '@bookorbit/types';

import { ReleaseNotesQueryDto } from './dto/release-notes-query.dto';
import { RELEASE_NOTES_ROUTE } from './release-notes.constants';
import { ReleaseNotesService } from './release-notes.service';

@Controller(RELEASE_NOTES_ROUTE)
export class ReleaseNotesController {
  constructor(private readonly releaseNotesService: ReleaseNotesService) {}

  @Get()
  async get(@Query() query: ReleaseNotesQueryDto): Promise<ReleaseNotesResponse> {
    if (query.page !== undefined) {
      const pageNum = Number(query.page);
      return this.releaseNotesService.getAll(Number.isFinite(pageNum) ? pageNum : 1);
    }
    const trimmed = query.since?.trim();
    return this.releaseNotesService.getSince(trimmed ? trimmed : null);
  }
}
