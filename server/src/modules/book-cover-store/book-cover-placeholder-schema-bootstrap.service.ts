import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { BookCoverStoreRepository } from './book-cover-store.repository';
import { BOOK_COVER_PLACEHOLDER_SCHEMA_SQL } from './schema/book-cover-placeholder-schema';

const TABLE_NAMES = ['book_cover_placeholders'] as const;

@Injectable()
export class BookCoverPlaceholderSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BookCoverPlaceholderSchemaBootstrapService.name);

  constructor(private readonly repo: BookCoverStoreRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(BOOK_COVER_PLACEHOLDER_SCHEMA_SQL);

      await this.repo.applySchemaStatements(statements);

      if (missing.length > 0) {
        this.logger.log(
          `[book_cover.placeholder_schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} - schema bootstrap created tables`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[book_cover.placeholder_schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
