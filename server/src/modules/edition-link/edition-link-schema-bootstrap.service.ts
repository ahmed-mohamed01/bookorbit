import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { EditionLinkRepository } from './edition-link.repository';
import { EDITION_LINK_SCHEMA_SQL } from './schema/edition-link-schema';

const TABLE_NAMES = ['book_edition_links'] as const;

@Injectable()
export class EditionLinkSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EditionLinkSchemaBootstrapService.name);

  constructor(private readonly repo: EditionLinkRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(EDITION_LINK_SCHEMA_SQL);

      await this.repo.applySchemaStatements(statements);

      if (missing.length > 0) {
        this.logger.log(
          `[edition_link.schema_bootstrap] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} - schema bootstrap created tables`,
        );
      }
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[edition_link.schema_bootstrap] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
