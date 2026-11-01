import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  type EditionSyncAdminSettings,
  type EditionSyncSettings,
  type UpdateEditionSyncAdminSettingsPayload,
  type UpsertEditionSyncSettingsPayload,
} from '@bookorbit/types';

import { PermissionService } from '../../common/services/permission.service';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { EditionSyncOverlaySourceService } from './edition-sync-overlay-source.service';
import { resolveEditionSyncSettings } from './edition-sync-policy';
import { EditionSyncSchedulerService } from './edition-sync-scheduler.service';
import { EditionSyncRepository } from './edition-sync.repository';
import type { EditionSyncSettingsRow, EditionSyncUserSettingsRow } from './schema/edition-sync.schema';

/** Per-user edition-sync settings and the server-wide schedule settings. */
@Injectable()
export class EditionSyncSettingsService {
  private readonly logger = new Logger(EditionSyncSettingsService.name);

  constructor(
    private readonly repo: EditionSyncRepository,
    private readonly permissions: PermissionService,
    private readonly scheduler: EditionSyncSchedulerService,
    private readonly overlaySource: EditionSyncOverlaySourceService,
  ) {}

  async getSettings(user: RequestUser): Promise<EditionSyncSettings> {
    return this.toSettings(user, await this.repo.findUserSettings(user.id));
  }

  async upsertSettings(user: RequestUser, payload: UpsertEditionSyncSettingsPayload): Promise<EditionSyncSettings> {
    const row = await this.repo.upsertUserSettings(user.id, { enabled: payload.enabled, bookSyncMode: payload.bookSyncMode });
    this.overlaySource.invalidate(user.id);
    return this.toSettings(user, row);
  }

  async getAdminSettings(): Promise<EditionSyncAdminSettings> {
    return toAdminSettings(await this.repo.findAdminSettings());
  }

  async updateAdminSettings(user: RequestUser, payload: UpdateEditionSyncAdminSettingsPayload): Promise<EditionSyncAdminSettings> {
    const event = 'edition_sync.admin_settings_update';
    const startedAt = Date.now();
    this.logger.log(
      `[${event}] [start] userId=${user.id} cronChanged=${payload.cronExpression !== undefined} runHoursChanged=${payload.runHours !== undefined} onFilesChangedChanged=${payload.onFilesChanged !== undefined} - admin settings update started`,
    );
    try {
      const row = await this.repo.updateAdminSettings(
        { cronExpression: payload.cronExpression, runHours: payload.runHours, onFilesChanged: payload.onFilesChanged },
        user.id,
      );
      const registered = this.scheduler.syncSchedule(row.cronExpression);
      this.logger.log(
        `[${event}] [end] userId=${user.id} durationMs=${Date.now() - startedAt} cron="${sanitizeLogValue(row.cronExpression ?? 'never')}" runHours=${row.runHours} onFilesChanged=${row.onFilesChanged} scheduleRegistered=${registered} - admin settings updated`,
      );
      return toAdminSettings(row);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      this.logger.error(
        `[${event}] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - admin settings update failed`,
      );
      throw err;
    }
  }

  private toSettings(user: RequestUser, row: EditionSyncUserSettingsRow | null): EditionSyncSettings {
    const enabled = row?.enabled ?? false;
    const bookSyncMode = row?.bookSyncMode ?? 'all_eligible';
    const policy = resolveEditionSyncSettings({ hasPermission: this.permissions.userHas(user, Permission.EditionSync), enabled, bookSyncMode });
    return { enabled, effectiveEnabled: policy.effectiveEnabled, disabledReason: policy.disabledReason, bookSyncMode };
  }
}

function toAdminSettings(row: EditionSyncSettingsRow): EditionSyncAdminSettings {
  return {
    onFilesChanged: row.onFilesChanged,
    cronExpression: row.cronExpression,
    runHours: row.runHours,
    updatedAt: row.updatedAt.getTime() > 0 ? row.updatedAt.toISOString() : null,
  };
}
