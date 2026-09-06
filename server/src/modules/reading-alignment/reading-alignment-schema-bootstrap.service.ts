import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { READING_ALIGNMENT_SCHEMA_SQL } from './schema/reading-alignment-schema';

const TABLE_NAMES = ['audiobook_alignment', 'audiobook_alignment_anchor'] as const;

@Injectable()
export class ReadingAlignmentSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReadingAlignmentSchemaBootstrapService.name);

  constructor(private readonly repo: ReadingAlignmentRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(READING_ALIGNMENT_SCHEMA_SQL);

      await this.repo.applySchemaStatements(statements);
      const interruptedBuildsReset = await this.repo.failInterruptedBuilds();

      if (missing.length > 0 || interruptedBuildsReset > 0) {
        this.logger.log(
          `[reading_alignment.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} interruptedBuildsReset=${interruptedBuildsReset} - schema bootstrap completed`,
        );
      }
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
