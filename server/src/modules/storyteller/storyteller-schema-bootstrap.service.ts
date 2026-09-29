import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitSchemaStatements } from '../../common/utils/schema-bootstrap.utils';
import { describeError } from './storyteller-log.utils';
import { StorytellerRepository, type StorytellerInterruptedBuilds } from './storyteller.repository';
import { STORYTELLER_SCHEMA_SQL } from './schema/storyteller-schema';

const BOOTSTRAP_EVENT = 'storyteller.schema_bootstrap';
const TABLE_NAMES = ['storyteller_settings', 'storyteller_read_along_builds'] as const;

@Injectable()
export class StorytellerSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorytellerSchemaBootstrapService.name);
  private settle!: { resolve: (interrupted: StorytellerInterruptedBuilds) => void; reject: (error: unknown) => void };
  /**
   * Settles with the builds a restart interrupted once the schema is applied and those builds are
   * re-queued or failed. Nest runs the bootstrap hooks of one module concurrently, so the queue runner
   * waits on this rather than on hook order.
   */
  readonly ready: Promise<StorytellerInterruptedBuilds>;

  constructor(private readonly repo: StorytellerRepository) {
    this.ready = new Promise<StorytellerInterruptedBuilds>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // A failed bootstrap already fails the boot; this keeps the rejection from also reading as unhandled.
    this.ready.catch(() => undefined);
  }

  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();

    try {
      const missing = await this.repo.findMissingTables(TABLE_NAMES);
      const statements = splitSchemaStatements(STORYTELLER_SCHEMA_SQL);

      await this.repo.applySchemaStatements(statements);
      const interrupted = await this.repo.requeueInterruptedBuilds();
      const requeued = interrupted.requeued.length;
      const failed = interrupted.failed.length;
      const settled = interrupted.settled.length;

      if (missing.length > 0 || requeued > 0 || failed > 0 || settled > 0) {
        this.logger.log(
          `[${BOOTSTRAP_EVENT}] [end] durationMs=${Date.now() - startedAt} tablesCreated=${missing.length} interruptedBuildsRequeued=${requeued} interruptedBuildsFailed=${failed} producedBuildsSettled=${settled} - schema bootstrap completed`,
        );
      }
      this.settle.resolve(interrupted);
    } catch (err) {
      this.settle.reject(err);
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${BOOTSTRAP_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - schema bootstrap failed`,
      );
      throw err;
    }
  }
}
