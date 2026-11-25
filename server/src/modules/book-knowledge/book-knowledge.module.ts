import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from '../ai/ai.module';
import { BookModule } from '../book/book.module';
import { BookConsolidationModule } from '../book-consolidation/book-consolidation.module';
import { bookKnowledgeConfig } from './book-knowledge.config';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BookKnowledgeSchemaBootstrapService } from './book-knowledge-schema-bootstrap.service';
import { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import { BookKnowledgeModelService } from './book-knowledge-model.service';
import { BookKnowledgeTermsService } from './book-knowledge-terms.service';
import { BookKnowledgeKindsService } from './book-knowledge-kinds.service';
import { BookKnowledgeCardService } from './book-knowledge-card.service';
import { BookKnowledgeAskService } from './book-knowledge-ask.service';
import { BookKnowledgeBookConsolidationParticipant } from './book-knowledge-book-consolidation.participant';
import { BookKnowledgeController, BookKnowledgeSettingsController } from './book-knowledge.controller';
import { BookKnowledgeXrayController } from './book-knowledge-xray.controller';
import { BookKnowledgeXrayReaderController } from './book-knowledge-xray-reader.controller';
import { BookKnowledgeXrayService } from './book-knowledge-xray.service';
@Module({
  imports: [ConfigModule.forFeature(bookKnowledgeConfig), AiModule, BookModule, BookConsolidationModule],
  controllers: [BookKnowledgeController, BookKnowledgeSettingsController, BookKnowledgeXrayController, BookKnowledgeXrayReaderController],
  providers: [
    BookKnowledgeRepository,
    BookKnowledgeSchemaBootstrapService,
    BookKnowledgeService,
    BookKnowledgeSettingsService,
    BookKnowledgeModelService,
    BookKnowledgeTermsService,
    BookKnowledgeKindsService,
    BookKnowledgeCardService,
    BookKnowledgeAskService,
    BookKnowledgeXrayService,
    BookKnowledgeBookConsolidationParticipant,
  ],
})
export class BookKnowledgeModule {}
