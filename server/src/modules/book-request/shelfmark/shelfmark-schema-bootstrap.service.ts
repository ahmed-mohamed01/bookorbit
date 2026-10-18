import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../../common/utils/schema-bootstrap.utils';
import { BookRequestRepository } from '../book-request.repository';
import { SHELFMARK_SCHEMA_SQL } from './shelfmark-schema';

const COLUMN_NAMES = ['content_file_count'] as const;

@Injectable()
export class ShelfmarkSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(ShelfmarkSchemaBootstrapService.name);

  constructor(private readonly repo: BookRequestRepository) {}

  // Nest runs every module's onModuleInit before any onApplicationBootstrap, where crons are mounted, so the column exists before the first download-monitor or watchdog tick.
  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingColumns('book_request_downloads', COLUMN_NAMES);
      const { constraintsExtended, rowsRestored } = await this.repo.shelfmarkSchemaChanges();
      await this.repo.applySchemaStatements(splitSchemaStatements(SHELFMARK_SCHEMA_SQL));

      if (missing.length > 0 || constraintsExtended > 0 || rowsRestored > 0) {
        this.logger.log(
          `[book_request.shelfmark_schema_bootstrap] [end] durationMs=${Date.now() - startedAt} columnsAdded=${missing.length} constraintsExtended=${constraintsExtended} rowsRestored=${rowsRestored} - Shelfmark schema updated`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[book_request.shelfmark_schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - Shelfmark schema bootstrap failed`,
      );
      throw err;
    }
  }
}
