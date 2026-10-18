import { Injectable } from '@nestjs/common';
import type { WebSerialMangaExtensionQuery } from '@bookorbit/types';

import { fetchSuwayomiImage, suwayomiGraphql } from './suwayomi-graphql';
import type { EngineConnection } from './web-serial-engine';

const EXTENSION_REFRESH_TIMEOUT_MS = 60_000;
const EXTENSION_UPDATE_TIMEOUT_MS = 90_000;
const EXTENSION_LANGUAGE_PAGE_SIZE = 100;

export interface SuwayomiExtension {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW' | boolean | null;
  iconUrl: string | null;
  repo: string | null;
}

export interface SuwayomiExtensionPage {
  nodes: SuwayomiExtension[];
  totalCount: number;
}

type ExtensionAction = 'install' | 'uninstall' | 'update';

@Injectable()
export class SuwayomiExtensionsClient {
  async listExtensionRepos(conn: EngineConnection): Promise<string[]> {
    // addExtensionStore writes to extensionStores; settings.extensionRepos is the legacy list and stays empty.
    const data = await suwayomiGraphql<{ extensionStores: { nodes: Array<{ indexUrl: string }> } }>(
      conn,
      `query BookOrbitExtensionRepos { extensionStores { nodes { indexUrl } } }`,
    );
    return data.extensionStores.nodes.map((store) => store.indexUrl);
  }

  async addExtensionRepo(conn: EngineConnection, url: string): Promise<void> {
    await suwayomiGraphql(
      conn,
      `mutation BookOrbitAddExtensionRepo {
        addExtensionStore(input: { indexUrl: ${JSON.stringify(url)} }) { clientMutationId }
      }`,
    );
  }

  async removeExtensionRepo(conn: EngineConnection, url: string): Promise<void> {
    await suwayomiGraphql(
      conn,
      `mutation BookOrbitRemoveExtensionRepo {
        removeExtensionStore(input: { indexUrl: ${JSON.stringify(url)} }) { clientMutationId }
      }`,
    );
  }

  async refreshExtensions(conn: EngineConnection): Promise<number> {
    await suwayomiGraphql(
      conn,
      `mutation BookOrbitRefreshExtensions { fetchExtensions(input: {}) { clientMutationId } }`,
      undefined,
      EXTENSION_REFRESH_TIMEOUT_MS,
    );
    const data = await suwayomiGraphql<{ extensions: { totalCount: number } }>(
      conn,
      `query BookOrbitExtensionCount { extensions(first: 1, offset: 0) { totalCount } }`,
    );
    return data.extensions.totalCount;
  }

  async listExtensions(conn: EngineConnection, input: WebSerialMangaExtensionQuery): Promise<SuwayomiExtensionPage> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    if (input.installed !== undefined) {
      return this.queryExtensions(conn, input, input.installed, limit, offset);
    }

    const installed = await this.queryExtensions(conn, input, true, limit, offset);
    const availableOffset = Math.max(0, offset - installed.totalCount);
    const availableLimit = Math.max(1, limit - installed.nodes.length);
    const available = await this.queryExtensions(conn, input, false, availableLimit, availableOffset);
    return {
      nodes: [...installed.nodes, ...available.nodes].slice(0, limit),
      totalCount: installed.totalCount + available.totalCount,
    };
  }

  async listExtensionLanguages(conn: EngineConnection): Promise<string[]> {
    const languages = new Set<string>();
    let offset = 0;
    let total: number;
    do {
      const data = await suwayomiGraphql<{ extensions: { totalCount: number; nodes: Array<{ lang: string }> } }>(
        conn,
        `query BookOrbitExtensionLanguages {
          extensions(first: ${EXTENSION_LANGUAGE_PAGE_SIZE}, offset: ${offset}, order: [{ by: NAME }]) {
            totalCount
            nodes { lang }
          }
        }`,
      );
      total = data.extensions.totalCount;
      for (const extension of data.extensions.nodes) {
        const language = extension.lang.trim().toLowerCase();
        if (language) languages.add(language);
      }
      offset += data.extensions.nodes.length;
      if (data.extensions.nodes.length === 0) break;
    } while (offset < total);
    return [...languages].sort((left, right) => left.localeCompare(right));
  }

  async updateExtension(conn: EngineConnection, pkgName: string, action: ExtensionAction): Promise<SuwayomiExtension> {
    const patch = action === 'install' ? 'install: true' : action === 'uninstall' ? 'uninstall: true' : 'update: true';
    const data = await suwayomiGraphql<{ updateExtension: { extension: SuwayomiExtension } }>(
      conn,
      `mutation BookOrbitUpdateExtension {
        updateExtension(input: { id: ${JSON.stringify(pkgName)}, patch: { ${patch} } }) {
          extension { ${extensionFields()} }
        }
      }`,
      undefined,
      EXTENSION_UPDATE_TIMEOUT_MS,
    );
    return data.updateExtension.extension;
  }

  async listExtensionSourceIds(conn: EngineConnection, pkgName: string): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    let total: number;
    do {
      const data = await suwayomiGraphql<{
        sources: { totalCount: number; nodes: Array<{ id: string; extension: { pkgName: string } | null }> };
      }>(
        conn,
        `query BookOrbitExtensionSources {
          sources(first: ${EXTENSION_LANGUAGE_PAGE_SIZE}, offset: ${offset}) {
            totalCount
            nodes { id extension { pkgName } }
          }
        }`,
      );
      total = data.sources.totalCount;
      for (const source of data.sources.nodes) {
        if (source.extension?.pkgName === pkgName) ids.push(String(source.id));
      }
      offset += data.sources.nodes.length;
      if (data.sources.nodes.length === 0) break;
    } while (offset < total);
    return ids;
  }

  fetchExtensionIcon(conn: EngineConnection, pkgName: string): Promise<{ body: Buffer; contentType: string }> {
    return fetchSuwayomiImage(conn, `/api/v1/extension/icon/${pkgName}`);
  }

  private queryExtensions(
    conn: EngineConnection,
    input: WebSerialMangaExtensionQuery,
    installed: boolean,
    limit: number,
    offset: number,
  ): Promise<SuwayomiExtensionPage> {
    const condition = [`isInstalled: ${installed}`];
    if (input.lang) condition.push(`lang: ${JSON.stringify(input.lang)}`);
    // Suwayomi drops sibling fields next to a top-level `or`, so each condition is its own `and` entry.
    const filters: string[] = [];
    if (input.query?.trim()) filters.push(`{ name: { includesInsensitive: ${JSON.stringify(input.query.trim())} } }`);
    if (!installed && input.adult !== true) filters.push(`{ or: [{ contentWarning: { isNull: true } }, { contentWarning: { notEqualTo: NSFW } }] }`);
    const filter = filters.length > 0 ? `, filter: { and: [${filters.join(', ')}] }` : '';
    return suwayomiGraphql<{ extensions: SuwayomiExtensionPage }>(
      conn,
      `query BookOrbitExtensions {
        extensions(condition: { ${condition.join(', ')} }${filter}, first: ${limit}, offset: ${offset}, order: [{ by: NAME }]) {
          totalCount
          nodes { ${extensionFields()} }
        }
      }`,
    ).then((data) => data.extensions);
  }
}

function extensionFields(): string {
  return 'pkgName name lang versionName isInstalled hasUpdate contentWarning iconUrl repo';
}
