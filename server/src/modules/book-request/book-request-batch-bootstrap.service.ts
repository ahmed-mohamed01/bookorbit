import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { BookRequestBatchRepository } from './batch/book-request-batch.repository';
import { BOOK_REQUEST_BATCH_SCHEMA_SQL } from './schema/book-request-batch-schema';

const COLUMN_NAMES = ['kind'] as const;

@Injectable()
export class BookRequestBatchBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BookRequestBatchBootstrapService.name);

  constructor(private readonly repo: BookRequestBatchRepository) {}

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingColumns('book_requests', COLUMN_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(BOOK_REQUEST_BATCH_SCHEMA_SQL));

      if (missing.length > 0) {
        this.logger.log(
          `[book_request.batch_bootstrap] [end] durationMs=${Date.now() - startedAt} columnsAdded=${missing.length} - batch grab schema applied`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[book_request.batch_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - batch grab schema bootstrap failed`,
      );
      throw err;
    }
  }
}
