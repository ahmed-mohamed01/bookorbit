import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { MonitoredStoreService } from './monitored-store.service';
import { MONITORED_SCHEMA_SQL } from './schema/monitored-schema';

const TABLE_NAMES = [
  'monitored_authors',
  'monitored_books',
  'monitored_author_works',
  'author_catalog_works',
  'author_catalog_state',
  'author_catalog_source_works',
  'author_provider_identities',
] as const;

@Injectable()
export class MonitoredSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonitoredSchemaBootstrapService.name);

  constructor(private readonly store: MonitoredStoreService) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.store.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(MONITORED_SCHEMA_SQL);

      await this.store.applySchemaStatements(statements);

      if (missing.length > 0) {
        this.logger.log(
          `[monitored.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} - schema bootstrap created tables`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[monitored.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
