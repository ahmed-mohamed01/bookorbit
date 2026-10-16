import { BadRequestException, Injectable } from '@nestjs/common';
import { BOOK_REQUEST_MEDIA_KINDS } from '@bookorbit/types';
import type { BookRequestMediaKind, RequestSourceOption } from '@bookorbit/types';

import type { ResolvedIndexerConfig } from './indexers/indexer-adapter';
import { IndexerConfigService } from './indexers/indexer-config.service';
import { IndexerRegistry } from './indexers/indexer-registry';

const SOURCE_LIST_TTL_MS = 5_000;

@Injectable()
export class BookRequestSourcesService {
  private cachedList: { sources: RequestSourceOption[]; expiresAt: number } | undefined;
  private listInFlight: Promise<RequestSourceOption[]> | undefined;

  constructor(
    private readonly indexers: IndexerConfigService,
    private readonly registry: IndexerRegistry,
  ) {}

  async list(): Promise<RequestSourceOption[]> {
    const now = Date.now();
    if (this.cachedList && this.cachedList.expiresAt > now) return this.cachedList.sources;
    if (this.listInFlight) return this.listInFlight;

    // Bulk submissions reuse this short memo so each candidate does not resolve the same source configuration again.
    const load = this.loadList();
    this.listInFlight = load;
    try {
      const sources = await load;
      this.cachedList = { sources, expiresAt: Date.now() + SOURCE_LIST_TTL_MS };
      return sources;
    } finally {
      if (this.listInFlight === load) this.listInFlight = undefined;
    }
  }

  async assertRequestable(sourceIds: number[] | null | undefined, mediaKind: BookRequestMediaKind): Promise<void> {
    if (sourceIds == null) return;
    const sources = await this.list();
    const validIds = new Set(sources.filter((source) => source.mediaKinds.includes(mediaKind)).map((source) => source.id));
    if (sourceIds.some((id) => !validIds.has(id))) {
      throw new BadRequestException(`Choose sources that search for ${mediaKind}s`);
    }
  }

  /**
   * A missing adapter stays eligible so the search can report that configuration error. An
   * operator's explicit media exclusion still applies because it remains meaningful without the adapter.
   */
  carriesMedium(config: ResolvedIndexerConfig, mediaKind: BookRequestMediaKind): boolean {
    if (config.disabledMediaKinds.includes(mediaKind)) return false;
    const adapter = this.registry.find(config.adapterType);
    return !adapter || adapter.mediaKinds.includes(mediaKind);
  }

  private async loadList(): Promise<RequestSourceOption[]> {
    const configs = await this.indexers.resolveEnabledConfigs();
    return configs
      .map((config) => ({
        id: config.id,
        name: config.name,
        delivery: this.registry.delivery(config.adapterType),
        mediaKinds: BOOK_REQUEST_MEDIA_KINDS.filter((mediaKind) => this.carriesMedium(config, mediaKind)),
      }))
      .filter((source) => source.mediaKinds.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  }
}
