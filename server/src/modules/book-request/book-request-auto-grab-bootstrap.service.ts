import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { BookRequestRepository } from './book-request.repository';
import { BOOK_REQUEST_AUTO_GRAB_SCHEMA_SQL } from './schema/book-request-auto-grab-schema';

const COLUMN_NAMES = ['auto_grab'] as const;

@Injectable()
export class BookRequestAutoGrabBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BookRequestAutoGrabBootstrapService.name);

  constructor(private readonly repo: BookRequestRepository) {}

  // Nest runs every module's onModuleInit before any onApplicationBootstrap, where crons are mounted, so the column exists before the first download-monitor or watchdog tick.
  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingColumns('book_requests', COLUMN_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(BOOK_REQUEST_AUTO_GRAB_SCHEMA_SQL));

      if (missing.length > 0) {
        this.logger.log(
          `[book_request.auto_grab_bootstrap] [end] durationMs=${Date.now() - startedAt} columnsAdded=${missing.length} - auto_grab column added`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[book_request.auto_grab_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - auto_grab bootstrap failed`,
      );
      throw err;
    }
  }
}
