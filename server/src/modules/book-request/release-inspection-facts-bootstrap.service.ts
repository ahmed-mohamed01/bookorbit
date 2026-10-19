import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { ReleaseInspectionFactsRepository } from './indexers/release-inspection-facts.repository';
import { RELEASE_INSPECTION_FACTS_SCHEMA_SQL } from './schema/release-inspection-facts-schema';

const TABLE_NAMES = ['release_inspection_facts'] as const;

@Injectable()
export class ReleaseInspectionFactsBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(ReleaseInspectionFactsBootstrapService.name);

  constructor(private readonly repo: ReleaseInspectionFactsRepository) {}

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      await this.repo.applySchemaStatements(splitSchemaStatements(RELEASE_INSPECTION_FACTS_SCHEMA_SQL));

      if (missing.length > 0) {
        this.logger.log(
          `[book_request.release_facts_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesAdded=${missing.length} - release inspection facts schema applied`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[book_request.release_facts_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - release inspection facts schema bootstrap failed`,
      );
      throw err;
    }
  }
}
