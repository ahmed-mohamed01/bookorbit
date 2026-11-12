import { Module } from '@nestjs/common';

import { CommonModule } from '../../common/common.module';
import { SelfWriteRegistryModule } from '../../common/self-write-registry.module';
import { BookConsolidationModule } from '../book-consolidation/book-consolidation.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { BookModule } from '../book/book.module';
import { ChapterEditorModule } from '../chapter-editor/chapter-editor.module';
import { FileWriteModule } from '../file-write/file-write.module';
import { MetadataModule } from '../metadata/metadata.module';
import { AudioConvertBookConsolidationParticipant } from './audio-convert-book-consolidation.participant';
import { AudioConvertConverterService } from './audio-convert-converter.service';
import { AudioConvertPipelineService } from './audio-convert-pipeline.service';
import { AudioConvertQueueService } from './audio-convert-queue.service';
import { AudioConvertSchemaBootstrapService } from './audio-convert-schema-bootstrap.service';
import { AudioConvertController } from './audio-convert.controller';
import { AudioConvertRepository } from './audio-convert.repository';
import { AudioConvertService } from './audio-convert.service';

/** Fork: Convert to M4B. See FORK_MAINTENANCE.md. */
@Module({
  imports: [
    BookConsolidationModule,
    BookCoverStoreModule,
    BookModule,
    ChapterEditorModule,
    CommonModule,
    FileWriteModule,
    MetadataModule,
    SelfWriteRegistryModule,
  ],
  controllers: [AudioConvertController],
  providers: [
    AudioConvertRepository,
    AudioConvertSchemaBootstrapService,
    AudioConvertBookConsolidationParticipant,
    AudioConvertConverterService,
    AudioConvertQueueService,
    AudioConvertPipelineService,
    AudioConvertService,
  ],
})
export class AudioConvertModule {}
