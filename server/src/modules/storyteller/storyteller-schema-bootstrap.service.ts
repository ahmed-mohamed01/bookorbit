import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { describeError } from './storyteller-log.utils';
import { StorytellerRepository } from './storyteller.repository';
import { STORYTELLER_SCHEMA_SQL } from './schema/storyteller-schema';

const BOOTSTRAP_EVENT = 'storyteller.schema_bootstrap';
const TABLE_NAMES = ['storyteller_settings', 'storyteller_read_along_builds'] as const;

@Injectable()
export class StorytellerSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorytellerSchemaBootstrapService.name);

  constructor(private readonly repo: StorytellerRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(STORYTELLER_SCHEMA_SQL);

      await this.repo.applySchemaStatements(statements);
      const interruptedBuildsReset = await this.repo.failInterruptedBuilds();

      if (missing.length > 0 || interruptedBuildsReset > 0) {
        this.logger.log(
          `[${BOOTSTRAP_EVENT}] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} interruptedBuildsReset=${interruptedBuildsReset} - schema bootstrap completed`,
        );
      }
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${BOOTSTRAP_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
