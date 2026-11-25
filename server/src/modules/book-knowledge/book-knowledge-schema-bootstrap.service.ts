import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BOOK_KNOWLEDGE_SCHEMA_SQL } from './schema/book-knowledge-schema';
@Injectable()
export class BookKnowledgeSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BookKnowledgeSchemaBootstrapService.name);
  constructor(private readonly repo: BookKnowledgeRepository) {}
  async onModuleInit() {
    const start = Date.now();
    this.logger.log('[book_knowledge.schema] [start] - bootstrap started');
    try {
      await this.repo.bootstrap(splitSchemaStatements(BOOK_KNOWLEDGE_SCHEMA_SQL));
      this.logger.log(`[book_knowledge.schema] [end] durationMs=${Date.now() - start} - bootstrap completed`);
    } catch (error) {
      this.logger.error(
        `[book_knowledge.schema] [fail] durationMs=${Date.now() - start} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - bootstrap failed`,
      );
      throw error;
    }
  }
}
