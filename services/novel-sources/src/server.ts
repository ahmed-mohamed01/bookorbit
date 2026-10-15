import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { load } from "cheerio";
import { runWithDeadline, runWithPriority, runWithSignal, type Priority } from "./fetcher.js";
import { NovelLoads } from "./novel-loads.js";
import type { SourceStore } from "./store.js";
import {
  ChallengeError,
  FetchTimeoutError,
  ServiceError,
  SiteFetchError,
  absoluteUrl,
  sanitizeMessage,
  type NovelItem,
  type ChapterItem,
  type NovelPlugin,
  type SourceNovel,
} from "./types.js";

export const NOVEL_TIMEOUT_MS = 60_000;
export const NOVEL_PAGE_TIMEOUT_MS = 3_000;
// Sized so a 600-page chapter list finishes at the default 1.5 s request spacing: 60 s + 600 x 3 s = 31 min.
export const NOVEL_MAX_PAGES = 600;
export const NOVEL_MAX_TIMEOUT_MS = NOVEL_TIMEOUT_MS + NOVEL_PAGE_TIMEOUT_MS * NOVEL_MAX_PAGES;

export interface ServerOptions {
  token: string;
  store: SourceStore;
  browseTimeoutMs?: number;
  novelTimeoutMs?: number;
  novelPageTimeoutMs?: number;
  novelMaxTimeoutMs?: number;
  chapterTimeoutMs?: number;
  novelWaitMs?: number;
  novelCacheTtlMs?: number;
  novelFailureTtlMs?: number;
  novelCacheEntries?: number;
  pendingRetryAfterMs?: number;
  solver?: boolean;
  logger?: Pick<Console, "log" | "error">;
}

interface OperationContext {
  name: string;
  source: string;
  startedAt: number;
  items?: number;
  outcome?: string;
}

export const NOVEL_WAIT_MS = 45_000;
export const NOVEL_CACHE_TTL_MS = 30 * 60_000;
export const NOVEL_FAILURE_TTL_MS = 60_000;
export const NOVEL_CACHE_ENTRIES = 50;
export const PENDING_RETRY_AFTER_MS = 5_000;

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const safeTokenMatch = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

const positivePage = (value: string | null): number => {
  if (value === null) return 1;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) throw new ServiceError("page must be a positive integer", 400);
  return page;
};

const requestPriority = (value: string | null, fallback: Priority): Priority => {
  if (value === null) return fallback;
  if (value !== "interactive" && value !== "bulk") throw new ServiceError("priority must be interactive or bulk", 400);
  return value;
};

const parseFilters = (value: string | null): unknown => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ServiceError("filters must be a JSON object", 400);
  }
};

const normalizeItems = (plugin: NovelPlugin, items: NovelItem[]) =>
  items.map((item) => ({
    name: item.name,
    path: item.path,
    url: item.resolvedUrl ?? absoluteUrl(plugin, item.path, true),
    cover: item.cover ?? null,
  }));

const normalizeSummary = (summary = ""): { summary: string; summaryHtml: string } => {
  if (!/<[a-z][\s\S]*>/i.test(summary)) {
    const summaryHtml = summary
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${load("<span></span>")("span").text(paragraph).html() ?? ""}</p>`)
      .join("");
    return { summary, summaryHtml };
  }
  const parsed = load(`<div id="summary-root">${summary}</div>`);
  parsed("br").replaceWith("\n");
  parsed("p, div, li").after("\n\n");
  const plain = parsed("#summary-root")
    .text()
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { summary: plain, summaryHtml: summary };
};

const normalizeNovel = (plugin: NovelPlugin, requestedPath: string, novel: SourceNovel) => {
  const path = novel.path || requestedPath;
  const genres = Array.isArray(novel.genres)
    ? novel.genres
    : (novel.genres ?? "")
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean);
  return {
    name: novel.name,
    path,
    url: novel.resolvedUrl ?? absoluteUrl(plugin, path, true),
    cover: novel.cover ?? null,
    author: novel.author ?? null,
    artist: novel.artist ?? null,
    ...normalizeSummary(novel.summary),
    status: novel.status ?? null,
    genres,
    chapters: (novel.chapters ?? []).map((chapter) => ({
      name: chapter.name,
      path: chapter.path,
      url: chapter.resolvedUrl ?? absoluteUrl(plugin, chapter.path, false),
      releaseTime: chapter.releaseTime ?? null,
      chapterNumber: chapter.chapterNumber ?? null,
      page: chapter.page ?? null,
    })),
  };
};

export interface NovelDeadlines {
  baseMs: number;
  perPageMs: number;
  maxMs: number;
}

export const DEFAULT_NOVEL_DEADLINES: NovelDeadlines = {
  baseMs: NOVEL_TIMEOUT_MS,
  perPageMs: NOVEL_PAGE_TIMEOUT_MS,
  maxMs: NOVEL_MAX_TIMEOUT_MS,
};

export const novelBudgetMs = (deadlines: NovelDeadlines, totalPages: number): number =>
  Math.min(deadlines.baseMs + deadlines.perPageMs * totalPages, deadlines.maxMs);

// LNReader sources with paged chapter lists return page 1 (or no chapters) plus totalPages, and expect the host to
// call parsePage for the rest. The budget grows with the page count because every page waits for the source's spacing.
const loadNovel = async (plugin: NovelPlugin, path: string, deadlines: NovelDeadlines): Promise<SourceNovel> => {
  const startedAt = Date.now();
  const novel = await withTimeout(
    runWithDeadline(deadlines.baseMs, () => plugin.parseNovel(path)),
    deadlines.baseMs,
  );
  const totalPages = Number(novel?.totalPages);
  if (!plugin.parsePage || !Number.isInteger(totalPages) || totalPages < 2) return novel;
  const budgetMs = novelBudgetMs(deadlines, totalPages);
  const chapters: ChapterItem[] = [...(novel.chapters ?? [])];
  const firstPage = chapters.length > 0 ? 2 : 1;
  for (let page = firstPage; page <= totalPages; page += 1) {
    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new FetchTimeoutError("Chapter list pages timed out");
    const result = await withTimeout(
      runWithDeadline(remainingMs, () => plugin.parsePage!(path, String(page))),
      remainingMs,
    );
    if (!Array.isArray(result?.chapters)) throw new Error("Plugin returned an invalid chapter page");
    chapters.push(...result.chapters);
  }
  return { ...novel, chapters: uniqueByPath(chapters) };
};

// A chapter published while a newest-first list is being paged shifts the pages, so one chapter can appear twice.
const uniqueByPath = (chapters: ChapterItem[]): ChapterItem[] => {
  const seen = new Set<string>();
  return chapters.filter((chapter) => {
    if (seen.has(chapter.path)) return false;
    seen.add(chapter.path);
    return true;
  });
};

interface UrlHost {
  host: string;
  port: string;
}

const hostOf = (value: string, base?: string): UrlHost | undefined => {
  try {
    const url = new URL(value, base);
    // "example.com." names the same host as "example.com"; without this the suffix checks miss "localhost." and "nas.local.".
    const host = url.hostname
      .toLowerCase()
      .replace(/\.$/u, "")
      .replace(/^www\./u, "");
    return { host, port: url.port };
  } catch {
    return undefined;
  }
};

const sameSite = (target: UrlHost, site: UrlHost): boolean =>
  target.port === site.port && (target.host === site.host || target.host.endsWith(`.${site.host}`));

const NON_PUBLIC_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

// Hosts learned from a plugin's results can be chosen by the site, so only public DNS names are trusted: an IP literal,
// a single-label name or a local suffix could point the service at its own network or a cloud metadata endpoint.
const isPublicDnsName = (host: string): boolean => {
  if (host.startsWith("[") || /^[\d.]+$/u.test(host) || !host.includes(".")) return false;
  return !NON_PUBLIC_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
};

const MAX_KNOWN_HOSTS = 1_000;

// Plugins resolve paths with new URL(path, site) or plain concatenation. A path that, either way, points at a host
// other than the source's site (or a public host the plugin itself returned) would make the service fetch an address
// the caller chose, so it is refused.
class PathGuard {
  private readonly hosts = new Map<string, Set<string>>();

  remember(plugin: NovelPlugin, paths: string[]): void {
    const site = hostOf(plugin.site);
    let known = this.hosts.get(plugin.id);
    for (const path of paths) {
      if (!/^([a-z][a-z\d+.-]*:)?\/\//iu.test(path)) continue;
      const target = hostOf(path);
      if (!target || (site && sameSite(target, site)) || !isPublicDnsName(target.host)) continue;
      known ??= new Set();
      if (known.size < MAX_KNOWN_HOSTS) known.add(`${target.host}:${target.port}`);
    }
    if (known) this.hosts.set(plugin.id, known);
  }

  forget(pluginId: string): void {
    this.hosts.delete(pluginId);
  }

  assert(plugin: NovelPlugin, path: string): void {
    const site = hostOf(plugin.site);
    if (!site) return;
    const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(path)?.[1]?.toLowerCase();
    const known = this.hosts.get(plugin.id);
    const allowed = (target: UrlHost | undefined) =>
      target === undefined || sameSite(target, site) || known?.has(`${target.host}:${target.port}`) === true;
    const schemeAllowed = !scheme || scheme === "http" || scheme === "https";
    if (!schemeAllowed || !allowed(hostOf(path, plugin.site)) || !allowed(hostOf(`${plugin.site}${path}`))) {
      throw new ServiceError("path must point to the source's own site", 400);
    }
  }
}

const withTimeout = async <T>(operation: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchTimeoutError("Plugin call timed out")), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const createNovelSourcesServer = (options: ServerOptions) => {
  const logger = options.logger ?? console;
  const browseTimeout = options.browseTimeoutMs ?? 30_000;
  const novelDeadlines: NovelDeadlines = {
    baseMs: options.novelTimeoutMs ?? DEFAULT_NOVEL_DEADLINES.baseMs,
    perPageMs: options.novelPageTimeoutMs ?? DEFAULT_NOVEL_DEADLINES.perPageMs,
    maxMs: options.novelMaxTimeoutMs ?? DEFAULT_NOVEL_DEADLINES.maxMs,
  };
  const chapterTimeout = options.chapterTimeoutMs ?? 30_000;
  const novelWaitMs = options.novelWaitMs ?? NOVEL_WAIT_MS;
  const retryAfterMs = options.pendingRetryAfterMs ?? PENDING_RETRY_AFTER_MS;
  const novelLoads = new NovelLoads<ReturnType<typeof normalizeNovel>>({
    cacheTtlMs: options.novelCacheTtlMs ?? NOVEL_CACHE_TTL_MS,
    failureTtlMs: options.novelFailureTtlMs ?? NOVEL_FAILURE_TTL_MS,
    maxEntries: options.novelCacheEntries ?? NOVEL_CACHE_ENTRIES,
    mapError,
  });
  const paths = new PathGuard();

  return createServer((request, response) => {
    const disconnect = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) disconnect.abort();
    });
    void runWithSignal(disconnect.signal, () => handle(request, response));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/api\/v1\/sources\/([^/]+)(?:\/(.+))?$/);
    const context: OperationContext = {
      name: sanitizeLogToken(routeName(request.method, url.pathname, match?.[2])),
      source: match ? sanitizeLogToken(match[1]!) : "-",
      startedAt: Date.now(),
    };
    try {
      if (url.pathname === "/api/v1/health" && request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          version: process.env.npm_package_version ?? "0.1.0",
          installed: options.store.loadedCount,
          broken: options.store.brokenCount,
          solver: options.solver ?? false,
        });
        logEnd(logger, context);
        return;
      }
      if (!safeTokenMatch(request.headers.authorization ?? "", options.token)) {
        throw new ServiceError("Unauthorized", 401);
      }
      if (url.pathname === "/api/v1/sources/available" && request.method === "GET") {
        const entries = await options.store.listAvailable(url.searchParams.get("lang") ?? undefined);
        context.items = entries.length;
        sendJson(response, 200, entries);
        logEnd(logger, context);
        return;
      }
      if (url.pathname === "/api/v1/sources" && request.method === "GET") {
        const entries = options.store.listInstalled().map(({ sha256, installedAt, ...entry }) => entry);
        context.items = entries.length;
        sendJson(response, 200, entries);
        logEnd(logger, context);
        return;
      }
      if (!match) throw new ServiceError("Route not found", 404);
      const id = decodePathSegment(match[1]!);
      const action = match[2];
      if (!action && request.method === "DELETE") {
        await options.store.remove(id);
        paths.forget(id);
        response.writeHead(204).end();
        logEnd(logger, context);
        return;
      }
      if (action === "install" && request.method === "POST") {
        sendJson(response, 201, await options.store.install(id));
        logEnd(logger, context);
        return;
      }
      if (action === "update" && request.method === "POST") {
        sendJson(response, 200, await options.store.update(id));
        logEnd(logger, context);
        return;
      }
      const plugin = await requirePlugin(options.store, id);
      if (action === "browse" && request.method === "GET") {
        const page = positivePage(url.searchParams.get("page"));
        const latestValue = url.searchParams.get("latest") ?? "0";
        if (latestValue !== "0" && latestValue !== "1") {
          throw new ServiceError("latest must be 0 or 1", 400);
        }
        const suppliedFilters = parseFilters(url.searchParams.get("filters"));
        const priority = requestPriority(url.searchParams.get("priority"), "bulk");
        const items = await withTimeout(
          runWithPriority(priority, () =>
            runWithDeadline(browseTimeout, () =>
              plugin.popularNovels(page, {
                showLatestNovels: latestValue === "1",
                filters: suppliedFilters ?? plugin.filters,
              }),
            ),
          ),
          browseTimeout,
        );
        if (!Array.isArray(items)) throw new Error("Plugin returned invalid browse results");
        paths.remember(
          plugin,
          items.map((item) => item.path),
        );
        context.items = items.length;
        sendJson(response, 200, {
          items: normalizeItems(plugin, items),
          page,
          hasMore: items.length > 0,
        });
        logEnd(logger, context);
        return;
      }
      if (action === "search" && request.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query?.trim()) throw new ServiceError("q is required", 400);
        const page = positivePage(url.searchParams.get("page"));
        const priority = requestPriority(url.searchParams.get("priority"), "interactive");
        const items = await withTimeout(
          runWithPriority(priority, () => runWithDeadline(browseTimeout, () => plugin.searchNovels(query, page))),
          browseTimeout,
        );
        if (!Array.isArray(items)) throw new Error("Plugin returned invalid search results");
        paths.remember(
          plugin,
          items.map((item) => item.path),
        );
        context.items = items.length;
        sendJson(response, 200, {
          items: normalizeItems(plugin, items),
          page,
          hasMore: items.length > 0,
        });
        logEnd(logger, context);
        return;
      }
      if (action === "novel" && request.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) throw new ServiceError("path is required", 400);
        paths.assert(plugin, path);
        const priority = requestPriority(url.searchParams.get("priority"), "interactive");
        const source = context.source;
        const result = await novelLoads.get(
          `${id}\n${path}`,
          priority,
          novelWaitMs,
          async () => {
            const normalized = normalizeNovel(plugin, path, await loadNovel(plugin, path, novelDeadlines));
            paths.remember(plugin, [normalized.path, ...normalized.chapters.map((chapter) => chapter.path)]);
            return normalized;
          },
          (outcome, durationMs) => logBackgroundNovel(logger, source, durationMs, outcome),
        );
        if (result.status === "pending") {
          context.outcome = "pending";
          sendJson(response, 202, { pending: true, retryAfterMs });
          logEnd(logger, context);
          return;
        }
        context.items = result.value.chapters.length;
        sendJson(response, 200, result.value);
        logEnd(logger, context);
        return;
      }
      if (action === "chapter" && request.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) throw new ServiceError("path is required", 400);
        paths.assert(plugin, path);
        const priority = requestPriority(url.searchParams.get("priority"), "bulk");
        const html = await withTimeout(
          runWithPriority(priority, () => runWithDeadline(chapterTimeout, () => plugin.parseChapter(path))),
          chapterTimeout,
        );
        if (typeof html !== "string") throw new Error("Plugin returned invalid chapter content");
        sendJson(response, 200, { html });
        logEnd(logger, context);
        return;
      }
      throw new ServiceError("Route not found", 404);
    } catch (error) {
      const mapped = mapError(error);
      if (!response.destroyed) {
        sendJson(response, mapped.status, {
          error: sanitizeMessage(mapped),
          ...(mapped.code ? { code: mapped.code } : {}),
        });
      }
      logFail(logger, context, mapped);
    }
  }
};

const requirePlugin = async (store: SourceStore, id: string): Promise<NovelPlugin> => {
  const plugin = store.getPlugin(id);
  if (plugin) return plugin;
  if (store.isBroken(id)) throw new ServiceError("Source failed to load; reinstall or remove it", 409, "PLUGIN_ERROR");
  const known = (await store.getIndex()).some((entry) => entry.id === id);
  throw new ServiceError(known ? "Source is not installed" : "Unknown source", known ? 409 : 404);
};

const mapError = (error: unknown): ServiceError => {
  if (error instanceof ServiceError) return error;
  if (error instanceof FetchTimeoutError || (error instanceof Error && error.name === "AbortError")) {
    return new ServiceError(sanitizeMessage(error), 504, "TIMEOUT", { cause: error });
  }
  if (error instanceof ChallengeError) {
    return new ServiceError(sanitizeMessage(error), 502, "CHALLENGE", { cause: error });
  }
  if (error instanceof SiteFetchError) {
    return new ServiceError(sanitizeMessage(error), 502, "SITE_FAILED", {
      cause: error,
    });
  }
  return new ServiceError(sanitizeMessage(error), 502, "PLUGIN_ERROR", { cause: error });
};

const routeName = (method: string | undefined, path: string, action?: string): string => {
  if (path.endsWith("/health")) return "health";
  if (path.endsWith("/available")) return "available";
  if (path.endsWith("/sources")) return "sources";
  if (action) return action;
  return method === "DELETE" ? "remove" : "request";
};

const logEnd = (logger: Pick<Console, "log">, context: OperationContext): void => {
  const outcome = context.outcome ? ` outcome=${context.outcome}` : "";
  logger.log(
    `[novel_sources.${context.name}] [end] source=${context.source} durationMs=${Date.now() - context.startedAt} items=${context.items ?? 0}${outcome} - request completed`,
  );
};

const logBackgroundNovel = (
  logger: Pick<Console, "log" | "error">,
  source: string,
  durationMs: number,
  outcome: { ok: true; value: { chapters: unknown[] } } | { ok: false; error: Error },
): void => {
  if (outcome.ok) {
    logger.log(
      `[novel_sources.novel_background] [end] source=${source} durationMs=${durationMs} items=${outcome.value.chapters.length} - background chapter list load completed`,
    );
    return;
  }
  const errorClass = outcome.error.cause instanceof Error ? outcome.error.cause.name : outcome.error.name;
  logger.error(
    `[novel_sources.novel_background] [fail] source=${source} durationMs=${durationMs} errorClass=${errorClass} error="${sanitizeMessage(outcome.error)}" - background chapter list load failed`,
  );
};

const logFail = (logger: Pick<Console, "error">, context: OperationContext, error: Error): void => {
  const errorClass = error.cause instanceof Error ? error.cause.name : error.name;
  logger.error(
    `[novel_sources.${context.name}] [fail] source=${context.source} durationMs=${Date.now() - context.startedAt} errorClass=${errorClass} error="${sanitizeMessage(error)}" - request failed`,
  );
};

const sanitizeLogToken = (value: string): string => value.replace(/[^\w.-]/gu, "_").slice(0, 100);

const decodePathSegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ServiceError("Source id is invalid", 400);
  }
};
