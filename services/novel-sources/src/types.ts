export type FilterDefinition = Record<string, unknown>;

export interface NovelItem {
  name: string;
  path: string;
  cover?: string;
  resolvedUrl?: string;
}

export interface ChapterItem {
  name: string;
  path: string;
  releaseTime?: string | null;
  chapterNumber?: number;
  page?: string;
  resolvedUrl?: string;
}

export interface SourceNovel extends NovelItem {
  author?: string;
  artist?: string;
  summary?: string;
  status?: string;
  genres?: string | string[];
  chapters?: ChapterItem[];
  totalPages?: number;
}

export interface SourcePage {
  chapters?: ChapterItem[];
}

export interface NovelPlugin {
  id: string;
  name: string;
  site: string;
  version: string;
  filters?: FilterDefinition;
  popularNovels(pageNo: number, options: { showLatestNovels: boolean; filters: unknown }): Promise<NovelItem[]>;
  searchNovels(term: string, pageNo: number): Promise<NovelItem[]>;
  parseNovel(path: string): Promise<SourceNovel>;
  parseChapter(path: string): Promise<string>;
  parsePage?(path: string, page: string): Promise<SourcePage>;
  resolveUrl?(path: string, isNovel?: boolean): string;
  dispose?(): Promise<void>;
}

export interface IndexEntry {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
  iconUrl: string;
}

export interface InstalledEntry {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  sha256: string;
  installedAt: string;
}

export type SiteErrorCode = "SITE_FAILED" | "CHALLENGE" | "TIMEOUT" | "PLUGIN_ERROR";

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: SiteErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServiceError";
  }
}

export { ChallengeError, FetchTimeoutError, SiteFetchError } from "./libs/errors.js";

export const sanitizeMessage = (value: unknown): string => {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/["\r\n\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
};

export const absoluteUrl = (plugin: NovelPlugin, path: string, isNovel: boolean): string => {
  const resolved = plugin.resolveUrl ? plugin.resolveUrl(path, isNovel) : path;
  return new URL(resolved, plugin.site).toString();
};
