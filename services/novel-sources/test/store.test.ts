import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetcher } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";
import { MAX_PLUGIN_BYTES, SourceStore } from "../src/store.js";
import type { IndexEntry } from "../src/types.js";
import { makeTempDir, removeTempDirs } from "./support/temp.js";

const pluginSource = (version: string) => `
class Source {
  constructor() { this.id = "stub"; this.name = "Stub"; this.site = "https://stub.test/"; this.version = "${version}"; }
  async popularNovels() { return []; }
  async searchNovels() { return []; }
  async parseNovel(path) { return { name: "Novel", path, chapters: [] }; }
  async parseChapter() { return "<p>chapter</p>"; }
}
exports.default = new Source();`;

const entry = (version: string): IndexEntry => ({
  id: "stub",
  name: "Stub",
  site: "https://stub.test/",
  lang: "English",
  version,
  url: `https://plugins.test/stub-${version}.js`,
  iconUrl: "https://plugins.test/stub.png",
});

const hosts: PluginHost[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await removeTempDirs();
});

describe("SourceStore", () => {
  it("installs, updates, removes, and refuses unknown ids", async () => {
    const dataDir = await makeTempDir();
    let now = Date.now();
    let current = entry("1.0.0");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://index.test") return Response.json([current]);
      if (url === current.url) return new Response(pluginSource(current.version));
      return new Response("missing", { status: 404 });
    });
    const host = new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    const store = new SourceStore({
      dataDir,
      host,
      indexUrl: "https://index.test",
      fetchImpl,
      now: () => now,
    });
    await store.initialize();
    await expect(store.install("unknown")).rejects.toMatchObject({ status: 404 });
    expect((await store.install("stub")).version).toBe("1.0.0");
    expect(store.getPlugin("stub")?.id).toBe("stub");
    current = entry("1.1.0");
    now += 2 * 60 * 60_000;
    expect((await store.update("stub")).version).toBe("1.1.0");
    await expect(readFile(join(dataDir, "plugins/stub@1.0.0.js"))).rejects.toThrow();
    await store.remove("stub");
    expect(store.installedCount).toBe(0);
    await expect(store.remove("stub")).rejects.toMatchObject({ status: 409 });
  });

  it("skips a tampered installed plugin on boot, marks it broken and lets it be removed", async () => {
    const dataDir = await makeTempDir();
    const current = entry("1.0.0");
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input) === "https://index.test" ? Response.json([current]) : new Response(pluginSource("1.0.0")),
    );
    const host = new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    const store = new SourceStore({
      dataDir,
      host,
      indexUrl: "https://index.test",
      fetchImpl,
    });
    await store.initialize();
    await store.install("stub");
    await writeFile(join(dataDir, "plugins/stub@1.0.0.js"), "tampered");
    const logger = { error: vi.fn() };
    const restarted = new SourceStore({
      dataDir,
      host,
      indexUrl: "https://index.test",
      fetchImpl,
      logger,
    });
    await restarted.initialize();
    expect(restarted.getPlugin("stub")).toBeUndefined();
    expect(restarted.isBroken("stub")).toBe(true);
    expect(restarted.listInstalled()).toEqual([expect.objectContaining({ id: "stub", broken: true })]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("[novel_sources.load_installed] [fail] source=stub"));
    await restarted.remove("stub");
    expect(restarted.installedCount).toBe(0);
    await expect(readFile(join(dataDir, "plugins/stub@1.0.0.js"))).rejects.toThrow();
  });

  it("installs the same source twice at once without temp file collisions", async () => {
    const dataDir = await makeTempDir();
    const current = entry("1.0.0");
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input) === "https://index.test" ? Response.json([current]) : new Response(pluginSource("1.0.0")),
    );
    const host = new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    const store = new SourceStore({ dataDir, host, indexUrl: "https://index.test", fetchImpl });
    await store.initialize();
    const results = await Promise.allSettled([store.install("stub"), store.install("stub"), store.install("stub")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect((await readdir(join(dataDir, "plugins"))).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    await host.close();
  });

  it("times out a stalled plugin download and rejects an oversized one", async () => {
    const dataDir = await makeTempDir();
    const current = entry("1.0.0");
    let pluginBody: (signal: AbortSignal) => Response = () => new Response("x".repeat(MAX_PLUGIN_BYTES + 1));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://index.test") return Response.json([current]);
      return pluginBody(init!.signal!);
    });
    const host = new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    const store = new SourceStore({ dataDir, host, indexUrl: "https://index.test", fetchImpl, downloadTimeoutMs: 100 });
    await store.initialize();
    await expect(store.install("stub")).rejects.toMatchObject({ status: 502, message: "Upstream response is too large" });
    pluginBody = (signal) =>
      new Response(
        new ReadableStream({
          pull: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
        }),
      );
    const started = Date.now();
    await expect(store.install("stub")).rejects.toMatchObject({ status: 502 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.installedCount).toBe(0);
  });
  const setupStore = async (options: { dataDir?: string; safeMode?: boolean; logger?: Pick<Console, "error"> } = {}) => {
    const dataDir = options.dataDir ?? (await makeTempDir());
    let pluginGate: Promise<void> = Promise.resolve();
    let current = entry("1.0.0");
    let now = Date.now();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://index.test") return Response.json([current]);
      await pluginGate;
      return new Response(pluginSource(current.version));
    });
    const host = new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    hosts.push(host);
    const store = new SourceStore({
      dataDir,
      host,
      indexUrl: "https://index.test",
      fetchImpl,
      now: () => now,
      ...(options.safeMode ? { safeMode: true } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    await store.initialize();
    return {
      dataDir,
      host,
      store,
      setVersion: (version: string) => {
        current = entry(version);
        now += 2 * 60 * 60_000;
      },
      holdDownloads: () => {
        let release!: () => void;
        pluginGate = new Promise((resolve) => (release = resolve));
        return () => release();
      },
    };
  };

  it("does not resurrect a source removed while its update was downloading", async () => {
    const { store, setVersion, holdDownloads } = await setupStore();
    await store.install("stub");
    setVersion("1.1.0");
    const release = holdDownloads();
    const update = store.update("stub");
    const remove = store.remove("stub");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await update).version).toBe("1.1.0");
    await remove;
    expect(store.installedCount).toBe(0);
    expect(store.getPlugin("stub")).toBeUndefined();
  });

  it("deletes a removed source's storage, on disk and in memory", async () => {
    const { dataDir, host, store } = await setupStore();
    await store.install("stub");
    const storageDir = join(dataDir, "storage/stub");
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "storage.json"), "[]");
    const removeStorage = vi.spyOn(host, "removeStorage");
    await store.remove("stub");
    expect(removeStorage).toHaveBeenCalledWith("stub");
    await expect(stat(storageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts from the backup when the manifest is empty, and from no sources when both are unreadable", async () => {
    const { dataDir, store } = await setupStore();
    await store.install("stub");
    await writeFile(join(dataDir, "installed.json"), "");
    const logger = { error: vi.fn() };
    const fromBackup = await setupStore({ dataDir, logger });
    expect(fromBackup.store.getPlugin("stub")?.id).toBe("stub");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("[novel_sources.read_manifest] [fail]"));
    await writeFile(join(dataDir, "installed.json.bak"), "{not json");
    const empty = await setupStore({ dataDir, logger });
    expect(empty.store.installedCount).toBe(0);
  });

  it("lists installed sources as broken without loading them in safe mode, so they can be removed", async () => {
    const { dataDir, store } = await setupStore();
    await store.install("stub");
    const loadSource = vi.spyOn(PluginHost.prototype, "loadSource");
    const safe = await setupStore({ dataDir, safeMode: true, logger: { error: vi.fn() } });
    expect(loadSource).not.toHaveBeenCalled();
    expect(safe.store.isBroken("stub")).toBe(true);
    expect(safe.store.loadedCount).toBe(0);
    expect(safe.store.brokenCount).toBe(1);
    await safe.store.remove("stub");
    expect(safe.store.installedCount).toBe(0);
  });
});
