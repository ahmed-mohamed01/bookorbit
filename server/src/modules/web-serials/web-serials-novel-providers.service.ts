import { Injectable, Logger } from '@nestjs/common';

import type { UpdateWebSerialNovelProvidersInput, WebSerialNovelLinkSite, WebSerialNovelProviders } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BoundedTtlCache } from './web-serials-cache.utils';
import { describeError } from './web-serials-log.utils';
import { WebSerialsSettingsService } from './web-serials-settings.service';
import { WebSerialsRepository } from './web-serials.repository';

const LINK_SITES_EVENT = 'web_serials.novel_link_sites';
const LINK_SITES_CACHE_TTL_MS = 10 * 60_000;

interface LinkSites {
  sites: WebSerialNovelLinkSite[];
  unavailable: boolean;
}

interface AdminSelection {
  keys: string[];
  sourceIds: boolean;
}

@Injectable()
export class WebSerialsNovelProvidersService {
  private readonly logger = new Logger(WebSerialsNovelProvidersService.name);
  private readonly linkSitesCache = new BoundedTtlCache<number, LinkSites>(1, LINK_SITES_CACHE_TTL_MS);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly settings: WebSerialsSettingsService,
  ) {}

  async getProviders(user: RequestUser): Promise<WebSerialNovelProviders> {
    const [selection, disabled, link] = await Promise.all([this.adminSelection(), this.repo.getDisabledNovelDomains(user.id), this.linkSites()]);
    return toProviders(selection.keys, new Set(disabled), link);
  }

  async updateProviders(user: RequestUser, input: UpdateWebSerialNovelProvidersInput): Promise<WebSerialNovelProviders> {
    const selection = await this.adminSelection();
    const allowed = new Set(selection.keys);
    const disabled = [...new Set(input.disabledDomains.map((key) => (selection.sourceIds ? key.trim() : key.trim().toLowerCase())))].filter((key) =>
      allowed.has(key),
    );
    await this.repo.setDisabledNovelDomains(user.id, disabled);
    return toProviders(selection.keys, new Set(disabled), await this.linkSites());
  }

  private async adminSelection(): Promise<AdminSelection> {
    const novel = (await this.settings.getSettings()).novel;
    const sourceIds = novel.engine === 'lnreader';
    return { keys: sourceIds ? novel.sourceIds : novel.searchDomains, sourceIds };
  }

  private async linkSites(): Promise<LinkSites> {
    const version = this.settings.catalogVersion;
    const cached = this.linkSitesCache.get(version);
    if (cached) return cached;
    const startedAt = Date.now();
    try {
      const sources = await this.settings.listNovelSources();
      const sites = sources.filter((source) => !source.disabled).map((source) => ({ domain: source.domain, name: source.domain }));
      const loaded = { sites, unavailable: false };
      this.linkSitesCache.set(version, loaded);
      return loaded;
    } catch (err) {
      const { errorClass, message } = describeError(err);
      this.logger.warn(
        `[${LINK_SITES_EVENT}] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - link site list unavailable`,
      );
      return { sites: [], unavailable: true };
    }
  }
}

function toProviders(adminDomains: string[], disabled: Set<string>, link: LinkSites): WebSerialNovelProviders {
  return {
    search: adminDomains.map((domain) => ({ domain, name: domain, enabled: !disabled.has(domain) })),
    linkSites: link.sites,
    linkSitesTotal: link.sites.length,
    unavailable: link.unavailable,
  };
}
