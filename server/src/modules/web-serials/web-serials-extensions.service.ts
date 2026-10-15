import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { WebSerialMangaExtension, WebSerialMangaExtensionPage, WebSerialMangaExtensionQuery } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { SuwayomiExtensionsClient, type SuwayomiExtension } from './engines/suwayomi-extensions.client';
import type { EngineConnection } from './engines/web-serial-engine';
import { describeError } from './web-serials-log.utils';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const EXTENSION_EVENT = 'web_serials.extension';
const REPO_EVENT = 'web_serials.extension_repo';
const CATALOG_EVENT = 'web_serials.extension_catalog';
const LANGUAGE_CACHE_TTL_MS = 10 * 60_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const PACKAGE_PATTERN = /^[a-z0-9_.]{3,200}$/;

type ExtensionAction = 'install' | 'uninstall' | 'update';

export interface WebSerialExtensionIcon {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class WebSerialsExtensionsService {
  private readonly logger = new Logger(WebSerialsExtensionsService.name);
  private languageCache: { key: string; expiresAt: number; languages: string[] } | null = null;
  private languageLoad: { key: string; promise: Promise<string[]> } | null = null;

  constructor(
    private readonly settings: WebSerialsSettingsService,
    private readonly repo: WebSerialsRepository,
    private readonly suwayomi: SuwayomiExtensionsClient,
  ) {}

  async listExtensions(query: WebSerialMangaExtensionQuery, user: RequestUser): Promise<WebSerialMangaExtensionPage> {
    const connection = await this.requireConnection();
    const startedAt = Date.now();
    try {
      const [page, languages] = await Promise.all([
        this.suwayomi.listExtensions(connection, {
          ...query,
          adult: query.adult ?? false,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        }),
        this.extensionLanguages(connection),
      ]);
      return { items: page.nodes.map(mapExtension), total: page.totalCount, languages };
    } catch (error) {
      this.logCatalogFailure(error, user, startedAt);
      throw engineUnavailable();
    }
  }

  async refreshExtensions(user: RequestUser): Promise<{ total: number }> {
    const connection = await this.requireConnection();
    const startedAt = Date.now();
    try {
      const total = await this.suwayomi.refreshExtensions(connection);
      this.clearLanguageCache();
      this.settings.bumpCatalogVersion();
      return { total };
    } catch (error) {
      this.logCatalogFailure(error, user, startedAt);
      throw engineUnavailable();
    }
  }

  async updateExtension(pkgName: string, action: ExtensionAction, user: RequestUser): Promise<WebSerialMangaExtension> {
    assertPackageName(pkgName);
    const connection = await this.requireConnection();
    const startedAt = Date.now();
    this.logger.log(`[${EXTENSION_EVENT}] [start] pkg=${pkgName} userId=${user.id} action=${action} - extension action started`);
    try {
      const removedSourceIds = action === 'uninstall' ? await this.suwayomi.listExtensionSourceIds(connection, pkgName) : [];
      const extension = await this.suwayomi.updateExtension(connection, pkgName, action);
      if (action === 'uninstall') await this.removeSelectedSources(removedSourceIds);
      this.settings.bumpCatalogVersion();
      await this.settings.refreshHealth('manga');
      this.logger.log(
        `[${EXTENSION_EVENT}] [end] pkg=${pkgName} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} installed=${extension.isInstalled} - extension action completed`,
      );
      return mapExtension(extension);
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${EXTENSION_EVENT}] [fail] pkg=${pkgName} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - extension action failed`,
      );
      throw engineUnavailable();
    }
  }

  async getExtensionIcon(pkgName: string, user: RequestUser): Promise<WebSerialExtensionIcon> {
    assertPackageName(pkgName);
    const connection = await this.requireConnection();
    const startedAt = Date.now();
    try {
      const icon = await this.suwayomi.fetchExtensionIcon(connection, pkgName);
      const contentType = icon.contentType.split(';', 1)[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.has(contentType)) throw new BadGatewayException('The extension icon is not a supported image');
      return { body: icon.body, contentType };
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${EXTENSION_EVENT}] [fail] pkg=${pkgName} userId=${user.id} action=icon durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - extension icon fetch failed`,
      );
      throw engineUnavailable();
    }
  }

  async listRepos(user: RequestUser): Promise<string[]> {
    return this.runRepoAction('list', null, user, async (connection) => this.suwayomi.listExtensionRepos(connection));
  }

  async addRepo(rawUrl: string, user: RequestUser): Promise<void> {
    const url = extensionRepoUrl(rawUrl);
    await this.runRepoAction('add', url, user, async (connection) => {
      await this.suwayomi.addExtensionRepo(connection, url);
      await this.suwayomi.refreshExtensions(connection);
      this.clearLanguageCache();
      this.settings.bumpCatalogVersion();
    });
  }

  async removeRepo(rawUrl: string, user: RequestUser): Promise<void> {
    const url = extensionRepoUrl(rawUrl);
    await this.runRepoAction('remove', url, user, async (connection) => {
      await this.suwayomi.removeExtensionRepo(connection, url);
      this.clearLanguageCache();
      this.settings.bumpCatalogVersion();
    });
  }

  private async requireConnection(): Promise<EngineConnection> {
    const config = await this.settings.getEngineConfig('manga');
    if (!config) throw new BadRequestException(codedError('Manga connection is not configured', WebSerialErrorCode.EngineNotConfigured));
    return config.connection;
  }

  private async extensionLanguages(connection: EngineConnection): Promise<string[]> {
    const key = `${connection.url}\0${connection.username ?? ''}`;
    if (this.languageCache?.key === key && this.languageCache.expiresAt > Date.now()) return this.languageCache.languages;
    if (this.languageLoad?.key === key) return this.languageLoad.promise;
    const promise = this.suwayomi.listExtensionLanguages(connection).then((languages) => {
      this.languageCache = { key, expiresAt: Date.now() + LANGUAGE_CACHE_TTL_MS, languages };
      return languages;
    });
    this.languageLoad = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.languageLoad?.promise === promise) this.languageLoad = null;
    }
  }

  private clearLanguageCache(): void {
    this.languageCache = null;
  }

  private async removeSelectedSources(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    const settings = await this.repo.getSettings();
    if (!settings?.mangaSourceIds) return;
    const removed = new Set(sourceIds);
    const retained = settings.mangaSourceIds.filter((sourceId) => !removed.has(sourceId));
    if (retained.length !== settings.mangaSourceIds.length) await this.repo.upsertSettings({ mangaSourceIds: retained });
  }

  private async runRepoAction<T>(
    action: 'list' | 'add' | 'remove',
    url: string | null,
    user: RequestUser,
    operation: (connection: EngineConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.requireConnection();
    const startedAt = Date.now();
    const urlField = url === null ? '' : ` url="${sanitizeLogValue(url)}"`;
    this.logger.log(`[${REPO_EVENT}] [start] userId=${user.id} action=${action}${urlField} - extension repository action started`);
    try {
      const result = await operation(connection);
      this.logger.log(
        `[${REPO_EVENT}] [end] userId=${user.id} action=${action}${urlField} durationMs=${Date.now() - startedAt} - extension repository action completed`,
      );
      return result;
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${REPO_EVENT}] [fail] userId=${user.id} action=${action}${urlField} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - extension repository action failed`,
      );
      throw engineUnavailable();
    }
  }

  private logCatalogFailure(error: unknown, user: RequestUser, startedAt: number): void {
    const { errorClass, message } = describeError(error);
    this.logger.error(
      `[${CATALOG_EVENT}] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - extension catalogue request failed`,
    );
  }
}

function mapExtension(extension: SuwayomiExtension): WebSerialMangaExtension {
  return {
    pkgName: extension.pkgName,
    name: extension.name,
    lang: extension.lang,
    versionName: extension.versionName,
    installed: extension.isInstalled,
    hasUpdate: extension.hasUpdate,
    adult: extension.contentWarning === true || extension.contentWarning === 'NSFW',
    iconUrl:
      extension.iconUrl && PACKAGE_PATTERN.test(extension.pkgName)
        ? `/api/v1/web-serials/admin/manga-extensions/${encodeURIComponent(extension.pkgName)}/icon`
        : null,
    repo: extension.repo,
  };
}

function assertPackageName(pkgName: string): void {
  if (!PACKAGE_PATTERN.test(pkgName)) throw new BadRequestException('The extension package name is invalid');
}

function extensionRepoUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (url.length === 0 || url.length > 2048)
    throw new BadRequestException(codedError('The extension repository URL is invalid', WebSerialErrorCode.ExtensionRepoInvalid));
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid protocol');
    return url;
  } catch {
    throw new BadRequestException(codedError('The extension repository URL is invalid', WebSerialErrorCode.ExtensionRepoInvalid));
  }
}

function engineUnavailable(): BadGatewayException {
  return new BadGatewayException(codedError('The manga engine did not answer.', WebSerialErrorCode.EngineError));
}
