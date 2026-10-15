import { BadGatewayException, BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { WebSerialNovelSourceEntry } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { NovelSourcesClient, type NovelSourceEntry } from './engines/novel-sources.client';
import { describeError } from './web-serials-log.utils';
import { WebSerialsNovelIndexRepository } from './web-serials-novel-index.repository';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const EVENT = 'web_serials.novel_source';
type SourceAction = 'install' | 'update' | 'remove';

@Injectable()
export class WebSerialsNovelSourcesService {
  private readonly logger = new Logger(WebSerialsNovelSourcesService.name);

  constructor(
    private readonly settings: WebSerialsSettingsService,
    private readonly repo: WebSerialsRepository,
    private readonly indexRepo: WebSerialsNovelIndexRepository,
    private readonly client: NovelSourcesClient,
  ) {}

  async available(language: string): Promise<WebSerialNovelSourceEntry[]> {
    const config = await this.requireConnection();
    return this.client.listAvailable(config.connection, language).then((sources) => sources.map(mapSource));
  }

  async installed(): Promise<WebSerialNovelSourceEntry[]> {
    const config = await this.requireConnection();
    return this.client.listInstalled(config.connection).then((sources) => sources.map(mapSource));
  }

  async change(sourceId: string, action: SourceAction, user: RequestUser): Promise<void> {
    const config = await this.requireConnection();
    const startedAt = Date.now();
    this.logger.log(`[${EVENT}] [start] sourceId=${sourceId} userId=${user.id} action=${action} - novel source action started`);
    try {
      await this.client.updateSource(config.connection, sourceId, action);
      if (action === 'remove') {
        await this.repo.removeNovelSourceId(sourceId);
        await this.indexRepo.deleteNovelIndexSources([sourceId]);
      }
      if (action === 'install') await this.repo.addNovelSourceId(sourceId);
      this.settings.bumpCatalogVersion();
      await this.settings.refreshHealth('novel');
      this.logger.log(
        `[${EVENT}] [end] sourceId=${sourceId} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} - novel source action completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.error(
        `[${EVENT}] [fail] sourceId=${sourceId} userId=${user.id} action=${action} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - novel source action failed`,
      );
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(codedError('The novel sources service did not complete the change', WebSerialErrorCode.EngineError));
    }
  }

  private async requireConnection() {
    const config = await this.settings.getNovelEngineConfig('lnreader');
    if (!config) throw new BadRequestException(codedError('LNReader sources are not configured', WebSerialErrorCode.EngineNotConfigured));
    return config;
  }
}

function mapSource(source: NovelSourceEntry): WebSerialNovelSourceEntry {
  return {
    id: source.id,
    name: source.name,
    site: source.site,
    lang: source.lang,
    version: source.version,
    iconUrl: source.iconUrl ?? null,
    installed: source.installed,
    installedVersion: source.installedVersion ?? null,
    updateAvailable: source.updateAvailable ?? false,
    broken: source.broken === true,
  };
}
