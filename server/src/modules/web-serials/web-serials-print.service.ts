import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { basename } from 'node:path';
import {
  Permission,
  isSettledBookRequestStatus,
  type WebSerialDraft,
  type WebSerialPrintSuggestion,
  type WebSerialPrintSuggestionInput,
  type WebSerialDownloadInput,
  type BatchUnitView,
  type BookRequestItem,
  ACTIVE_BOOK_REQUEST_STATUSES,
  WEB_SERIAL_MAX_PUBLISHED_VOLUMES,
  compressVolumeRanges,
  parseReleaseVolumes,
  type WebSerialPrintSeriesInput,
  type RequestWebSerialVolumesInput,
  type LinkWebSerialBatchInput,
  type WebSerialPrintState,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookRequestBatchService } from '../book-request/batch/book-request-batch.service';
import { BookRequestService } from '../book-request/book-request.service';
import { RequestFulfillmentService } from '../book-request/fulfillment/request-fulfillment.service';
import { BatchUnitFilingService } from '../book-request/batch/batch-unit-filing.service';
import { IndexerSearchService } from '../book-request/indexers/indexer-search.service';
import { UserService } from '../user/user.service';
import { SeriesService } from '../series/series.service';
import type { WebSerialSeriesRequestRow } from './schema/web-serials.schema';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { printSeriesKeys } from './web-serials-series-key.utils';

@Injectable()
export class WebSerialsPrintService implements OnModuleInit {
  private readonly logger = new Logger(WebSerialsPrintService.name);
  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly requests: BookRequestService,
    private readonly batches: BookRequestBatchService,
    private readonly series: SeriesService,
    private readonly settings: WebSerialsSettingsService,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly filing: BatchUnitFilingService,
    private readonly users: UserService,
    private readonly search: IndexerSearchService,
  ) {}

  private async logged<T>(event: string, user: RequestUser, matchId: string, run: () => Promise<T>, fields = ''): Promise<T> {
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} matchId=${matchId}${fields} - operation started`);
    try {
      const result = await run();
      this.logger.log(
        `[${event}] [end] userId=${user.id} matchId=${matchId}${fields} durationMs=${Date.now() - startedAt} completed=true - operation completed`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `[${event}] [fail] userId=${user.id} matchId=${matchId}${fields} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - operation failed`,
      );
      throw error;
    }
  }
  createDraft(user: RequestUser, matchId: string, input: WebSerialPrintSeriesInput): Promise<WebSerialDraft> {
    return this.logged(
      'web_serials.draft.create',
      user,
      matchId,
      () => this.createDraftNow(user, matchId, input),
      ` volumeCount=${input.volumeCount}`,
    );
  }
  deleteDraft(user: RequestUser, matchId: string, id: number): Promise<void> {
    return this.logged('web_serials.draft.delete', user, matchId, () => this.deleteDraftNow(user, matchId, id), ` seriesRequestId=${id}`);
  }
  suggestion(user: RequestUser, matchId: string, input: WebSerialPrintSuggestionInput): Promise<WebSerialPrintSuggestion> {
    return this.logged(
      'web_serials.print.suggestion',
      user,
      matchId,
      () => this.suggestionNow(user, matchId, input),
      ` seriesRequestId=${input.seriesRequestId} volumeCount=${input.volumeCount}`,
    );
  }
  download(user: RequestUser, matchId: string, input: WebSerialDownloadInput): Promise<WebSerialPrintState> {
    return this.logged(
      'web_serials.print.download',
      user,
      matchId,
      () => this.downloadNow(user, matchId, input),
      ` seriesRequestId=${input.seriesRequestId} downloadClientId=${input.downloadClientId} picks=${input.picks.length}`,
    );
  }

  onModuleInit(): void {
    this.filing.registerMetadataResolver((ctx) => this.resolveBatchMetadata(ctx.batchRequestId, ctx.unit));
  }
  async resolveBatchMetadata(batchRequestId: number, unit: BatchUnitView) {
    const row = await this.repo.findSeriesRequestByBatch(batchRequestId);
    if (!row) return null;
    const request = (await this.batches.findRequestsByIds([row.bookRequestId])).get(row.bookRequestId);
    const volumes = parseReleaseVolumes(unit.title ?? basename(unit.primaryPath));
    return request?.seriesName && volumes?.length === 1
      ? { seriesName: request.seriesName, seriesIndex: String(volumes[0]), authors: request.authors ?? undefined }
      : null;
  }
  private async ownedRow(user: RequestUser, matchId: string, id: number) {
    const row = await this.repo.findSeriesRequestById(id);
    if (!row || row.userId !== user.id || row.matchId !== matchId || row.kind !== 'novel')
      throw new ForbiddenException('Series request does not belong to this series or user');
    return row;
  }
  private async createDraftNow(user: RequestUser, matchId: string, input: WebSerialPrintSeriesInput): Promise<WebSerialDraft> {
    let row = await this.activeRequest(user, matchId);
    if (!row) row = await this.createSeriesRequest(user, matchId, input, true);
    return { seriesRequestId: row.id, bookRequestId: row.bookRequestId };
  }
  private async deleteDraftNow(user: RequestUser, matchId: string, id: number): Promise<void> {
    const row = await this.repo.findSeriesRequestById(id);
    if (!row) return;
    if (row.userId !== user.id || row.kind !== 'novel' || row.matchId !== matchId)
      throw new ForbiddenException('Series request does not belong to this series or user');
    if (!row.draft) return;
    if (!(await this.repo.deleteUntouchedDraft(id, user.id))) return;
    if (await this.repo.hasSeriesRequestReference(row.bookRequestId)) return;
    const request = (await this.batches.findRequestsByIds([row.bookRequestId])).get(row.bookRequestId);
    if (request?.userId === user.id) {
      if (!isSettledBookRequestStatus(request.status)) await this.requests.cancel(row.bookRequestId, user);
      await this.requests.remove(row.bookRequestId, user);
    }
  }
  async sweepDrafts(): Promise<number> {
    const rows = await this.repo.findStaleDrafts(new Date(Date.now() - 6 * 60 * 60 * 1000));
    let removed = 0;
    for (const row of rows) {
      const startedAt = Date.now();
      try {
        const owner = await this.users.findByIdWithPermissions(row.userId);
        if (!owner?.active) {
          removed += await this.repo.deleteUntouchedDraft(row.id, row.userId);
          continue;
        }
        await this.deleteDraft(owner, row.matchId, row.id);
        if (!(await this.repo.findSeriesRequestById(row.id))) removed++;
      } catch (error) {
        this.logger.error(
          `[web_serials.draft_sweep] [fail] userId=${row.userId} seriesRequestId=${row.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - draft sweep failed`,
        );
      }
    }
    return removed;
  }
  private async suggestionNow(user: RequestUser, matchId: string, input: WebSerialPrintSuggestionInput): Promise<WebSerialPrintSuggestion> {
    const row = await this.ownedRow(user, matchId, input.seriesRequestId);
    const state = await this.getState(user, matchId, { ...input, authors: [], url: '' });
    const needed = new Set(state.volumes.filter((volume) => volume.state === 'missing').map((volume) => volume.volume));
    const result = await this.fulfillment.listReleases(row.bookRequestId, { refresh: false, ...(input.query ? { overrides: input.query } : {}) });
    const candidates = result.releases
      .filter(
        (r) =>
          (!r.format || r.format.toLowerCase() === 'epub' || r.formats?.some((f) => f.toLowerCase() === 'epub')) &&
          !/\b(manga|audiobook|audio\s*book)\b/i.test(r.title),
      )
      .map((r) => ({ release: r, volumes: parseReleaseVolumes(r.title, input.volumeCount) ?? [] }))
      .filter((r) => r.volumes.length);
    const selected: typeof candidates = [];
    const covered = new Set<number>();
    while (needed.size) {
      const coverage = (candidate: (typeof candidates)[number]) => candidate.volumes.filter((v) => needed.has(v)).length;
      candidates.sort(
        (a, b) => coverage(b) - coverage(a) || b.release.score - a.release.score || (b.release.seeders ?? 0) - (a.release.seeders ?? 0),
      );
      const best = candidates.shift();
      if (!best || !coverage(best)) break;
      selected.push(best);
      for (const volume of best.volumes) if (needed.delete(volume)) covered.add(volume);
    }
    return {
      releases: selected.map(({ release }) => ({ indexerId: release.indexerId, guid: release.guid })),
      volumes: [...covered].sort((a, b) => a - b),
      sizeBytes: selected.some((r) => r.release.sizeBytes === null) ? null : selected.reduce((sum, r) => sum + (r.release.sizeBytes ?? 0), 0),
    };
  }
  private async downloadNow(user: RequestUser, matchId: string, input: WebSerialDownloadInput): Promise<WebSerialPrintState> {
    const row = await this.ownedRow(user, matchId, input.seriesRequestId);
    if (input.picks.some((pick) => pick.unitIndexes === null && pick.volumes.length > 1))
      throw new BadRequestException('A single-file release must cover exactly one volume');
    if (!(await this.repo.setSeriesDraft(row.id, false))) throw new ConflictException('This draft was closed before the download started');
    const failures: NonNullable<WebSerialPrintState['failures']> = [];
    const source = await this.requests.getOne(row.bookRequestId, user);
    const title = source.seriesName ?? source.title;
    const { novel } = await this.settings.getSettings();
    for (const pick of input.picks) {
      try {
        if (pick.unitIndexes !== null) {
          const batch = await this.batches.create(user, {
            sourceRequestId: row.bookRequestId,
            indexerId: pick.indexerId,
            releaseGuid: pick.releaseGuid,
            downloadClientId: pick.downloadClientId ?? input.downloadClientId,
            unitIndexes: pick.unitIndexes,
          });
          await this.linkBatch(user, matchId, { seriesRequestId: row.id, batchRequestId: batch.requestId });
        } else {
          for (const volume of pick.volumes) {
            const child = await this.requests.submit(
              {
                title: `${title} Vol. ${volume}`,
                seriesName: title,
                seriesIndex: volume,
                mediaKind: 'ebook',
                preferredFormats: ['epub'],
                targetLibraryId: novel.targetLibraryId ?? undefined,
                targetFolderId: novel.targetFolderId ?? undefined,
                autoGrab: false,
              },
              user,
            );
            if (child.request.status === 'available') continue;
            try {
              if (!this.search.adoptCandidate(row.bookRequestId, child.request.id, pick.indexerId, pick.releaseGuid))
                throw new BadRequestException('That release is no longer in the search results');
              await this.fulfillment.grab(
                child.request.id,
                {
                  indexerId: pick.indexerId,
                  releaseGuid: pick.releaseGuid,
                  ...(pick.downloadClientId != null ? { downloadClientId: pick.downloadClientId } : {}),
                },
                user,
              );
            } catch (error) {
              if (child.request.userId === user.id) await this.requests.cancel(child.request.id, user);
              throw error;
            }
            await this.repo.insertVolumeChild(row.id, volume, child.request.id);
          }
        }
        for (const volume of pick.volumes) await this.repo.upsertVolumeRequest(user.id, 'novel', matchId, String(volume), row.bookRequestId);
      } catch (error) {
        failures.push({
          indexerId: pick.indexerId,
          releaseGuid: pick.releaseGuid,
          error: error instanceof Error ? error.message : 'Download failed',
        });
      }
    }
    if (failures.length === input.picks.length) {
      const batchIds = (await this.repo.findBatchIds([row.id])).get(row.id) ?? [];
      if (!batchIds.length && !(await this.repo.findVolumeChildren(row.id)).length) await this.repo.setSeriesDraft(row.id, true);
    }
    const state = await this.getState(user, matchId, {
      title: input.title,
      altTitles: input.altTitles,
      authors: [],
      url: '',
      volumeCount: input.volumeCount,
    });
    return { ...state, failures };
  }
  private async activeRequest(user: RequestUser, matchId: string): Promise<WebSerialSeriesRequestRow | undefined> {
    const rows = await this.repo.findSeriesRequests(user.id, 'novel', matchId);
    const requests = await this.batches.findRequestsByIds(rows.map((row) => row.bookRequestId));
    return rows.find((row) => {
      const request = requests.get(row.bookRequestId);
      return request && ACTIVE_BOOK_REQUEST_STATUSES.includes(request.status);
    });
  }

  private async visibleRequests(ids: number[], user: RequestUser): Promise<BookRequestItem[]> {
    const requests: BookRequestItem[] = [];
    for (let i = 0; i < ids.length; i += 4) {
      const chunk = await Promise.all(
        ids.slice(i, i + 4).map(async (id) => {
          try {
            return await this.requests.getOne(id, user);
          } catch (error) {
            if (error instanceof NotFoundException || error instanceof ForbiddenException) return null;
            throw error;
          }
        }),
      );
      for (const request of chunk) if (request) requests.push(request);
    }
    return requests;
  }

  async getState(user: RequestUser, matchId: string, input: WebSerialPrintSeriesInput): Promise<WebSerialPrintState> {
    const owned = await this.series.findOwnedVolumes(user, printSeriesKeys(input.title, input.altTitles), input.volumeCount);
    const approver = user.isSuperuser || user.permissions?.includes(Permission.ManageBookRequests);
    const active =
      (await this.activeRequest(user, matchId)) ?? (approver ? (await this.repo.findSeriesRequests(user.id, 'novel', matchId))[0] : undefined);
    const requested = new Set(
      active
        ? (await this.repo.listVolumeRequests(user.id, 'novel', matchId))
            .filter((row) => row.bookRequestId === active.bookRequestId)
            .map((row) => Number(row.volume))
        : [],
    );
    const role = user.isSuperuser || user.permissions?.includes(Permission.ManageBookRequests) ? 'approver' : 'requester';
    const state: WebSerialPrintState = {
      role,
      downloads: [],
      seriesRequestId: active?.id ?? null,
      bookRequestId: active?.bookRequestId ?? null,
      volumes: Array.from({ length: input.volumeCount }, (_, index) => {
        const volume = index + 1;
        return {
          volume,
          state: owned.has(volume) ? 'owned' : role === 'requester' && requested.has(volume) ? 'requested' : 'missing',
          bookId: owned.get(volume) ?? null,
          error: null,
        };
      }),
    };
    const failedErrors = new Map<number, string | null>();
    const covered = new Set<number>();
    if (active) {
      const ids = (await this.repo.findBatchIds([active.id])).get(active.id) ?? [];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const batches = await this.batches.findBatchUnits(chunk);
        const summaries = new Map((await this.visibleRequests(chunk, user)).map((request) => [request.id, request]));
        for (const [batchId, units] of batches) {
          const volumes = [
            ...new Set(units.flatMap((unit) => parseReleaseVolumes(unit.title ?? basename(unit.primaryPath), input.volumeCount) ?? [])),
          ];
          const summary = summaries.get(batchId);
          const held = units.find((u) => u.status === 'in_dock' && u.errorMessage);
          const status =
            units.every((u) => u.status === 'filed') && units.length
              ? 'filed'
              : ['grabbed', 'downloading'].includes(summary?.status ?? '')
                ? 'downloading'
                : held && units.every((u) => ['filed', 'failed'].includes(u.status) || (u.status === 'in_dock' && u.errorMessage))
                  ? 'held'
                  : units.some((u) => u.status === 'in_dock')
                    ? 'filing'
                    : units.some((u) => u.status === 'placing')
                      ? 'downloading'
                      : units.some((u) => u.status === 'failed')
                        ? 'failed'
                        : 'waiting';
          state.downloads.push({
            key: `batch:${batchId}`,
            title: summaries.get(batchId)?.title ?? `Volumes ${compressVolumeRanges(volumes)}`,
            kind: 'batch',
            volumes,
            status,
            percent: summaries.get(batchId)?.download?.progressPercent ?? null,
            error: held?.errorMessage ?? units.find((u) => u.status === 'failed')?.errorMessage ?? null,
          });
          for (const unit of units) {
            for (const volume of parseReleaseVolumes(unit.title ?? basename(unit.primaryPath), input.volumeCount) ?? []) {
              const entry = state.volumes[volume - 1]!;
              if (unit.status === 'failed') failedErrors.set(volume, unit.errorMessage);
              else if (unit.status !== 'filed') {
                covered.add(volume);
                if (entry.state !== 'owned' && (unit.status === 'in_dock' || entry.state !== 'in_dock'))
                  entry.state = unit.status === 'in_dock' ? 'in_dock' : 'downloading';
              }
            }
          }
        }
      }
      const children = await this.repo.findVolumeChildren(active.id);
      const childRequests = new Map<number, BookRequestItem>();
      for (const request of await this.visibleRequests(
        children.map((child) => child.bookRequestId),
        user,
      ))
        childRequests.set(request.id, request);
      for (const child of children) {
        const request = childRequests.get(child.bookRequestId);
        if (!request) continue;
        const status =
          request.status === 'available'
            ? 'filed'
            : request.status === 'needs_review'
              ? 'held'
              : request.status === 'importing'
                ? 'filing'
                : ['grabbed', 'downloading'].includes(request.status)
                  ? 'downloading'
                  : request.status === 'failed'
                    ? 'failed'
                    : 'waiting';
        state.downloads.push({
          key: `single:${request.id}`,
          title: request.title,
          kind: 'single',
          volumes: [child.volume],
          status,
          percent: request.download?.progressPercent ?? null,
          error: request.statusReason,
        });
        const entry = state.volumes[child.volume - 1];
        if (!entry || entry.state === 'owned') continue;
        if (request.status === 'available' && request.matchedBookId) {
          entry.state = 'owned';
          entry.bookId = request.matchedBookId;
        } else if (status === 'filing' || status === 'held') entry.state = 'in_dock';
        else if ((status === 'downloading' || status === 'waiting') && entry.state !== 'in_dock') entry.state = 'downloading';
        else if (status === 'failed') failedErrors.set(child.volume, request.statusReason);
        if (status !== 'failed' && status !== 'filed') covered.add(child.volume);
      }
      for (const [volume, error] of failedErrors)
        if (!covered.has(volume) && state.volumes[volume - 1]!.state !== 'owned') state.volumes[volume - 1]!.error = error;
      await this.settleIfComplete(active, user);
    }
    return state;
  }

  private async createSeriesRequest(
    user: RequestUser,
    matchId: string,
    input: WebSerialPrintSeriesInput & { volumes?: number[] },
    draft: boolean,
  ): Promise<WebSerialSeriesRequestRow> {
    const { novel } = await this.settings.getSettings();
    const result = await this.requests.submit(
      {
        title: `${input.title} (light novel volumes)`,
        seriesName: input.title,
        authors: input.authors,
        mediaKind: 'ebook',
        preferredFormats: ['epub'],
        targetLibraryId: novel.targetLibraryId ?? undefined,
        targetFolderId: novel.targetFolderId ?? undefined,
        autoGrab: false,
        note: `MangaBaka: ${input.url} · Volumes: ${compressVolumeRanges(input.volumes ?? [])}`,
      },
      user,
    );
    if (!ACTIVE_BOOK_REQUEST_STATUSES.includes(result.request.status))
      throw new ConflictException('This series could not be requested because a matching book is already in your library');
    const seriesRow = {
      userId: user.id,
      kind: 'novel' as const,
      matchId,
      bookRequestId: result.request.id,
      seriesKeys: printSeriesKeys(input.title, input.altTitles),
      draft,
    };
    try {
      return await this.repo.insertSeriesRequest(seriesRow);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const active = (await this.repo.findSeriesRequests(user.id, 'novel', matchId)).find((row) => row.bookRequestId === result.request.id);
      if (!active) throw error;
      return active;
    }
  }

  async requestVolumes(user: RequestUser, matchId: string, input: RequestWebSerialVolumesInput): Promise<WebSerialPrintState> {
    if (input.volumes.some((volume) => volume > input.volumeCount)) throw new BadRequestException('Requested volumes must not exceed volumeCount');
    const startedAt = Date.now();
    this.logger.log(
      `[web_serials.series_request] [start] userId=${user.id} matchId=${matchId} volumes=${input.volumes.length} - series request started`,
    );
    try {
      let active = await this.activeRequest(user, matchId);
      if (!active) active = await this.createSeriesRequest(user, matchId, input, false);
      if (input.volumes.length) await this.repo.setSeriesDraft(active.id, false);
      for (const volume of input.volumes) await this.repo.upsertVolumeRequest(user.id, 'novel', matchId, String(volume), active.bookRequestId);
      const state = await this.getState(user, matchId, input);
      this.logger.log(
        `[web_serials.series_request] [end] userId=${user.id} matchId=${matchId} durationMs=${Date.now() - startedAt} seriesRequestId=${active.id} volumes=${input.volumes.length} - series request saved`,
      );
      return state;
    } catch (error) {
      this.logger.error(
        `[web_serials.series_request] [fail] userId=${user.id} matchId=${matchId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - series request failed`,
      );
      throw error;
    }
  }

  async linkBatch(user: RequestUser, matchId: string, input: LinkWebSerialBatchInput): Promise<void> {
    const row = await this.repo.findSeriesRequestById(input.seriesRequestId);
    if (!row || row.kind !== 'novel' || row.matchId !== matchId || (row.userId !== user.id && !user.isSuperuser))
      throw new ForbiddenException('Series request does not belong to this series or user');
    const batch = (await this.batches.findRequestsByIds([input.batchRequestId])).get(input.batchRequestId);
    if (!batch || (batch.userId !== user.id && !user.isSuperuser)) throw new ForbiddenException('Batch request does not belong to the caller');
    await this.repo.linkBatch(row.id, input.batchRequestId);
  }

  async settleIfComplete(row: WebSerialSeriesRequestRow, owner: RequestUser): Promise<boolean> {
    const request = (await this.batches.findRequestsByIds([row.bookRequestId])).get(row.bookRequestId);
    if (!request || request.userId !== row.userId) return false;
    const volumes = (await this.repo.listVolumeRequests(row.userId, 'novel', row.matchId))
      .filter((volume) => volume.bookRequestId === row.bookRequestId)
      .map((volume) => Number(volume.volume));
    if (!volumes.length) return false;
    const owned = await this.series.findOwnedVolumes(owner, row.seriesKeys, Math.min(WEB_SERIAL_MAX_PUBLISHED_VOLUMES, Math.max(...volumes)));
    if (!volumes.every((volume) => owned.has(volume))) return false;
    const settled = await this.batches.settleAvailable(row.bookRequestId, 'Every requested volume is in the library');
    if (settled)
      this.logger.log(
        `[web_serials.series_request_settle] [end] requestId=${row.bookRequestId} userId=${row.userId} volumes=${volumes.length} owned=${owned.size} settled=true - series request settled`,
      );
    return settled;
  }
}
