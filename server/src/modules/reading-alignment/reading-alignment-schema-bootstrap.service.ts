import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { READING_ALIGNMENT_SCHEMA_SQL } from './schema/reading-alignment-schema';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

@Injectable()
export class ReadingAlignmentSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReadingAlignmentSchemaBootstrapService.name);

  constructor(private readonly repo: ReadingAlignmentRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('[reading_alignment.schema_bootstrap] [start] - schema bootstrap started');

    try {
      const statements = READING_ALIGNMENT_SCHEMA_SQL.split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean);

      await this.repo.applySchemaStatements(statements);
      const interruptedBuildsReset = await this.repo.failInterruptedBuilds();

      this.logger.log(
        `[reading_alignment.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} interruptedBuildsReset=${interruptedBuildsReset} - schema bootstrap completed`,
      );
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[reading_alignment.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
