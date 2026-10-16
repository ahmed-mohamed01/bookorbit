import { BadGatewayException, BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';

import type {
  TestWebSerialEngineInput,
  UpdateWebSerialSettingsInput,
  WebSerialEngineConnectionInput,
  WebSerialEngineHealth,
  WebSerialKind,
  WebSerialMangaSource,
  WebSerialNovelEngine,
  WebSerialNovelSource,
  WebSerialSettings,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import { SOURCE_ID_PREFIX, type EngineConnection, type WebSerialEngineClient } from './engines/web-serial-engine';
import { LncrawlClient } from './engines/lncrawl.client';
import { NovelSourcesClient } from './engines/novel-sources.client';
import { SuwayomiClient } from './engines/suwayomi.client';
import type { NewWebSerialSettingsRow, WebSerialSettingsRow } from './schema/web-serials.schema';
import { describeError } from './web-serials-log.utils';
import { WebSerialsSecretService } from './web-serials-secret.service';
import { ensureSafeEngineUrl, parseAndNormalizeEngineUrl } from './web-serials-url.utils';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const UPDATE_EVENT = 'web_serials.settings.update';
const TEST_EVENT = 'web_serials.settings.test';
const SOURCES_EVENT = 'web_serials.novel_sources';
const QUEUE_PAUSE_EVENT = 'web_serials.queue_pause';
const MANGA_SOURCES_EVENT = 'web_serials.manga_sources';
const ERROR_MESSAGE_MAX_LENGTH = 300;
const LIBRARY_FORMAT: Record<WebSerialKind, string> = { manga: 'cbz', novel: 'epub' };
const ENGINE_LABEL: Record<WebSerialKind, string> = { manga: 'Manga', novel: 'Novel' };

interface KindFields {
  url: string | null;
  username: string | null;
  passwordEnc: string | null;
  libraryId: number | null;
  folderId: number | null;
}

export interface WebSerialEngineConfig {
  connection: EngineConnection;
  /** Manga: `source:<id>` entries, or language codes while no sources were picked. Novel: search domains. Passed to the engine client. */
  allowedSources: string[];
  targetLibraryId: number | null;
  targetFolderId: number | null;
  engine: 'suwayomi' | WebSerialNovelEngine | 'fileindex';
}

function selectedNovelEngine(row: WebSerialSettingsRow | undefined): WebSerialNovelEngine {
  return row?.novelEngine ?? (row?.novelUrl ? 'lncrawl' : 'lnreader');
}

function kindFields(row: WebSerialSettingsRow | undefined, kind: WebSerialKind, novelEngine = selectedNovelEngine(row)): KindFields {
  if (kind === 'manga') {
    return {
      url: row?.mangaUrl ?? null,
      username: row?.mangaUsername ?? null,
      passwordEnc: row?.mangaPasswordEnc ?? null,
      libraryId: row?.mangaTargetLibraryId ?? null,
      folderId: row?.mangaTargetFolderId ?? null,
    };
  }
  if (novelEngine === 'lnreader') {
    return {
      url: row?.novelSourcesUrl ?? null,
      username: null,
      passwordEnc: row?.novelSourcesTokenEnc ?? null,
      libraryId: row?.novelTargetLibraryId ?? null,
      folderId: row?.novelTargetFolderId ?? null,
    };
  }
  return {
    url: row?.novelUrl ?? null,
    username: row?.novelUsername ?? null,
    passwordEnc: row?.novelPasswordEnc ?? null,
    libraryId: row?.novelTargetLibraryId ?? null,
    folderId: row?.novelTargetFolderId ?? null,
  };
}

function mangaAllowedSources(row: WebSerialSettingsRow | undefined): string[] {
  if (row?.mangaSourceIds) return row.mangaSourceIds.map((id) => `${SOURCE_ID_PREFIX}${id}`);
  return row?.mangaLanguages ?? ['en'];
}

function normalizeList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function uniqueList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return value;
  }
}

@Injectable()
export class WebSerialsSettingsService {
  private readonly logger = new Logger(WebSerialsSettingsService.name);
  private selectionVersion = 0;

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly secretService: WebSerialsSecretService,
    private readonly libraryService: LibraryService,
    private readonly suwayomi: SuwayomiClient,
    private readonly lncrawl: LncrawlClient,
    private readonly novelSources?: NovelSourcesClient,
  ) {}

  /** Changes whenever the engine connection or the enabled sources change, so caches keyed on it never outlive a settings edit. */
  get catalogVersion(): number {
    return this.selectionVersion;
  }

  bumpCatalogVersion(): void {
    this.selectionVersion += 1;
  }

  async getSettings(): Promise<WebSerialSettings> {
    const row = await this.repo.getSettings();
    const manga = kindFields(row, 'manga');
    const engine = selectedNovelEngine(row);
    const novel = kindFields(row, 'novel', engine);
    return {
      manga: {
        url: manga.url,
        username: manga.username,
        passwordConfigured: Boolean(manga.passwordEnc),
        lastCheck: row?.mangaLastCheck ?? null,
        sourceIds: row?.mangaSourceIds ?? null,
        languages: row?.mangaLanguages ?? ['en'],
        targetLibraryId: manga.libraryId,
        targetFolderId: manga.folderId,
      },
      novel: {
        engine,
        url: novel.url,
        username: novel.username,
        passwordConfigured: Boolean(novel.passwordEnc),
        lastCheck: row?.novelLastCheck ?? null,
        searchDomains: row?.novelSearchDomains ?? [],
        sourceIds: row?.novelSourceIds ?? [],
        targetLibraryId: novel.libraryId,
        targetFolderId: novel.folderId,
        defaultPackaging: row?.novelDefaultPackaging ?? 'volume',
        indexDailyBudget: row?.novelIndexDailyBudget ?? 1500,
      },
      maxConcurrentJobs: row?.maxConcurrentJobs ?? 2,
      lookup: { enabled: row?.lookupEnabled ?? true, lastCheck: row?.lookupLastCheck ?? null },
    };
  }

  async updateSettings(input: UpdateWebSerialSettingsInput, user: RequestUser): Promise<WebSerialSettings> {
    const startedAt = Date.now();
    this.logger.log(`[${UPDATE_EVENT}] [start] userId=${user.id} - settings update started`);

    const existing = await this.repo.getSettings();
    const data: Partial<NewWebSerialSettingsRow> = {};

    if (input.manga) {
      const result = await this.buildKindUpdate('manga', input.manga, input.manga.targetLibraryId, input.manga.targetFolderId, existing, user);
      Object.assign(
        data,
        {
          mangaUrl: result.url,
          mangaUsername: result.username,
          mangaPasswordEnc: result.passwordEnc,
          mangaLastCheck: result.clearCheck ? null : undefined,
          mangaTargetLibraryId: result.libraryId,
          mangaTargetFolderId: result.folderId,
        },
        input.manga.languages !== undefined ? { mangaLanguages: normalizeList(input.manga.languages) } : {},
        input.manga.sourceIds !== undefined ? { mangaSourceIds: [...new Set(input.manga.sourceIds)] } : {},
      );
    }
    if (input.novel) {
      const previousEngine = selectedNovelEngine(existing);
      const engine = input.novel.engine ?? previousEngine;
      const result = await this.buildKindUpdate(
        'novel',
        input.novel,
        input.novel.targetLibraryId,
        input.novel.targetFolderId,
        existing,
        user,
        engine,
      );
      const connectionFields =
        engine === 'lnreader'
          ? {
              novelSourcesUrl: result.url,
              novelSourcesTokenEnc: result.passwordEnc,
            }
          : {
              novelUrl: result.url,
              novelUsername: result.username,
              novelPasswordEnc: result.passwordEnc,
            };
      Object.assign(
        data,
        {
          ...connectionFields,
          novelEngine: input.novel.engine,
          novelLastCheck: result.clearCheck || engine !== previousEngine ? null : undefined,
          novelTargetLibraryId: result.libraryId,
          novelTargetFolderId: result.folderId,
        },
        input.novel.searchDomains !== undefined ? { novelSearchDomains: normalizeList(input.novel.searchDomains) } : {},
        input.novel.sourceIds !== undefined ? { novelSourceIds: uniqueList(input.novel.sourceIds) } : {},
        input.novel.defaultPackaging !== undefined ? { novelDefaultPackaging: input.novel.defaultPackaging } : {},
        input.novel.indexDailyBudget !== undefined ? { novelIndexDailyBudget: input.novel.indexDailyBudget } : {},
      );
    }
    if (input.maxConcurrentJobs !== undefined) data.maxConcurrentJobs = input.maxConcurrentJobs;
    if (input.lookup?.enabled !== undefined) data.lookupEnabled = input.lookup.enabled;

    const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as Partial<NewWebSerialSettingsRow>;
    await this.repo.upsertSettings(defined);
    this.bumpCatalogVersion();
    await this.refreshChangedChecks(input, existing);
    this.logger.log(
      `[${UPDATE_EVENT}] [end] userId=${user.id} durationMs=${Date.now() - startedAt} fields=${Object.keys(defined).length} - settings saved`,
    );
    return this.getSettings();
  }

  /**
   * The saved check counts searchable sources under the selection that was saved when it ran, so it goes stale
   * when sources, languages or domains change or extensions come and go. Best effort: a failed re-check keeps the old one.
   */
  async refreshHealth(kind: WebSerialKind): Promise<void> {
    const startedAt = Date.now();
    try {
      const config = await this.getEngineConfig(kind);
      if (!config) return;
      const health = await this.clientFor(kind, config.engine === 'suwayomi' || config.engine === 'fileindex' ? undefined : config.engine).health(
        config.connection,
        config.allowedSources,
      );
      await this.repo.recordCheck(kind, health, config.connection.url);
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${TEST_EVENT}] [fail] kind=${kind} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - connection re-check failed`,
      );
    }
  }

  private async refreshChangedChecks(input: UpdateWebSerialSettingsInput, existing: WebSerialSettingsRow | undefined): Promise<void> {
    const mangaChanged = input.manga?.sourceIds !== undefined || input.manga?.languages !== undefined;
    const novelChanged = input.novel?.searchDomains !== undefined || input.novel?.sourceIds !== undefined || input.novel?.engine !== undefined;
    if (mangaChanged && existing?.mangaLastCheck && input.manga?.url === undefined) await this.refreshHealth('manga');
    if (novelChanged && existing?.novelLastCheck && input.novel?.url === undefined) await this.refreshHealth('novel');
  }

  async getEngineConfig(kind: WebSerialKind): Promise<WebSerialEngineConfig | null> {
    const row = await this.repo.getSettings();
    const engine = kind === 'novel' ? selectedNovelEngine(row) : 'suwayomi';
    const fields = kindFields(row, kind, engine === 'suwayomi' ? undefined : engine);
    if (!fields.url) return null;
    const fallbackFields = kind === 'novel' && engine === 'lnreader' ? kindFields(row, 'novel', 'lncrawl') : null;
    return {
      connection: {
        url: fields.url,
        username: fields.username,
        password: fields.passwordEnc ? this.secretService.decrypt(fields.passwordEnc) : null,
        ...(kind === 'novel' && engine === 'lnreader' ? { solver: row?.novelLastCheck?.solver === true } : {}),
        ...(fallbackFields?.url
          ? {
              fallback: {
                url: fallbackFields.url,
                username: fallbackFields.username,
                password: fallbackFields.passwordEnc ? this.secretService.decrypt(fallbackFields.passwordEnc) : null,
              },
            }
          : {}),
      },
      allowedSources:
        kind === 'manga' ? mangaAllowedSources(row) : engine === 'lnreader' ? (row?.novelSourceIds ?? []) : (row?.novelSearchDomains ?? []),
      targetLibraryId: fields.libraryId,
      targetFolderId: fields.folderId,
      engine,
    };
  }

  /** Where light novels land by default, whichever engine (or file index) provides them. */
  async getNovelTargets(): Promise<Pick<WebSerialEngineConfig, 'targetLibraryId' | 'targetFolderId'>> {
    const row = await this.repo.getSettings();
    return { targetLibraryId: row?.novelTargetLibraryId ?? null, targetFolderId: row?.novelTargetFolderId ?? null };
  }

  async getNovelEngineConfig(engine: WebSerialNovelEngine): Promise<WebSerialEngineConfig | null> {
    const row = await this.repo.getSettings();
    const fields = kindFields(row, 'novel', engine);
    if (!fields.url) return null;
    return {
      connection: {
        url: fields.url,
        username: fields.username,
        password: fields.passwordEnc ? this.secretService.decrypt(fields.passwordEnc) : null,
        ...(engine === 'lnreader' ? { solver: row?.novelLastCheck?.solver === true } : {}),
      },
      allowedSources: engine === 'lnreader' ? (row?.novelSourceIds ?? []) : (row?.novelSearchDomains ?? []),
      targetLibraryId: fields.libraryId,
      targetFolderId: fields.folderId,
      engine,
    };
  }

  async isQueuePaused(): Promise<boolean> {
    return this.repo.getQueuePaused();
  }

  async setQueuePaused(paused: boolean, user: RequestUser): Promise<void> {
    const startedAt = Date.now();
    await this.repo.setQueuePaused(paused);
    this.logger.log(
      `[${QUEUE_PAUSE_EVENT}] [end] userId=${user.id} paused=${paused} durationMs=${Date.now() - startedAt} - download queue ${paused ? 'paused' : 'resumed'}`,
    );
  }

  async getMaxConcurrentJobs(): Promise<number> {
    const row = await this.repo.getSettings();
    return row?.maxConcurrentJobs ?? 2;
  }

  /**
   * Tests a connection before it is saved: a sent field replaces the stored one and an omitted field
   * falls back to it. The stored password is never used against a URL that is not the saved one.
   */
  async testConnection(user: RequestUser, input: TestWebSerialEngineInput): Promise<WebSerialEngineHealth> {
    const startedAt = Date.now();
    const { kind } = input;
    const row = await this.repo.getSettings();
    const novelEngine = kind === 'novel' ? (input.engine ?? selectedNovelEngine(row)) : undefined;
    const stored = kindFields(row, kind, novelEngine);

    let url = stored.url;
    let urlFromPayload = false;
    const sentUrl = input.url?.trim();
    if (sentUrl && sentUrl !== stored.url) {
      url = parseAndNormalizeEngineUrl(sentUrl);
      urlFromPayload = true;
    }
    const username = input.username !== undefined ? input.username?.trim() || null : stored.username;
    const typedPassword = input.password || null;

    const unsavedHost = url !== stored.url;
    const storedPasswordUsable = Boolean(stored.passwordEnc) && !unsavedHost;
    const draft = unsavedHost || username !== stored.username || typedPassword !== null;
    this.logger.log(`[${TEST_EVENT}] [start] userId=${user.id} kind=${kind} draft=${draft} - connection test started`);

    if (!url) {
      const message = urlFromPayload ? 'The address must be a valid http or https URL' : `${ENGINE_LABEL[kind]} connection is not configured`;
      return this.finishFailure(kind, user, startedAt, draft, stored.url, message);
    }
    if (unsavedHost && !typedPassword && stored.passwordEnc) {
      return this.finishFailure(kind, user, startedAt, draft, url, 'Enter the password for this address before testing it');
    }

    try {
      if (urlFromPayload) await ensureSafeEngineUrl(url);
      const password = typedPassword ?? (storedPasswordUsable && stored.passwordEnc ? this.secretService.decrypt(stored.passwordEnc) : null);
      const allowedSources =
        kind === 'manga' ? mangaAllowedSources(row) : novelEngine === 'lnreader' ? (row?.novelSourceIds ?? []) : (row?.novelSearchDomains ?? []);
      const health = await this.clientFor(kind, novelEngine).health({ url, username, password }, allowedSources);
      if (!draft) await this.repo.recordCheck(kind, health, url);
      this.logger.log(
        `[${TEST_EVENT}] [end] userId=${user.id} kind=${kind} durationMs=${Date.now() - startedAt} draft=${draft} ok=${health.ok} searchableSources=${health.searchableSources} - connection test completed`,
      );
      return health;
    } catch (err) {
      const isDecryptFailure = err instanceof InternalServerErrorException;
      const { errorClass, message } = describeError(err);
      const errorMessage = (isDecryptFailure ? 'Stored password could not be decrypted' : message).slice(0, ERROR_MESSAGE_MAX_LENGTH);
      this.logger.error(
        `[${TEST_EVENT}] [fail] userId=${user.id} kind=${kind} durationMs=${Date.now() - startedAt} draft=${draft} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - connection test failed`,
      );
      const result = this.failureHealth(errorMessage);
      if (!draft) await this.repo.recordCheck(kind, result, url);
      return result;
    }
  }

  async listNovelSources(): Promise<WebSerialNovelSource[]> {
    const startedAt = Date.now();
    const config = await this.getEngineConfig('novel');
    if (!config) throw new BadRequestException(codedError('Novel connection is not configured', WebSerialErrorCode.EngineNotConfigured));
    try {
      if (config.engine === 'lnreader') {
        if (!this.novelSources) throw new InternalServerErrorException('The LNReader client is unavailable');
        const sources = await this.novelSources.listInstalled(config.connection);
        return sources
          .map((source) => ({
            domain: hostOf(source.site),
            language: source.lang,
            canSearch: true,
            disabled: !config.allowedSources.includes(source.id),
          }))
          .sort((a, b) => a.domain.localeCompare(b.domain));
      }
      const sources = await this.lncrawl.listSources(config.connection);
      return [...sources].sort((a, b) => a.domain.localeCompare(b.domain));
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${SOURCES_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - could not load novel sources`,
      );
      throw new BadGatewayException(codedError('Could not load the list of novel sources', WebSerialErrorCode.EngineError));
    }
  }

  async listMangaSources(): Promise<WebSerialMangaSource[]> {
    const startedAt = Date.now();
    const config = await this.getEngineConfig('manga');
    if (!config) throw new BadRequestException(codedError('Manga connection is not configured', WebSerialErrorCode.EngineNotConfigured));
    try {
      const sources = await this.suwayomi.listSources(config.connection);
      return [...sources].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.error(
        `[${MANGA_SOURCES_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - could not load manga sources`,
      );
      throw new BadGatewayException(codedError('Could not load the list of manga sources', WebSerialErrorCode.EngineError));
    }
  }

  private clientFor(kind: WebSerialKind, novelEngine?: WebSerialNovelEngine): WebSerialEngineClient {
    if (kind === 'manga') return this.suwayomi;
    if (novelEngine === 'lnreader') {
      if (!this.novelSources) throw new InternalServerErrorException('The LNReader client is unavailable');
      return this.novelSources;
    }
    return this.lncrawl;
  }

  private async finishFailure(
    kind: WebSerialKind,
    user: RequestUser,
    startedAt: number,
    draft: boolean,
    testedUrl: string | null,
    message: string,
  ): Promise<WebSerialEngineHealth> {
    const result = this.failureHealth(message);
    if (!draft) await this.repo.recordCheck(kind, result, testedUrl);
    this.logger.log(
      `[${TEST_EVENT}] [end] userId=${user.id} kind=${kind} durationMs=${Date.now() - startedAt} draft=${draft} ok=false - connection test completed`,
    );
    return result;
  }

  private failureHealth(error: string): WebSerialEngineHealth {
    return { ok: false, checkedAt: new Date().toISOString(), version: null, searchableSources: 0, error };
  }

  private async buildKindUpdate(
    kind: WebSerialKind,
    input: WebSerialEngineConnectionInput,
    targetLibraryId: number | null | undefined,
    targetFolderId: number | null | undefined,
    existing: WebSerialSettingsRow | undefined,
    user: RequestUser,
    novelEngine?: WebSerialNovelEngine,
  ): Promise<{
    url: string | null | undefined;
    username: string | null | undefined;
    passwordEnc: string | null | undefined;
    clearCheck: boolean;
    libraryId: number | null | undefined;
    folderId: number | null | undefined;
  }> {
    const stored = kindFields(existing, kind, novelEngine);

    let url: string | null | undefined;
    if (input.url !== undefined) {
      const trimmed = (input.url ?? '').trim();
      if (trimmed === '') {
        url = null;
      } else {
        url = parseAndNormalizeEngineUrl(trimmed);
        if (!url) throw new BadRequestException(codedError('The address must be a valid http or https URL', WebSerialErrorCode.EngineUrlInvalid));
        await ensureSafeEngineUrl(url);
      }
    }

    // The stored password belongs to the stored address and to no other.
    const hostChanged = url !== undefined && url !== stored.url;
    let passwordEnc: string | null | undefined;
    if (input.password !== undefined) {
      passwordEnc = input.password ? this.secretService.encrypt(input.password) : null;
    } else if (hostChanged) {
      passwordEnc = null;
    }

    const libraryId = targetLibraryId;
    let folderId: number | null | undefined = targetFolderId;
    if (targetFolderId === undefined && targetLibraryId !== undefined) folderId = null;
    const effectiveLibraryId = targetLibraryId !== undefined ? targetLibraryId : stored.libraryId;
    if (effectiveLibraryId === null) {
      if (targetFolderId != null)
        throw new BadRequestException(codedError('A target library is required before a target folder', WebSerialErrorCode.TargetFolderNeedsLibrary));
    } else if (targetLibraryId !== undefined || targetFolderId !== undefined) {
      await this.assertUsableTargetLibrary(kind, effectiveLibraryId, folderId === undefined ? stored.folderId : folderId, user);
    }

    return {
      url,
      username: input.username === undefined ? undefined : input.username?.trim() || null,
      passwordEnc,
      clearCheck: hostChanged,
      libraryId,
      folderId,
    };
  }

  private async assertUsableTargetLibrary(kind: WebSerialKind, libraryId: number, folderId: number | null, user: RequestUser): Promise<void> {
    await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    let library: { allowedFormats: string[] };
    try {
      library = await this.libraryService.findOne(libraryId);
    } catch (err) {
      if (err instanceof NotFoundException) throw new NotFoundException(codedError('Target library not found', WebSerialErrorCode.LibraryNotFound));
      throw err;
    }
    const format = LIBRARY_FORMAT[kind];
    if (library.allowedFormats.length > 0 && !library.allowedFormats.includes(format)) {
      throw new BadRequestException(codedError(`Target library does not allow ${format} files`, WebSerialErrorCode.LibraryFormatRefused, { format }));
    }
    if (folderId !== null) {
      const folders = await this.repo.findLibraryFolders(libraryId);
      if (!folders.some((folder) => folder.id === folderId)) {
        throw new BadRequestException(codedError('Target folder does not belong to the target library', WebSerialErrorCode.FolderNotInLibrary));
      }
    }
  }
}
