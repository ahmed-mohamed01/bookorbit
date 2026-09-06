import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MONITORED_FORMATS, monitoredAcquisitionState } from '@bookorbit/types';
import type {
  MonitorAuthorRequest,
  MonitorFormatConfig,
  MonitoredAuthorConfig,
  MonitoredAuthorDetail,
  MonitoredAuthorItem,
  MonitoredAuthorSearchResult,
  MonitoredBookItem,
  MonitoredFormat,
  MonitoredPage,
  MonitoredReleaseItem,
  MonitoredReleaseStatus,
  MonitoredSummary,
  MonitoredWork,
  MonitoredWorkPatch,
  ProviderConfigurations,
  ReleaseSearchOverrides,
  RequestFromWorkPayload,
  UpdateMonitoredAuthorRequest,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AuthorEnrichmentExecutorService } from '../authors/author-enrichment-executor.service';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { AuthorImageStorageService } from '../authors/author-image-storage.service';
import { AuthorMetadataPreferencesService } from '../authors/author-metadata-preferences.service';
import { AuthorsRepository } from '../authors/authors.repository';
import { BookRequestService } from '../book-request/book-request.service';
import { RequestFulfillmentService } from '../book-request/fulfillment/request-fulfillment.service';
import { IndexerSearchService } from '../book-request/indexers/indexer-search.service';
import type { IndexerSearchRequest } from '../book-request/indexers/indexer-search.service';
import { HardcoverClient } from '../metadata-fetch/providers/hardcover/hardcover.client';
import { LibraryService } from '../library/library.service';
import { MonitoredCatalogService, normalizeMonitoredName, type WorkAvailabilityGroup } from './monitored-catalog.service';
import { MonitoredAutoRequestService } from './monitored-autorequest.service';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import { MonitoredStoreService } from './monitored-store.service';
import { isHardcoverConfigured } from './providers/hardcover-bibliography.provider';
import { isWorkVisible } from './monitored-work-visibility';
import type { MonitoredAuthorAggregate, MonitoredReleasePageEntry } from './monitored-store.service';
import type {
  CreateMonitoredBookDto,
  ListMonitoredAuthorsDto,
  ListMonitoredBooksDto,
  ListMonitoredReleasesDto,
  ListOwnedMonitoredAuthorIdsDto,
  MonitoredAuthorDetailQueryDto,
  UpdateMonitoredBookDto,
} from './dto/monitored.dto';
import { releaseDateWithinWindow } from './release-window';

const RELEASE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const RELEASE_LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_FORMAT_CONFIG: MonitorFormatConfig = { mode: 'off', libraryId: null, folderId: null };
const CREATE_FETCH_COOLDOWN_MS = 10 * 1000;
const HARDCOVER_REQUIRED_MESSAGE =
  'Monitoring needs a Hardcover token. Connect your Hardcover account under Settings > Integrations > Hardcover, or ask an administrator to enable the Hardcover metadata source.';

type AuthorProfileMetadata = { description: string | null; website: string | null; genres: string[]; portraitAuthorId: number | null };

/**
 * Whether the viewer holds owner rights over a row. A superuser passes every write gate on this
 * module (getWritableAuthor, getWritableBook, buildDetail), so reporting isOwner:false to them left
 * the client hiding controls the backend would have accepted.
 */
function isOwnerView(ownerUserId: number, user: RequestUser): boolean {
  return user.isSuperuser || ownerUserId === user.id;
}

function monitoredReleaseStatus(work: MonitoredWork, format: MonitoredFormat, releaseDate: string, today: string): MonitoredReleaseStatus {
  if (work.matchedBookIds?.[format] != null || work.ownedFormats.includes(format)) return 'grabbed';
  return monitoredAcquisitionState(work.requestStatuses?.[format]) ?? (releaseDate <= today ? 'available' : 'upcoming');
}

/**
 * A stable id per work and format for a search that writes no book request row. Kept negative
 * because real request ids are positive: a monitored search can then never read, evict or clear a
 * real request's entries in the shared release store, and two works never share a slot.
 */
function syntheticRequestId(workId: string, format: MonitoredFormat): number {
  let hash = 0;
  for (const char of `${workId}:${format}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return -(hash >>> 0 || 1);
}

@Injectable()
export class MonitoredService {
  private readonly logger = new Logger(MonitoredService.name);
  // Creating a monitor runs the same multi-provider catalog fetch that refresh rate-limits, so
  // delete-and-recreate would otherwise be an unthrottled way around that cooldown.
  private readonly lastCatalogFetchAt = new Map<number, number>();

  constructor(
    private readonly store: MonitoredStoreService,
    private readonly catalog: MonitoredCatalogService,
    private readonly autoRequests: MonitoredAutoRequestService,
    private readonly hardcover: HardcoverClient,
    private readonly providerConfigs: MonitoredProviderConfigService,
    private readonly authorsRepository: AuthorsRepository,
    private readonly authorMetadataPreferences: AuthorMetadataPreferencesService,
    private readonly enrichmentExecutor: AuthorEnrichmentExecutorService,
    private readonly libraryService: LibraryService,
    private readonly bookRequests: BookRequestService,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly indexerSearch: IndexerSearchService,
    private readonly authorImageStorage: AuthorImageStorageService,
    private readonly appSettings: AppSettingsService,
  ) {}

  async getSummary(user: RequestUser): Promise<MonitoredSummary> {
    const now = Date.now();
    const earliest = new Date(now - RELEASE_LOOKBACK_MS).toISOString().slice(0, 10);
    const latest = new Date(now + RELEASE_LOOKAHEAD_MS).toISOString().slice(0, 10);
    const [counts, config] = await Promise.all([this.store.countSummary(user, earliest, latest), this.providerConfigs.forUser(user.id)]);
    return { ...counts, hardcoverConfigured: isHardcoverConfigured(config) };
  }

  async listAuthors(user: RequestUser, query: ListMonitoredAuthorsDto): Promise<MonitoredPage<MonitoredAuthorItem>> {
    const today = new Date().toISOString().slice(0, 10);
    const page = await this.store.findAuthorPage({
      viewer: user,
      q: query.q || undefined,
      page: query.page ?? 0,
      size: query.size ?? 50,
      sort: query.sort ?? 'name',
      order: query.order ?? 'asc',
      today,
    });
    const portraits = await this.resolvePortraits(page.items.map((item) => item.author));
    return {
      ...page,
      items: page.items.map(({ author, aggregate }) =>
        this.toAuthorItem(author, aggregate, user, {
          description: null,
          website: null,
          genres: [],
          portraitAuthorId: portraits.get(author.id) ?? null,
        }),
      ),
    };
  }

  listOwnedAuthorIds(user: RequestUser, query: ListOwnedMonitoredAuthorIdsDto): Promise<MonitoredPage<string>> {
    return this.store.findOwnedAuthorIdsPage(user, query.page ?? 0, query.size ?? 200);
  }

  // Resolve each monitored author to a local authors row (by link or name) in a single query so the
  // list cards can show the author portrait without an N+1 lookup per card.
  private async resolvePortraits(monitors: MonitoredAuthorConfig[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (monitors.length === 0) return result;
    const rows = await this.authorsRepository.findPortraitCandidates(
      monitors.map((monitor) => monitor.localAuthorId).filter((id): id is number => id != null),
      monitors.map((monitor) => monitor.authorName),
    );
    const byId = new Map<number, boolean>();
    const byName = new Map<string, { id: number; hasPhoto: boolean }>();
    for (const row of rows) {
      byId.set(row.id, row.hasPhoto);
      const key = row.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, { id: row.id, hasPhoto: row.hasPhoto });
    }
    for (const monitor of monitors) {
      const candidate =
        monitor.localAuthorId != null
          ? { id: monitor.localAuthorId, hasPhoto: byId.get(monitor.localAuthorId) ?? false }
          : (byName.get(monitor.authorName.trim().toLowerCase()) ?? null);
      result.set(monitor.id, candidate?.hasPhoto ? candidate.id : null);
    }
    return result;
  }

  async createAuthor(input: MonitorAuthorRequest, user: RequestUser): Promise<MonitoredAuthorDetail> {
    const startedAt = Date.now();
    const authorName = input.authorName.trim();
    if (!authorName) throw new BadRequestException('Author name is required');
    if (await this.store.hasAuthorNamed(user.id, authorName)) throw new BadRequestException('This author is already monitored');
    const formats = this.mergeFormats(undefined, input.formats);
    await this.assertDestinationsAllowed(formats, user);
    const config = await this.providerConfigs.forUser(user.id);
    this.assertHardcoverAvailable(config);
    this.assertCatalogFetchAllowed(user);

    const monitorId = randomUUID();
    this.logger.log(
      `[monitored.author.create] [start] monitorId="${sanitizeLogValue(monitorId)}" userId=${user.id} authorName="${sanitizeLogValue(authorName)}" - monitored author creation started`,
    );
    let monitor: MonitoredAuthorConfig | null = null;
    try {
      monitor = await this.store.upsertAuthor(
        {
          id: monitorId,
          ownerUserId: user.id,
          isShared: input.isShared ?? false,
          authorName,
          localAuthorId: input.localAuthorId ?? null,
          providerIds: input.providerIds ?? {},
          formats,
          paused: false,
          addedAt: new Date().toISOString(),
          lastRefreshedAt: null,
        },
        user,
      );
      this.recordCatalogFetch(user);
      const result = await this.catalog.fetchCatalog(monitor, config);
      const localAuthorId = await this.resolveLocalAuthorId(monitor);
      const refreshed = await this.store.upsertAuthor(
        {
          ...monitor,
          localAuthorId: localAuthorId ?? monitor.localAuthorId,
          providerIds: {
            ...monitor.providerIds,
            ...(result.hardcoverAuthorId ? { hardcover: result.hardcoverAuthorId } : {}),
          },
          lastRefreshedAt: result.catalog.fetchedAt,
        },
        user,
      );
      let works = (await this.store.getCatalog(refreshed.id, user))?.works ?? [];
      const fanOut = await this.autoRequests.fanOut(refreshed, works, user);
      if (fanOut.created > 0) works = (await this.store.getCatalog(refreshed.id, user))?.works ?? [];
      const detail = await this.buildDetail(refreshed, works, user, { sort: 'releaseDate', order: 'desc', includeHidden: false });
      this.logger.log(
        `[monitored.author.create] [end] monitorId="${sanitizeLogValue(monitor.id)}" userId=${user.id} durationMs=${Date.now() - startedAt} works=${works.length} - monitored author creation completed`,
      );
      return detail;
    } catch (error) {
      if (monitor) {
        try {
          await this.store.removeAuthor(monitor.id, user);
        } catch (rollbackError) {
          const rollbackClass = rollbackError instanceof Error ? rollbackError.name : 'Error';
          const rollbackMessage = sanitizeLogValue(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          this.logger.warn(
            `[monitored.author.create_rollback] [fail] monitorId="${sanitizeLogValue(monitor.id)}" userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${rollbackClass} error="${rollbackMessage}" - monitored author rollback failed`,
          );
        }
      }
      this.logOperationFailure('monitored.author.create', monitorId, user.id, startedAt, error);
      if (isUniqueViolation(error)) throw new BadRequestException('This author is already monitored');
      throw error;
    }
  }

  async getAuthor(id: string, user: RequestUser, query: MonitoredAuthorDetailQueryDto): Promise<MonitoredAuthorDetail> {
    const monitor = await this.getReadableAuthor(id, user);
    const catalog = await this.store.getCatalog(id, user);
    const works = catalog?.works ?? [];
    await this.healWorkAvailability([{ monitor, works }], user);
    return this.buildDetail(monitor, works, user, query);
  }

  async updateAuthor(id: string, input: UpdateMonitoredAuthorRequest, user: RequestUser): Promise<MonitoredAuthorItem> {
    const monitor = await this.getWritableAuthor(id, user);
    const formats = input.formats ? this.mergeFormats(monitor.formats, input.formats) : monitor.formats;
    if (input.formats) await this.assertDestinationsAllowed(formats, user);
    const updated = await this.store.updateAuthorFields(
      id,
      {
        ...(input.formats ? { formats } : {}),
        ...(input.paused !== undefined ? { paused: input.paused } : {}),
        ...(input.isShared !== undefined ? { isShared: input.isShared } : {}),
      },
      user,
    );
    const [catalog, metadata] = await Promise.all([this.store.getCatalog(id, user), this.loadAuthorProfile(updated)]);
    return this.toAuthorItem(updated, this.summarizeWorks(updated, catalog?.works ?? []), user, metadata);
  }

  async deleteAuthor(id: string, user: RequestUser): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.author.delete] [start] monitorId="${sanitizeLogValue(id)}" userId=${user.id} - monitored author deletion started`);
    try {
      const monitor = await this.getWritableAuthor(id, user);
      await this.store.removeAuthor(id, user);
      const orphanRemoved = await this.removeOrphanLocalAuthor(monitor.localAuthorId);
      this.logger.log(
        `[monitored.author.delete] [end] monitorId="${sanitizeLogValue(id)}" userId=${user.id} durationMs=${Date.now() - startedAt} deleted=1 orphanAuthorRemoved=${orphanRemoved} - monitored author deletion completed`,
      );
    } catch (error) {
      this.logFailure('monitored.author.delete', 'monitorId', id, user.id, startedAt, error);
      throw error;
    }
  }

  async refreshAuthor(id: string, user: RequestUser): Promise<MonitoredAuthorDetail> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.author.refresh] [start] monitorId="${sanitizeLogValue(id)}" userId=${user.id} - monitored author refresh started`);
    try {
      const monitor = await this.getWritableAuthor(id, user);
      const { refreshCooldownMinutes } = await this.appSettings.getMonitoredSettings();
      const refreshCooldownMs = refreshCooldownMinutes * 60 * 1000;
      if (monitor.lastRefreshedAt && Date.now() - new Date(monitor.lastRefreshedAt).getTime() < refreshCooldownMs) {
        throw new HttpException('Monitored author was refreshed a moment ago; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
      }
      // Use the owner's token so delegated and future background refreshes spend the owner's quota.
      const config = await this.providerConfigs.forUser(monitor.ownerUserId);
      this.assertHardcoverAvailable(config);
      const result = await this.catalog.fetchCatalog(monitor, config);
      const localAuthorId = await this.resolveLocalAuthorId(monitor);
      if (localAuthorId != null) {
        const profile = await this.authorsRepository.findByIdForEnrichment(localAuthorId);
        if (profile && (!profile.hasPhoto || !profile.description)) {
          await this.enrichLocalAuthor(localAuthorId);
        }
      }
      const refreshed = await this.store.updateAuthorFields(
        id,
        {
          ...(localAuthorId != null ? { localAuthorId } : {}),
          ...(result.hardcoverAuthorId ? { providerIds: { hardcover: result.hardcoverAuthorId } } : {}),
          lastRefreshedAt: result.catalog.fetchedAt,
        },
        user,
      );
      let works = (await this.store.getCatalog(id, user))?.works ?? [];
      const fanOut = await this.autoRequests.fanOut(refreshed, works, user);
      if (fanOut.created > 0) works = (await this.store.getCatalog(id, user))?.works ?? [];
      const detail = await this.buildDetail(refreshed, works, user, { sort: 'releaseDate', order: 'desc', includeHidden: false });
      this.logger.log(
        `[monitored.author.refresh] [end] monitorId="${sanitizeLogValue(id)}" userId=${user.id} durationMs=${Date.now() - startedAt} works=${works.length} - monitored author refresh completed`,
      );
      return detail;
    } catch (error) {
      this.logOperationFailure('monitored.author.refresh', id, user.id, startedAt, error);
      throw error;
    }
  }

  // Monitored read scope is the access check here: the authors module gates portraits on library
  // visibility, which a monitored-only author with no books in the viewer's libraries never passes.
  async getAuthorPortraitPath(id: string, user: RequestUser): Promise<string | null> {
    const monitor = await this.getReadableAuthor(id, user);
    const profile = await this.loadAuthorProfile(monitor);
    if (profile?.portraitAuthorId == null) return null;
    return this.authorImageStorage.getImagePath(profile.portraitAuthorId);
  }

  async listBooks(user: RequestUser, query: ListMonitoredBooksDto): Promise<MonitoredPage<MonitoredBookItem>> {
    const page = await this.store.findBookPage({
      viewer: user,
      q: query.q || undefined,
      page: query.page ?? 0,
      size: query.size ?? 50,
      sort: query.sort ?? 'added',
      order: query.order ?? 'desc',
    });
    return {
      ...page,
      items: page.items.map(({ entry, authorName, work }) => ({
        ...entry,
        isOwner: isOwnerView(entry.ownerUserId, user),
        authorName,
        work,
      })),
    };
  }

  async createBook(input: CreateMonitoredBookDto, user: RequestUser): Promise<MonitoredBookItem> {
    const monitor = await this.getReadableAuthor(input.monitorAuthorId, user);
    const work = (await this.store.getCatalog(monitor.id, user))?.works.find((candidate) => candidate.id === input.workId);
    if (!work) throw new NotFoundException('Monitored work not found');
    // The pre-check answers the common case with a clean message; the unique index behind it is what
    // survives two concurrent adds of the same work, and its violation means exactly the same thing.
    if (await this.store.hasBookForWork(user.id, monitor.id, work.id)) throw new BadRequestException('This work is already monitored');
    try {
      const entry = await this.store.upsertBook(
        {
          ownerUserId: user.id,
          isShared: monitor.isShared,
          monitorAuthorId: monitor.id,
          workId: work.id,
          formats: [...new Set(input.formats)],
          paused: false,
          addedAt: new Date().toISOString(),
        },
        user,
      );
      return { ...entry, isOwner: true, authorName: monitor.authorName, work };
    } catch (error) {
      if (isUniqueViolation(error)) throw new BadRequestException('This work is already monitored');
      throw error;
    }
  }

  async updateBook(id: string, input: UpdateMonitoredBookDto, user: RequestUser): Promise<MonitoredBookItem> {
    const entry = await this.getWritableBook(id, user);
    const updated = await this.store.upsertBook(
      {
        ...entry,
        paused: input.paused ?? entry.paused,
        formats: input.formats ? [...new Set(input.formats)] : entry.formats,
      },
      user,
    );
    const monitor = await this.store.getAuthor(updated.monitorAuthorId, user);
    const work = (await this.store.getCatalog(updated.monitorAuthorId, user))?.works.find((candidate) => candidate.id === updated.workId);
    if (!monitor || !work) throw new NotFoundException('Monitored book not found');
    return { ...updated, isOwner: isOwnerView(updated.ownerUserId, user), authorName: monitor.authorName, work };
  }

  async deleteBook(id: string, user: RequestUser): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.book.delete] [start] monitoredBookId="${sanitizeLogValue(id)}" userId=${user.id} - monitored book deletion started`);
    try {
      await this.getWritableBook(id, user);
      await this.store.removeBook(id, user);
      this.logger.log(
        `[monitored.book.delete] [end] monitoredBookId="${sanitizeLogValue(id)}" userId=${user.id} durationMs=${Date.now() - startedAt} deleted=1 - monitored book deletion completed`,
      );
    } catch (error) {
      this.logFailure('monitored.book.delete', 'monitoredBookId', id, user.id, startedAt, error);
      throw error;
    }
  }

  async listReleases(user: RequestUser, query: ListMonitoredReleasesDto): Promise<MonitoredPage<MonitoredReleaseItem>> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const earliest = new Date(now.getTime() - RELEASE_LOOKBACK_MS).toISOString().slice(0, 10);
    const latest = new Date(now.getTime() + RELEASE_LOOKAHEAD_MS).toISOString().slice(0, 10);
    const soonLatest = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const page = await this.store.findReleasePage({
      viewer: user,
      q: query.q || undefined,
      page: query.page ?? 0,
      size: query.size ?? 50,
      sort: query.sort ?? 'date',
      order: query.order ?? 'asc',
      filter: query.filter ?? 'all',
      earliest,
      latest,
      today,
      soonLatest,
      currentYear: today.slice(0, 4),
    });
    await this.healWorkAvailability(this.releaseHealGroups(page.items), user);
    return {
      ...page,
      items: page.items.map(({ monitor, work, format, releaseDate }) => {
        const requestId = work.requestIds[format] ?? null;
        return {
          workId: work.id,
          work,
          monitorAuthorId: monitor.id,
          isOwner: isOwnerView(monitor.ownerUserId, user),
          title: work.title,
          authorName: monitor.authorName,
          coverUrl: work.coverUrl,
          format,
          releaseDate,
          status: monitoredReleaseStatus(work, format, releaseDate, today),
          requestId,
        };
      }),
    };
  }

  async searchAuthors(query: string, user: RequestUser): Promise<MonitoredAuthorSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const [libraryIds, providerConfig] = await Promise.all([
      this.libraryService.findAccessibleLibraryIds(user),
      this.providerConfigs.forUser(user.id),
    ]);
    const local = await this.authorsRepository.findPage({
      q,
      page: 0,
      size: 5,
      sort: 'name',
      order: 'asc',
      libraryIds,
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
    });
    const hardcoverResults = isHardcoverConfigured(providerConfig) ? await this.hardcover.searchAuthors(q, providerConfig.hardcover.apiKey) : [];
    const byName = new Map<string, MonitoredAuthorSearchResult>();
    for (const author of local.items) {
      byName.set(normalizeMonitoredName(author.name), {
        name: author.name,
        providerIds: {},
        localAuthorId: author.id,
        bookCount: author.bookCount,
        imageUrl: null,
        genres: [],
        alreadyMonitoredId: null,
      });
    }
    for (const hit of hardcoverResults) {
      const key = normalizeMonitoredName(hit.name);
      const current = byName.get(key);
      byName.set(key, {
        name: current?.name ?? hit.name,
        providerIds: { ...current?.providerIds, hardcover: String(hit.id) },
        localAuthorId: current?.localAuthorId ?? null,
        bookCount: hit.books_count ?? current?.bookCount ?? null,
        imageUrl: hit.image?.url ?? current?.imageUrl ?? null,
        genres: hit.genres ?? current?.genres ?? [],
        alreadyMonitoredId: null,
      });
    }
    const results = [...byName.values()].slice(0, 10);
    // Asked only for the names actually on screen, once the two searches have produced them.
    const monitoredIds = await this.store.findMonitoredIdsByNames(
      results.map((result) => result.name),
      user,
    );
    return results.map((result) => ({ ...result, alreadyMonitoredId: monitoredIds.get(normalizeMonitoredName(result.name)) ?? null }));
  }

  /** The monitor and work for one work id, or null when no readable monitored author carries it. */
  private async findWorkEntry(user: RequestUser, workId: string) {
    const entry = await this.store.getWorkWithMonitor(workId, user);
    if (entry) await this.healWorkAvailability([{ monitor: entry.monitor, works: [entry.work] }], user);
    return entry;
  }

  private assertHardcoverAvailable(config: ProviderConfigurations): void {
    if (!isHardcoverConfigured(config)) throw new ServiceUnavailableException(HARDCOVER_REQUIRED_MESSAGE);
  }

  /**
   * The book-request id this work searches and grabs under, creating one through the normal
   * Requests pipeline when the work has none yet, or when the remembered one is gone or in a
   * terminal state (a cancelled request refuses release searches, and monitored works remember
   * ids across such cancellations).
   */
  private async ensureWorkRequestId(
    user: RequestUser,
    entry: { monitor: MonitoredAuthorConfig; work: MonitoredWork },
    format: MonitoredFormat,
  ): Promise<number> {
    const existing = entry.work.requestIds[format];
    if (existing != null) {
      try {
        await this.bookRequests.assertCanFulfil(existing, user);
        return existing;
      } catch {
        // Missing, terminal, or not fulfillable by this user: fall through and create a fresh one.
      }
    }
    const refreshed = await this.requestFromWork(user, entry.work.id, { format });
    const requestId = refreshed.requestIds[format];
    if (requestId == null) throw new BadRequestException('Could not create a book request for this work');
    return requestId;
  }

  /**
   * Effective visibility: the verdict decides unless the user overrode it. 'visible' promotes a
   * review-hidden work into the default list and into monitoring; 'hidden' removes any work.
   */
  private isWorkVisible(work: MonitoredWork): boolean {
    return isWorkVisible(work);
  }

  /** Per-work monitor/hide toggles, persisted on the catalog work and preserved across refreshes. */
  async updateWork(user: RequestUser, workId: string, patch: MonitoredWorkPatch): Promise<MonitoredWork> {
    const entry = await this.findWorkEntry(user, workId);
    if (!entry) throw new NotFoundException('Monitored work not found');
    await this.getWritableAuthor(entry.monitor.id, user);
    const changes = Object.values(patch).filter((value) => value !== undefined);
    if (changes.length === 0) return entry.work;
    return this.store.updateWorkUserState(workId, patch, user);
  }

  /**
   * Stateless release search: the criteria are built from the monitored work itself and no book
   * request is written. Every exploratory search used to materialize an approved request that then
   * sat in Requests (Beta) demanding a hand-picked release; only a grab commits to that.
   */
  async searchWorkReleases(user: RequestUser, workId: string, format: MonitoredFormat) {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.work.search_releases] [start] workId="${sanitizeLogValue(workId)}" userId=${user.id} format=${format} - monitored release search started`,
    );
    try {
      const entry = await this.findWorkEntry(user, workId);
      if (!entry) throw new NotFoundException('Monitored work not found');
      await this.getWritableAuthor(entry.monitor.id, user);
      const synthetic = this.buildSearchRequest(entry.monitor, entry.work, format);
      const result = await this.indexerSearch.search(synthetic, { refresh: true });
      // Nothing ever reads this entry back: this search always refreshes, and a grab resolves its
      // release under the real request id. Dropping it stops a browse of a monitored author from
      // parking a result set per work in the shared release store for the length of its TTL.
      this.indexerSearch.forget(synthetic.id);
      this.logger.log(
        `[monitored.work.search_releases] [end] workId="${sanitizeLogValue(workId)}" userId=${user.id} durationMs=${Date.now() - startedAt} releases=${result.releases.length} - monitored release search completed`,
      );
      return result;
    } catch (error) {
      this.logOperationFailure('monitored.work.search_releases', workId, user.id, startedAt, error, 'workId');
      throw error;
    }
  }

  async grabWorkRelease(user: RequestUser, workId: string, payload: { format: MonitoredFormat; indexerId: number; releaseGuid: string }) {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.work.grab_release] [start] workId="${sanitizeLogValue(workId)}" userId=${user.id} format=${payload.format} - monitored release grab started`,
    );
    let requestId: number | null = null;
    let warm = { searched: false, found: false };
    try {
      const entry = await this.findWorkEntry(user, workId);
      if (!entry) throw new NotFoundException('Monitored work not found');
      await this.getWritableAuthor(entry.monitor.id, user);
      requestId = await this.ensureWorkRequestId(user, entry, payload.format);
      const joined = await this.bookRequests.assertCanFulfil(requestId, user);
      warm = await this.warmPickedRelease(requestId, joined.request, entry, payload);
      const result = await this.fulfillment.grab(requestId, { indexerId: payload.indexerId, releaseGuid: payload.releaseGuid }, user);
      this.logger.log(
        `[monitored.work.grab_release] [end] workId="${sanitizeLogValue(workId)}" userId=${user.id} requestId=${requestId} durationMs=${Date.now() - startedAt} searched=${warm.searched} outcome=grabbed - monitored release grab completed`,
      );
      return result;
    } catch (error) {
      this.logOperationFailure(
        'monitored.work.grab_release',
        workId,
        user.id,
        startedAt,
        error,
        'workId',
        `requestId=${requestId ?? 'none'} searched=${warm.searched} releaseFound=${warm.found}`,
      );
      throw error;
    }
  }

  /**
   * The store a grab resolves its picked release from is keyed by book request id, and the picker
   * searched under a synthetic id that has no request row behind it, so this request's own results
   * have to exist before fulfilment can name one of them. The picker's criteria are repeated rather
   * than the row's own: a request folded in from Requests can carry an ISBN or a language the
   * picker never searched with, and either answers with a different set of releases than the one
   * the user chose from. A release already in the store is grabbed without a second round trip.
   */
  private async warmPickedRelease(
    requestId: number,
    request: IndexerSearchRequest,
    entry: { monitor: MonitoredAuthorConfig; work: MonitoredWork },
    payload: { indexerId: number; releaseGuid: string },
  ): Promise<{ searched: boolean; found: boolean }> {
    const stored = () => this.indexerSearch.find(requestId, payload.indexerId, payload.releaseGuid) != null;
    if (stored()) return { searched: false, found: true };
    await this.indexerSearch.search(request, { refresh: true, overrides: this.buildSearchOverrides(entry.monitor, entry.work) });
    return { searched: true, found: stored() };
  }

  async requestFromWork(user: RequestUser, workId: string, payload: RequestFromWorkPayload): Promise<MonitoredWork> {
    const entry = await this.store.getWorkWithMonitor(workId);
    if (!entry) throw new NotFoundException('Monitored work not found');
    if (!user.isSuperuser && entry.monitor.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored work');
    if (payload.format === 'ebook' && entry.work.ebookReleaseDate == null && entry.work.audioReleaseDate != null) {
      throw new BadRequestException('This work is audiobook-only and cannot be requested as an ebook');
    }
    return this.autoRequests.submitWorkRequest(
      user,
      entry.monitor,
      entry.work,
      payload.format,
      payload.autoDownload === undefined ? undefined : { autoGrab: payload.autoDownload },
    );
  }

  /**
   * Auto-download destinations are written once and acted on later by the fulfilment pipeline, so a
   * library the caller cannot reach, or a folder from a different library, has to be refused here
   * rather than surfacing as a foreign key failure or a download into somebody else's shelf.
   */
  private async assertDestinationsAllowed(formats: MonitoredAuthorConfig['formats'], user: RequestUser): Promise<void> {
    const targets = MONITORED_FORMATS.map((format) => ({ format, config: formats[format] })).filter(
      ({ config }) => config.libraryId != null || config.folderId != null,
    );
    if (!targets.length) return;
    const accessible = new Set(await this.libraryService.findAccessibleLibraryIds(user));
    for (const { format, config } of targets) {
      if (config.libraryId == null) throw new BadRequestException(`Select an ${format} library before choosing an ${format} folder`);
      if (!accessible.has(config.libraryId)) throw new BadRequestException(`You do not have access to the selected ${format} library`);
      if (config.folderId == null) continue;
      const library = await this.libraryService.findOne(config.libraryId);
      if (!library.folders.some((folder) => folder.id === config.folderId)) {
        throw new BadRequestException(`The selected ${format} folder does not belong to the selected ${format} library`);
      }
    }
  }

  private assertCatalogFetchAllowed(user: RequestUser): void {
    const previous = this.lastCatalogFetchAt.get(user.id);
    if (previous != null && Date.now() - previous < CREATE_FETCH_COOLDOWN_MS) {
      throw new HttpException('You are adding monitored authors too quickly; try again in a few seconds', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Claim the cooldown slot only once a provider fetch is actually about to run: a create that died
   * on validation or on a duplicate insert cost no provider traffic, so it must not lock the user out. */
  private recordCatalogFetch(user: RequestUser): void {
    this.lastCatalogFetchAt.set(user.id, Date.now());
  }

  /**
   * Monitoring an author creates a bookless row in the shared authors table. Nothing else can reach
   * that row once the monitor is gone, so the monitor that created it is what cleans it up.
   */
  private async removeOrphanLocalAuthor(localAuthorId: number | null): Promise<boolean> {
    if (localAuthorId == null) return false;
    const startedAt = Date.now();
    this.logger.log(`[monitored.author.cleanup_local] [start] authorId=${localAuthorId} - orphan local author cleanup started`);
    try {
      // Both "no books" and "no monitors" are predicates of the DELETE itself: checking them here
      // first let a monitor or a book created in between survive the read and lose its author row.
      const removed = await this.authorsRepository.deleteOrphanAuthor(localAuthorId);
      this.logger.log(
        `[monitored.author.cleanup_local] [end] authorId=${localAuthorId} durationMs=${Date.now() - startedAt} removed=${removed} - orphan local author cleanup completed`,
      );
      return removed;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.author.cleanup_local] [fail] authorId=${localAuthorId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - orphan local author cleanup failed`,
      );
      return false;
    }
  }

  private mergeFormats(
    current: MonitoredAuthorConfig['formats'] | undefined,
    patch: MonitorAuthorRequest['formats'] | UpdateMonitoredAuthorRequest['formats'],
  ): MonitoredAuthorConfig['formats'] {
    return {
      ebook: { ...(current?.ebook ?? DEFAULT_FORMAT_CONFIG), ...(patch?.ebook ?? {}) },
      audiobook: { ...(current?.audiobook ?? DEFAULT_FORMAT_CONFIG), ...(patch?.audiobook ?? {}) },
    };
  }

  private async getReadableAuthor(id: string, user: RequestUser): Promise<MonitoredAuthorConfig> {
    const monitor = await this.store.getAuthor(id, user);
    if (!monitor) throw new NotFoundException('Monitored author not found');
    return monitor;
  }

  private async getWritableAuthor(id: string, user: RequestUser): Promise<MonitoredAuthorConfig> {
    const monitor = await this.store.getAuthor(id);
    if (!monitor) throw new NotFoundException('Monitored author not found');
    if (!user.isSuperuser && monitor.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored author');
    return monitor;
  }

  private async getWritableBook(id: string, user: RequestUser) {
    const book = await this.store.getBook(id);
    if (!book) throw new NotFoundException('Monitored book not found');
    if (!user.isSuperuser && book.ownerUserId !== user.id) throw new ForbiddenException('No access to this monitored book');
    return book;
  }

  private toAuthorItem(
    author: MonitoredAuthorConfig,
    aggregate: MonitoredAuthorAggregate,
    user: RequestUser,
    metadata: AuthorProfileMetadata | null,
  ): MonitoredAuthorItem {
    return {
      ...author,
      isOwner: isOwnerView(author.ownerUserId, user),
      counts: aggregate.counts,
      nextReleaseAt: aggregate.nextReleaseAt,
      portraitAuthorId: metadata?.portraitAuthorId ?? null,
      description: metadata?.description ?? null,
      website: metadata?.website ?? null,
      genres: metadata?.genres ?? [],
    };
  }

  // A monitored author is often added from a provider search with no local link. Resolve the local
  // authors row by id or name; when it does not exist yet, create it and run the existing author
  // enrichment so the detail page can READ its portrait, bio, website, and genres from one relation.
  private async resolveLocalAuthorId(monitor: MonitoredAuthorConfig): Promise<number | null> {
    const startedAt = Date.now();
    try {
      if (monitor.localAuthorId != null) return monitor.localAuthorId;
      const existing = await this.authorsRepository.findIdByNormalizedName(monitor.authorName);
      if (existing != null) return existing;
      return await this.createAndEnrichLocalAuthor(monitor.authorName);
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.author.link_local] [fail] monitorId="${sanitizeLogValue(monitor.id)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - local author link failed`,
      );
      return null;
    }
  }

  private async createAndEnrichLocalAuthor(authorName: string): Promise<number | null> {
    const authorId = await this.authorsRepository.findOrCreateByName(authorName);
    if (authorId == null) return null;
    await this.enrichLocalAuthor(authorId);
    return authorId;
  }

  private async enrichLocalAuthor(authorId: number): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.author.enrich_local] [start] authorId=${authorId} - enriching local author`);
    try {
      const preferences = await this.authorMetadataPreferences.getPreferences();
      const result = await this.enrichmentExecutor.execute({ authorId, preferences, allowOrphan: true });
      this.logger.log(
        `[monitored.author.enrich_local] [end] authorId=${authorId} durationMs=${Date.now() - startedAt} outcome=${result.kind} - local author enriched`,
      );
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[monitored.author.enrich_local] [fail] authorId=${authorId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - local author enrichment failed`,
      );
    }
  }

  // Monitored authors are often added from a provider search with no local link, so resolve the local
  // authors row by id or by name to surface a curated portrait, bio, website, and genres on the detail page.
  private async loadAuthorProfile(monitor: MonitoredAuthorConfig): Promise<AuthorProfileMetadata | null> {
    const localAuthorId = monitor.localAuthorId ?? (await this.authorsRepository.findIdByNormalizedName(monitor.authorName));
    if (localAuthorId == null) return null;
    const row = await this.authorsRepository.findByIdForEnrichment(localAuthorId);
    if (!row) return null;
    return {
      description: row.description ?? null,
      website: row.website ?? null,
      genres: row.genres ?? [],
      portraitAuthorId: row.hasPhoto ? localAuthorId : null,
    };
  }

  /**
   * Bring the works a read is about to describe up to date on what the library actually holds, then
   * read the changed ones back through composition, so the viewer masking that decides what a user
   * is told they own still has the last word. Only works whose filed request has outrun their stored
   * match are touched, and each of those at most once a minute.
   */
  private async healWorkAvailability(groups: WorkAvailabilityGroup[], user: RequestUser): Promise<void> {
    const healed = await this.catalog.recomputeWorkAvailability(groups);
    if (healed.size === 0) return;
    const fresh = await this.store.getComposedWorks([...healed], user);
    for (const group of groups) {
      for (const work of group.works) {
        const updated = fresh.get(work.id);
        if (updated) Object.assign(work, updated);
      }
    }
  }

  /** One group per author on the page, so a rematch costs a pass per author rather than per row. */
  private releaseHealGroups(items: MonitoredReleasePageEntry[]): WorkAvailabilityGroup[] {
    const groups = new Map<string, WorkAvailabilityGroup>();
    for (const item of items) {
      const group = groups.get(item.monitor.id);
      if (group) group.works.push(item.work);
      else groups.set(item.monitor.id, { monitor: item.monitor, works: [item.work] });
    }
    return [...groups.values()];
  }

  private async buildDetail(
    monitor: MonitoredAuthorConfig,
    allWorks: MonitoredWork[],
    user: RequestUser,
    query: MonitoredAuthorDetailQueryDto,
  ): Promise<MonitoredAuthorDetail> {
    const metadata = await this.loadAuthorProfile(monitor);
    const direction = query.order === 'asc' ? 1 : -1;
    // Showing hidden works is the owner reviewing their own curation, not a viewer opting out of it.
    const isOwner = isOwnerView(monitor.ownerUserId, user);
    const works = allWorks
      .filter((work) => (isOwner && query.includeHidden) || this.isWorkVisible(work))
      .sort((left, right) => {
        if (query.sort === 'releaseDate') {
          const leftDate = this.earliestReleaseDate(left);
          const rightDate = this.earliestReleaseDate(right);
          if (leftDate == null) return rightDate == null ? 0 : 1;
          if (rightDate == null) return -1;
          return leftDate.localeCompare(rightDate) * direction;
        }
        const comparison = left.title.localeCompare(right.title);
        return comparison * direction;
      });
    // Works arrive already masked and owner-hidden-filtered by the store, which is the single
    // enforcement point for viewer-aware work data.
    return { author: this.toAuthorItem(monitor, this.summarizeWorks(monitor, allWorks), user, metadata), works };
  }

  private summarizeWorks(author: MonitoredAuthorConfig, works: MonitoredWork[]): MonitoredAuthorAggregate {
    const visibleWorks = works.filter((work) => this.isWorkVisible(work));
    const today = new Date().toISOString().slice(0, 10);
    const dated = author.paused
      ? []
      : visibleWorks
          .filter((work) => work.monitorState === 'monitoring')
          .flatMap((work) =>
            MONITORED_FORMATS.flatMap((format) => {
              const releaseDate = format === 'ebook' ? work.ebookReleaseDate : work.audioReleaseDate;
              const precision = format === 'ebook' ? work.ebookDatePrecision : work.audioDatePrecision;
              if (author.formats[format].mode === 'off' || work.monitorFormats?.[format] === false || !releaseDate) return [];
              return releaseDateWithinWindow(releaseDate, precision, today, '9999-12-31') ? [releaseDate] : [];
            }),
          )
          .sort();
    return {
      counts: {
        total: visibleWorks.length,
        ebookOwned: visibleWorks.filter((work) => work.ownedFormats.includes('ebook')).length,
        audioOwned: visibleWorks.filter((work) => work.ownedFormats.includes('audiobook')).length,
        hidden: works.length - visibleWorks.length,
      },
      nextReleaseAt: dated[0] ?? null,
    };
  }

  private earliestReleaseDate(work: MonitoredWork): string | null {
    return [work.ebookReleaseDate, work.audioReleaseDate].filter((date): date is string => date != null).sort()[0] ?? null;
  }

  /**
   * The exploratory search and the warm-up a grab runs have to ask the indexers the same question,
   * or the release the user picked is missing from the list the grab resolves against.
   */
  private buildSearchCriteria(monitor: MonitoredAuthorConfig, work: MonitoredWork): { title: string; authors: string[] } {
    return { title: work.title, authors: [monitor.authorName] };
  }

  private buildSearchOverrides(monitor: MonitoredAuthorConfig, work: MonitoredWork): ReleaseSearchOverrides {
    return { ...this.buildSearchCriteria(monitor, work), isbn: null, language: null, preferredFormats: [] };
  }

  private buildSearchRequest(monitor: MonitoredAuthorConfig, work: MonitoredWork, format: MonitoredFormat): IndexerSearchRequest {
    return {
      id: syntheticRequestId(work.id, format),
      mediaKind: format,
      ...this.buildSearchCriteria(monitor, work),
      isbn10: null,
      isbn13: null,
      metadataSources: [],
      preferredFormats: [],
      language: null,
    };
  }

  private logOperationFailure(
    event: string,
    id: string,
    userId: number,
    startedAt: number,
    error: unknown,
    idKey: 'monitorId' | 'workId' = 'monitorId',
    context = '',
  ): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] ${idKey}="${sanitizeLogValue(id)}" userId=${userId} ${context ? `${context} ` : ''}durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - monitored operation failed`,
    );
  }

  private logFailure(event: string, idKey: 'monitorId' | 'monitoredBookId', id: string, userId: number, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] ${idKey}="${sanitizeLogValue(id)}" userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - deletion failed`,
    );
  }
}
