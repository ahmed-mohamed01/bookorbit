import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AUDIOBOOKSHELF_SCHEMA_SQL } from './schema/audiobookshelf-schema';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

@Injectable()
export class AudiobookshelfSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AudiobookshelfSchemaBootstrapService.name);

  constructor(private readonly repo: AudiobookshelfRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('[abs.schema_bootstrap] [start] - schema bootstrap started');

    try {
      const statements = AUDIOBOOKSHELF_SCHEMA_SQL.split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean);

      await this.repo.applySchemaStatements(statements);

      this.logger.log(`[abs.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} - schema bootstrap completed`);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[abs.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
