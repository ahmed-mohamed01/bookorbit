import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { currentPriority, currentSignal } from "../src/fetcher.js";
import { DEFAULT_NOVEL_DEADLINES, createNovelSourcesServer, novelBudgetMs, type ServerOptions } from "../src/server.js";
import type { SourceStore } from "../src/store.js";
import { SiteFetchError, type NovelPlugin } from "../src/types.js";

const plugin: NovelPlugin = {
  id: "stub",
  name: "Stub",
  site: "https://stub.test/base/",
  version: "1.0.0",
  filters: { sort: { type: "Picker", value: "popular" } },
  popularNovels: vi.fn(async () => [{ name: "One", path: "novel/one", cover: "https://images.test/one.jpg" }]),
  searchNovels: vi.fn(async () => [{ name: "Two", path: "/novel/two" }]),
  parseNovel: vi.fn(async (path) => ({
    name: "One",
    path,
    author: "Author",
    summary: "<p>Hello <strong>world</strong></p>",
    genres: "Fantasy, Adventure",
    chapters: [{ name: "Chapter 1", path: "/chapter/1", chapterNumber: 1, releaseTime: "2026-01-01" }],
  })),
  parseChapter: vi.fn(async () => "<p>Chapter</p>"),
};

const store = {
  installedCount: 2,
  loadedCount: 1,
  brokenCount: 1,
  listAvailable: vi.fn(async () => []),
  listInstalled: vi.fn(() => [
    {
      id: "stub",
      name: "Stub",
      site: plugin.site,
      lang: "English",
      version: "1.0.0",
      sha256: "hash",
      installedAt: "2026-01-01T00:00:00.000Z",
      filters: plugin.filters,
    },
  ]),
  getPlugin: vi.fn((id: string) => (id === "stub" ? plugin : undefined)),
  isBroken: vi.fn((id: string) => id === "broken"),
  getIndex: vi.fn(async () => [
    {
      id: "known",
      name: "Known",
      site: "https://known.test",
      lang: "English",
      version: "1.0.0",
      url: "https://plugins.test/known.js",
      iconUrl: "https://plugins.test/known.png",
    },
  ]),
  install: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
} as unknown as SourceStore;

interface TestResponse {
  status: number;
  headers: Record<string, string | number | string[]>;
  body: string;
}

type ServerOverrides = Partial<
  Pick<
    ServerOptions,
    | "browseTimeoutMs"
    | "novelTimeoutMs"
    | "novelPageTimeoutMs"
    | "novelMaxTimeoutMs"
    | "chapterTimeoutMs"
    | "novelWaitMs"
    | "novelFailureTtlMs"
    | "novelCacheEntries"
    | "store"
    | "logger"
  >
>;

const makeServer = (overrides: ServerOverrides = {}) =>
  createNovelSourcesServer({
    token: "test-token",
    store,
    logger: { log: vi.fn(), error: vi.fn() },
    ...overrides,
  });

const send = (server: ReturnType<typeof makeServer>, method: string, url: string, authorization?: string): Promise<TestResponse> =>
  new Promise((resolve) => {
    const result: TestResponse = { status: 200, headers: {}, body: "" };
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
      writeHead(status: number, headers?: Record<string, string | number | string[]>) {
        result.status = status;
        result.headers = headers ?? {};
        return this;
      },
      end(body?: string) {
        result.body = body ?? "";
        resolve(result);
        return this;
      },
    }) as unknown as ServerResponse;
    server.emit("request", { method, url, headers: { ...(authorization ? { authorization } : {}) } } as IncomingMessage, response);
  });

const request = async (method: string, url: string, authorization?: string, overrides: ServerOverrides = {}): Promise<TestResponse> =>
  send(makeServer(overrides), method, url, authorization);

describe("HTTP server", () => {
  it("allows health without auth and protects all other routes", async () => {
    const health = await request("GET", "/api/v1/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, installed: 1, broken: 1, solver: false });
    expect((await request("GET", "/api/v1/sources")).status).toBe(401);
  });

  it("returns installed sources without internal checksum fields", async () => {
    const response = await request("GET", "/api/v1/sources", "Bearer test-token");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        id: "stub",
        name: "Stub",
        site: plugin.site,
        lang: "English",
        version: "1.0.0",
        filters: plugin.filters,
      },
    ]);
  });

  it("normalizes browse and novel response shapes with absolute urls", async () => {
    const browse = await request("GET", "/api/v1/sources/stub/browse?page=2&latest=0", "Bearer test-token");
    expect(JSON.parse(browse.body)).toEqual({
      items: [
        {
          name: "One",
          path: "novel/one",
          url: "https://stub.test/base/novel/one",
          cover: "https://images.test/one.jpg",
        },
      ],
      page: 2,
      hasMore: true,
    });
    const novel = await request("GET", "/api/v1/sources/stub/novel?path=%2Fnovel%2Fone", "Bearer test-token");
    expect(JSON.parse(novel.body)).toMatchObject({
      name: "One",
      path: "/novel/one",
      url: "https://stub.test/novel/one",
      summary: "Hello world",
      summaryHtml: "<p>Hello <strong>world</strong></p>",
      genres: ["Fantasy", "Adventure"],
      chapters: [
        {
          name: "Chapter 1",
          path: "/chapter/1",
          url: "https://stub.test/chapter/1",
          chapterNumber: 1,
        },
      ],
    });
  });

  it("validates input and distinguishes unknown from uninstalled sources", async () => {
    expect((await request("GET", "/api/v1/sources/stub/search?page=1", "Bearer test-token")).status).toBe(400);
    expect((await request("GET", "/api/v1/sources/known/search?q=x", "Bearer test-token")).status).toBe(409);
    expect((await request("GET", "/api/v1/sources/missing/search?q=x", "Bearer test-token")).status).toBe(404);
  });

  it("returns chapter html", async () => {
    const response = await request("GET", "/api/v1/sources/stub/chapter?path=%2Fchapter%2F1", "Bearer test-token");
    expect(JSON.parse(response.body)).toEqual({ html: "<p>Chapter</p>" });
  });

  it("maps plugin failures and call timeouts", async () => {
    vi.mocked(plugin.searchNovels).mockRejectedValueOnce(new Error("broken plugin"));
    const failed = await request("GET", "/api/v1/sources/stub/search?q=x", "Bearer test-token");
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({
      error: "broken plugin",
      code: "PLUGIN_ERROR",
    });

    vi.mocked(plugin.popularNovels).mockImplementationOnce(() => new Promise(() => undefined));
    const timedOut = await request("GET", "/api/v1/sources/stub/browse", "Bearer test-token", {
      browseTimeoutMs: 5,
    });
    expect(timedOut.status).toBe(504);
    expect(JSON.parse(timedOut.body).code).toBe("TIMEOUT");
  });

  it("uses the documented management status codes", async () => {
    const installed = {
      id: "stub",
      name: "Stub",
      site: plugin.site,
      lang: "English",
      version: "1.0.0",
      sha256: "hash",
      installedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.mocked(store.install).mockResolvedValueOnce(installed);
    vi.mocked(store.update).mockResolvedValueOnce(installed);
    vi.mocked(store.remove).mockResolvedValueOnce();
    expect((await request("POST", "/api/v1/sources/stub/install", "Bearer test-token")).status).toBe(201);
    expect((await request("POST", "/api/v1/sources/stub/update", "Bearer test-token")).status).toBe(200);
    expect((await request("DELETE", "/api/v1/sources/stub", "Bearer test-token")).status).toBe(204);
  });
});

describe("request priority lane", () => {
  const seen: Array<string | undefined> = [];
  const record = <T>(value: T) =>
    vi.fn(async () => {
      seen.push(currentPriority());
      return value;
    });

  const lanes = async (urls: string[]): Promise<Array<string | undefined>> => {
    seen.length = 0;
    plugin.popularNovels = record([{ name: "One", path: "one" }]) as unknown as NovelPlugin["popularNovels"];
    plugin.searchNovels = record([{ name: "Two", path: "two" }]) as unknown as NovelPlugin["searchNovels"];
    plugin.parseNovel = record({ name: "One", path: "one" }) as unknown as NovelPlugin["parseNovel"];
    plugin.parseChapter = record("<p>x</p>") as unknown as NovelPlugin["parseChapter"];
    for (const url of urls) await request("GET", url, "Bearer test-token");
    return [...seen];
  };

  it("defaults browse and chapter to bulk and search and novel to interactive", async () => {
    const base = "/api/v1/sources/stub";
    expect(await lanes([`${base}/browse`, `${base}/chapter?path=c`, `${base}/search?q=a`, `${base}/novel?path=n`])).toEqual([
      "bulk",
      "bulk",
      "interactive",
      "interactive",
    ]);
  });

  it("honors the priority query override on all four routes", async () => {
    const base = "/api/v1/sources/stub";
    expect(await lanes([`${base}/browse?priority=interactive`, `${base}/chapter?path=c&priority=interactive`])).toEqual([
      "interactive",
      "interactive",
    ]);
    expect(await lanes([`${base}/search?q=a&priority=bulk`, `${base}/novel?path=n&priority=bulk`])).toEqual(["bulk", "bulk"]);
  });

  it("rejects an unknown priority", async () => {
    const response = await request("GET", "/api/v1/sources/stub/browse?priority=urgent", "Bearer test-token");
    expect(response.status).toBe(400);
  });
});

describe("paged chapter lists", () => {
  const chapter = (n: number) => ({ name: `Chapter ${n}`, path: `/c/${n}` });
  const pagedPlugin = (firstPage: Array<{ name: string; path: string }>, totalPages: number, pageDelayMs = 0): NovelPlugin => ({
    ...plugin,
    parseNovel: vi.fn(async (path: string) => ({ name: "Paged", path, chapters: firstPage, totalPages })),
    parsePage: vi.fn(async (_path: string, page: string) => {
      if (pageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
      return { chapters: [chapter(Number(page) * 10)] };
    }),
  });
  const pagedStore = (paged: NovelPlugin) => ({ ...store, getPlugin: () => paged }) as unknown as SourceStore;
  const chapterPaths = (body: string) => (JSON.parse(body) as { chapters: Array<{ path: string }> }).chapters.map((c) => c.path);

  it("fetches pages 2..N after a first page of chapters", async () => {
    const paged = pagedPlugin([chapter(1)], 3);
    const response = await request("GET", "/api/v1/sources/stub/novel?path=n", "Bearer test-token", { store: pagedStore(paged) });
    expect(chapterPaths(response.body)).toEqual(["/c/1", "/c/20", "/c/30"]);
    expect(vi.mocked(paged.parsePage!).mock.calls.map((call) => call[1])).toEqual(["2", "3"]);
  });

  it("fetches every page when the novel call returns no chapters", async () => {
    const paged = pagedPlugin([], 2);
    const response = await request("GET", "/api/v1/sources/stub/novel?path=n", "Bearer test-token", { store: pagedStore(paged) });
    expect(chapterPaths(response.body)).toEqual(["/c/10", "/c/20"]);
  });

  it("gives a 600-page chapter list enough time at the default 1.5 s request spacing", () => {
    const pages = 600;
    const pacedMs = pages * 1_500;
    expect(novelBudgetMs(DEFAULT_NOVEL_DEADLINES, pages)).toBeGreaterThanOrEqual(DEFAULT_NOVEL_DEADLINES.baseMs + pacedMs * 1.5);
  });

  it("extends the novel deadline per page up to the cap", async () => {
    const options = { novelTimeoutMs: 100, novelPageTimeoutMs: 60 };
    const slow = pagedPlugin([chapter(1)], 5, 40);
    const ok = await request("GET", "/api/v1/sources/stub/novel?path=n", "Bearer test-token", { ...options, store: pagedStore(slow) });
    expect(ok.status).toBe(200);
    expect(chapterPaths(ok.body)).toHaveLength(5);
    const capped = await request("GET", "/api/v1/sources/stub/novel?path=n", "Bearer test-token", {
      ...options,
      novelMaxTimeoutMs: 100,
      store: pagedStore(pagedPlugin([chapter(1)], 5, 40)),
    });
    expect(capped.status).toBe(504);
    expect(JSON.parse(capped.body).code).toBe("TIMEOUT");
  });
});

describe("source health and disconnects", () => {
  it("reports a broken installed source instead of calling it", async () => {
    const response = await request("GET", "/api/v1/sources/broken/search?q=x", "Bearer test-token");
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: "Source failed to load; reinstall or remove it", code: "PLUGIN_ERROR" });
  });

  it("does not abort the request signal when a finished response closes", async () => {
    let seen: AbortSignal | undefined;
    const finishing: NovelPlugin = {
      ...plugin,
      parseChapter: vi.fn(async () => {
        seen = currentSignal();
        return "<p>done</p>";
      }),
    };
    const server = createNovelSourcesServer({
      token: "test-token",
      store: { ...store, getPlugin: () => finishing } as unknown as SourceStore,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(function (this: { writableFinished: boolean; emit: (event: string) => void }) {
        this.writableFinished = true;
        queueMicrotask(() => this.emit("close"));
        return this;
      }),
    });
    server.emit(
      "request",
      { method: "GET", url: "/api/v1/sources/stub/chapter?path=c", headers: { authorization: "Bearer test-token" } } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });

  it("aborts the plugin call when the client disconnects", async () => {
    let sawAbort = false;
    const waiting: NovelPlugin = {
      ...plugin,
      parseChapter: vi.fn(
        () =>
          new Promise<string>((_, reject) => {
            const signal = currentSignal();
            signal?.addEventListener("abort", () => {
              sawAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      ),
    };
    const server = createNovelSourcesServer({
      token: "test-token",
      store: { ...store, getPlugin: () => waiting } as unknown as SourceStore,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    });
    server.emit(
      "request",
      { method: "GET", url: "/api/v1/sources/stub/chapter?path=c", headers: { authorization: "Bearer test-token" } } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.destroyed = true;
    response.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sawAbort).toBe(true);
    expect(response.end).not.toHaveBeenCalled();
  });
});

describe("long chapter list loads", () => {
  const auth = "Bearer test-token";
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const slowPlugin = (load: () => Promise<{ name: string; path: string; chapters: Array<{ name: string; path: string }> }>): NovelPlugin => ({
    ...plugin,
    parseNovel: vi.fn(load),
  });
  const storeWith = (paged: NovelPlugin) => ({ ...store, getPlugin: () => paged }) as unknown as SourceStore;
  const novel = { name: "Long", path: "n", chapters: [{ name: "C1", path: "/c/1" }] };

  it("answers 202 pending after the wait, keeps loading, and serves the finished novel next", async () => {
    const gate = deferred<typeof novel>();
    const slow = slowPlugin(() => gate.promise);
    const logger = { log: vi.fn(), error: vi.fn() };
    const server = makeServer({ store: storeWith(slow), novelWaitMs: 20, logger });
    const first = await send(server, "GET", "/api/v1/sources/stub/novel?path=n&priority=bulk", auth);
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toEqual({ pending: true, retryAfterMs: 5_000 });
    const second = await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth);
    expect(second.status).toBe(202);
    expect(slow.parseNovel).toHaveBeenCalledTimes(1);
    gate.resolve(novel);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const done = await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body).chapters).toHaveLength(1);
    expect(slow.parseNovel).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("[novel_sources.novel_background] [end] source=stub durationMs="));
  });

  it("keeps the lane of the call that started the load", async () => {
    const gate = deferred<typeof novel>();
    const lanes: Array<string | undefined> = [];
    const slow = slowPlugin(() => {
      lanes.push(currentPriority());
      return gate.promise;
    });
    const server = makeServer({ store: storeWith(slow), novelWaitMs: 10 });
    await send(server, "GET", "/api/v1/sources/stub/novel?path=n&priority=bulk", auth);
    await send(server, "GET", "/api/v1/sources/stub/novel?path=n&priority=interactive", auth);
    gate.resolve(novel);
    expect(lanes).toEqual(["bulk"]);
  });

  it("does not abort the load when the waiting client disconnects", async () => {
    const gate = deferred<typeof novel>();
    let signal: AbortSignal | undefined;
    const slow = slowPlugin(() => {
      signal = currentSignal();
      return gate.promise;
    });
    const server = makeServer({ store: storeWith(slow), novelWaitMs: 1_000 });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    });
    server.emit(
      "request",
      { method: "GET", url: "/api/v1/sources/stub/novel?path=n", headers: { authorization: auth } } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.destroyed = true;
    response.emit("close");
    expect(signal?.aborted).toBe(false);
    gate.resolve(novel);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cached = await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth);
    expect(cached.status).toBe(200);
    expect(slow.parseNovel).toHaveBeenCalledTimes(1);
  });

  it("returns a background failure to the next call with its status and code, then loads again after it expires", async () => {
    const gate = deferred<typeof novel>();
    const slow = slowPlugin(() => gate.promise);
    const server = makeServer({ store: storeWith(slow), novelWaitMs: 10, novelFailureTtlMs: 30 });
    expect((await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth)).status).toBe(202);
    gate.reject(new SiteFetchError("Upstream request failed"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const failed = await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth);
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({ error: "Upstream request failed", code: "SITE_FAILED" });
    expect(slow.parseNovel).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    vi.mocked(slow.parseNovel).mockResolvedValueOnce(novel);
    expect((await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth)).status).toBe(200);
    expect(slow.parseNovel).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure the caller already received", async () => {
    const slow = slowPlugin(async () => {
      throw new SiteFetchError("Upstream request failed");
    });
    const server = makeServer({ store: storeWith(slow), novelWaitMs: 1_000 });
    expect((await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth)).status).toBe(502);
    expect((await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth)).status).toBe(502);
    expect(slow.parseNovel).toHaveBeenCalledTimes(2);
  });

  it("keeps at most the configured number of finished novels, dropping the least recently used", async () => {
    const slow = slowPlugin(async () => novel);
    const server = makeServer({ store: storeWith(slow), novelCacheEntries: 2 });
    for (const path of ["a", "b", "a", "c", "a", "b"]) {
      expect((await send(server, "GET", `/api/v1/sources/stub/novel?path=${path}`, auth)).status).toBe(200);
    }
    expect(vi.mocked(slow.parseNovel).mock.calls.map((call) => call[0])).toEqual(["a", "b", "c", "b"]);
  });
});

describe("chapter list de-duplication", () => {
  it("drops a chapter repeated across pages, keeping its first position", async () => {
    const paged: NovelPlugin = {
      ...plugin,
      parseNovel: vi.fn(async (path: string) => ({ name: "Paged", path, chapters: [{ name: "C3", path: "/c/3" }], totalPages: 3 })),
      parsePage: vi.fn(async (_path: string, page: string) =>
        page === "2"
          ? {
              chapters: [
                { name: "C2", path: "/c/2" },
                { name: "C3 again", path: "/c/3" },
              ],
            }
          : {
              chapters: [
                { name: "C2 again", path: "/c/2" },
                { name: "C1", path: "/c/1" },
              ],
            },
      ),
    };
    const response = await request("GET", "/api/v1/sources/stub/novel?path=n", "Bearer test-token", {
      store: { ...store, getPlugin: () => paged } as unknown as SourceStore,
    });
    const chapters = (JSON.parse(response.body) as { chapters: Array<{ name: string }> }).chapters.map((chapter) => chapter.name);
    expect(chapters).toEqual(["C3", "C2", "C1"]);
  });
});

describe("plugin path checks", () => {
  const auth = "Bearer test-token";
  const noSlash: NovelPlugin = { ...plugin, site: "https://stub.test" };
  const storeWith = (target: NovelPlugin) => ({ ...store, getPlugin: () => target }) as unknown as SourceStore;

  it.each([
    ["novel", "https://evil.test/novel/1"],
    ["novel", "//evil.test/novel/1"],
    ["chapter", "http://169.254.169.254/latest"],
    ["chapter", "file:///etc/passwd"],
  ])("refuses a %s path on another host: %s", async (action, path) => {
    const response = await request("GET", `/api/v1/sources/stub/${action}?path=${encodeURIComponent(path)}`, auth);
    expect(response.status).toBe(400);
  });

  it("refuses a path that only reaches another host when concatenated to a site without a trailing slash", async () => {
    const response = await request("GET", `/api/v1/sources/stub/chapter?path=${encodeURIComponent("@evil.test/x")}`, auth, {
      store: storeWith(noSlash),
    });
    expect(response.status).toBe(400);
  });

  it("accepts relative paths, absolute paths on the site or a subdomain, and hosts the plugin returned itself", async () => {
    for (const path of ["/novel/1", "novel/1", "https://stub.test/novel/1", "https://api.stub.test/novel/1"]) {
      expect((await request("GET", `/api/v1/sources/stub/chapter?path=${encodeURIComponent(path)}`, auth)).status).toBe(200);
    }
    const mirror: NovelPlugin = {
      ...plugin,
      parseNovel: vi.fn(async (path: string) => ({ name: "M", path, chapters: [{ name: "C1", path: "https://mirror.test/c/1" }] })),
      parseChapter: vi.fn(async () => "<p>ok</p>"),
    };
    const server = makeServer({ store: storeWith(mirror) });
    expect((await send(server, "GET", `/api/v1/sources/stub/chapter?path=${encodeURIComponent("https://mirror.test/c/1")}`, auth)).status).toBe(400);
    expect((await send(server, "GET", "/api/v1/sources/stub/novel?path=n", auth)).status).toBe(200);
    expect((await send(server, "GET", `/api/v1/sources/stub/chapter?path=${encodeURIComponent("https://mirror.test/c/1")}`, auth)).status).toBe(200);
  });

  const chapterStatus = (server: ReturnType<typeof makeServer>, path: string) =>
    send(server, "GET", `/api/v1/sources/stub/chapter?path=${encodeURIComponent(path)}`, auth).then((response) => response.status);

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://[::1]/x",
    "http://[fd00::1]/x",
    "http://0x7f.1/x",
    "http://localhost/x",
    "http://api.localhost/x",
    "http://redis/x",
    "http://metadata.google.internal/x",
    "http://nas.local/x",
    "http://localhost./x",
    "http://metadata.google.internal./x",
    "http://nas.local./x",
    "http://instance-data.ec2.internal./latest/meta-data/",
  ])("never trusts a non-public host learned from browse results: %s", async (listed) => {
    const listing: NovelPlugin = { ...plugin, popularNovels: vi.fn(async () => [{ name: "x", path: listed }]) };
    const server = makeServer({ store: storeWith(listing) });
    expect((await send(server, "GET", "/api/v1/sources/stub/browse", auth)).status).toBe(200);
    expect(await chapterStatus(server, listed)).toBe(400);
  });

  it("trusts a public host learned from search results, on its own port only", async () => {
    const listing: NovelPlugin = { ...plugin, searchNovels: vi.fn(async () => [{ name: "x", path: "https://mirror.example.com/n/1" }]) };
    const server = makeServer({ store: storeWith(listing) });
    expect((await send(server, "GET", "/api/v1/sources/stub/search?q=x", auth)).status).toBe(200);
    expect(await chapterStatus(server, "https://mirror.example.com/c/1")).toBe(200);
    expect(await chapterStatus(server, "https://mirror.example.com:6379/c/1")).toBe(400);
  });

  it("treats a name with one trailing dot as the same name, on its own port only", async () => {
    const server = makeServer({ store: storeWith({ ...plugin, site: "https://example.com/" }) });
    expect(await chapterStatus(server, "https://example.com./x")).toBe(200);
    expect(await chapterStatus(server, "https://cdn.example.com./x")).toBe(200);
    expect(await chapterStatus(server, "https://example.com.:6379/x")).toBe(400);

    const listing: NovelPlugin = { ...plugin, searchNovels: vi.fn(async () => [{ name: "x", path: "https://mirror.example.org./n/1" }]) };
    const learned = makeServer({ store: storeWith(listing) });
    expect((await send(learned, "GET", "/api/v1/sources/stub/search?q=x", auth)).status).toBe(200);
    expect(await chapterStatus(learned, "https://mirror.example.org/c/1")).toBe(200);
    expect(await chapterStatus(learned, "https://mirror.example.org./c/1")).toBe(200);
    expect(await chapterStatus(learned, "https://mirror.example.org.:6379/c/1")).toBe(400);
  });

  it("forgets learned hosts when the source is removed", async () => {
    const listing: NovelPlugin = { ...plugin, searchNovels: vi.fn(async () => [{ name: "x", path: "https://mirror.example.com/n/1" }]) };
    const server = makeServer({ store: { ...store, getPlugin: () => listing, remove: vi.fn(async () => undefined) } as unknown as SourceStore });
    await send(server, "GET", "/api/v1/sources/stub/search?q=x", auth);
    expect((await send(server, "DELETE", "/api/v1/sources/stub", auth)).status).toBe(204);
    expect(await chapterStatus(server, "https://mirror.example.com/c/1")).toBe(400);
  });

  it("refuses a parent domain or public suffix of the site", async () => {
    const server = makeServer({ store: storeWith({ ...plugin, site: "https://novels.example.co.uk/" }) });
    expect(await chapterStatus(server, "https://example.co.uk/x")).toBe(400);
    expect(await chapterStatus(server, "https://co.uk/x")).toBe(400);
    expect(await chapterStatus(server, "https://cdn.novels.example.co.uk/x")).toBe(200);
  });

  it("refuses the site host on a port other than its own", async () => {
    const server = makeServer();
    expect(await chapterStatus(server, "https://stub.test:6379/x")).toBe(400);
    expect(await chapterStatus(server, "https://api.stub.test:8443/x")).toBe(400);
    expect(await chapterStatus(server, "https://stub.test:443/x")).toBe(200);
    const ported = makeServer({ store: storeWith({ ...plugin, site: "https://stub.test:8443/" }) });
    expect(await chapterStatus(ported, "https://stub.test:8443/x")).toBe(200);
    expect(await chapterStatus(ported, "https://stub.test/x")).toBe(400);
  });
});
