import type { RequestUser } from '../../common/types/request-user';
import { Permission } from '@bookorbit/types';
import type { WebSerialJob } from '@bookorbit/types';
import { seriesCoverPath } from './web-serials-series-key.utils';
import type { WebSerialJobWithLibrary } from './web-serials.repository';

export function isWebSerialsAdmin(user: RequestUser): boolean {
  return user.isSuperuser || user.permissions.includes(Permission.ManageAppSettings);
}

export function toWebSerialJob(row: WebSerialJobWithLibrary, includeOwner = false): WebSerialJob {
  return {
    id: row.id,
    kind: row.kind,
    seriesKey: row.seriesKey,
    title: row.title,
    author: row.author,
    coverUrl: row.engineState['hasCover'] === true ? seriesCoverPath(row.seriesKey) : null,
    sourceName: row.sourceName,
    packaging: row.packaging,
    selection: row.selection,
    libraryId: row.targetLibraryId,
    libraryName: row.libraryName,
    status: row.status,
    unitsTotal: row.unitsTotal,
    unitsDone: row.unitsDone,
    unitsFailed: row.unitsFailed,
    unitsSkipped: row.unitsSkipped,
    current: row.currentUnit ?? null,
    message: row.message,
    queuePosition: row.queuePosition,
    owner: includeOwner ? { id: row.userId, name: row.ownerName ?? '' } : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
