import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { JobReorderRequest, JobReorderResult } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { isReorderableJobSource } from './reorderable-job-source';

@Injectable()
export class ForkJobReorderService {
  private readonly logger = new Logger(ForkJobReorderService.name);

  constructor(private readonly registry: JobSourceRegistry) {}

  async reorder(user: RequestUser, { id, targetId, place }: JobReorderRequest): Promise<JobReorderResult> {
    const [type, nativeId] = id.split(':');
    const [, targetNativeId] = targetId.split(':');
    const source = this.registry.get(type);
    if (!source || !isReorderableJobSource(source)) return { outcome: 'skipped', status: null };
    const access = source.access(user);
    if (!access.own && !access.all) return { outcome: 'not-found', status: null };

    const start = Date.now();
    const event = source.type.replaceAll('-', '_') + '.jobs_reorder';
    const fields = `jobId=${id} targetId=${targetId} userId=${user.id} place=${place}`;
    this.logger.log(`[${event}] [start] ${fields} - moving queued job`);
    let result: JobReorderResult;
    try {
      result = id === targetId ? { outcome: 'skipped', status: null } : await source.reorderTo(nativeId, targetNativeId, place, { user, access });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        result = { outcome: 'skipped', status: null };
      } else if (error instanceof ForbiddenException || error instanceof BadRequestException) {
        result = { outcome: 'refused', status: null };
      } else {
        this.logger.warn(
          `[${event}] [fail] ${fields} durationMs=${Date.now() - start} outcome=error errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - queue reorder failed`,
        );
        return { outcome: 'error', status: null };
      }
    }
    this.logger.log(`[${event}] [end] ${fields} durationMs=${Date.now() - start} outcome=${result.outcome} - queue reorder finished`);
    return result;
  }
}
