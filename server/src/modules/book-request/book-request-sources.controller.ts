import { Controller, Get } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BookRequestSourcesService } from './book-request-sources.service';

@Controller('book-request-sources')
@RequirePermission(Permission.BookRequestAccess)
export class BookRequestSourcesController {
  constructor(private readonly sources: BookRequestSourcesService) {}

  @Get()
  list() {
    return this.sources.list();
  }
}
