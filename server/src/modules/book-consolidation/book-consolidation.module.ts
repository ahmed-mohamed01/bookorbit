import { Module } from '@nestjs/common';

import { BookConsolidationParticipants } from './book-consolidation-participants';
import { BookConsolidationRepository } from './book-consolidation.repository';
import { BookConsolidationService } from './book-consolidation.service';

/** Imports no feature module, so file-write, book-move, the scanner and book-merge can all use it. */
@Module({
  providers: [BookConsolidationRepository, BookConsolidationService, BookConsolidationParticipants],
  exports: [BookConsolidationService, BookConsolidationParticipants],
})
export class BookConsolidationModule {}
