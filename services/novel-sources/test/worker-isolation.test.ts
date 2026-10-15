import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceFetcher, runWithDeadline, runWithPriority, type Priority } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";
import { FetchTimeoutError } from "../src/types.js";
import { makeTempDir, removeTempDirs } from "./support/temp.js";

const pluginSource = `
const { fetchText } = require("@libs/fetch");
const { storage } = require("@libs/storage");
class Source {
  constructor() { this.id = "looper"; this.name = "Looper"; this.site = "https://looper.test/"; this.version = "1.0.0"; }
  async popularNovels(page) {
    if (page === 99) { for (;;) {} }
    return [{ name: "ok", path: "ok" }];
  }
  async searchNovels(term) {
    await fetchText("https://looper.test/" + term);
    return [{ name: term, path: term }];
  }
  async parseNovel(path) { return { name: path, path, chapters: [] }; }
  async parseChapter(path) {
    if (path.startsWith("set:")) { storage.set("key", path.slice(4)); return "set"; }
    return String(storage.get("key"));
  }
}
exports.default = new Source();`;

const hosts: PluginHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await removeTempDirs();
});

const setup = async (fetchDelayMs: number | ((name: string) => number) = 0, fetcherOptions: { intervalMs?: number; maxInFlight?: number } = {}) => {
  const dataDir = await makeTempDir();
  const starts: Array<{ name: string; at: number }> = [];
  let active = 0;
  let maxActive = 0;
  // Starts are stamped with the limiter's own clock reading at dispatch, so the spacing check cannot be skewed by load.
  let lastNow = 0;
  const now = (): number => {
    lastNow = performance.now();
    return lastNow;
  };
  const fetchImpl = async (input: string | URL | Request) => {
    const name = String(input).split("/").pop()!;
    starts.push({ name, at: lastNow });
    active += 1;
    maxActive = Math.max(maxActive, active);
    const delayMs = typeof fetchDelayMs === "number" ? fetchDelayMs : fetchDelayMs(name);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return new Response("ok");
  };
  const fetcher = new SourceFetcher({ intervalMs: 0, ...fetcherOptions, fetchImpl, now });
  const host = new PluginHost({ dataDir, fetcher });
  hosts.push(host);
  const plugin = await host.loadSource(pluginSource, "looper");
  const search = (name: string, priority: Priority = "bulk") => runWithPriority(priority, () => plugin.searchNovels(name, 1));
  return { dataDir, host, plugin, starts, search, maxActive: () => maxActive };
};

describe("plugin workers", () => {
  it("terminates a plugin stuck in a synchronous loop and keeps serving the source", async () => {
    const { plugin } = await setup();
    const started = Date.now();
    const stuck = runWithDeadline(300, () => plugin.popularNovels(99, { showLatestNovels: false, filters: undefined }));
    await expect(stuck).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
    const next = await runWithDeadline(5_000, () => plugin.popularNovels(1, { showLatestNovels: false, filters: undefined }));
    expect(next).toEqual([{ name: "ok", path: "ok" }]);
  });

  it("holds per-source spacing across two workers", async () => {
    const { starts, search } = await setup(0, { intervalMs: 200, maxInFlight: 5 });
    await Promise.all([search("a"), search("b"), search("c")]);
    const times = starts.map((start) => start.at).sort((a, b) => a - b);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(200);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(200);
  });

  it("holds the in-flight cap across two workers", async () => {
    const { search, maxActive } = await setup(150, { maxInFlight: 1 });
    await Promise.all([search("a"), search("b"), search("c")]);
    expect(maxActive()).toBe(1);
  });

  it("serves interactive calls before queued bulk calls", async () => {
    // The interactive call must reach the limiter while the bulk fetches still hold both slots, so they stay busy long enough.
    // b1 finishes well after b0, so exactly one worker frees up first and the race between two finishing workers is gone.
    const { starts, search } = await setup((name) => (name === "b1" ? 1_500 : 1_000), { maxInFlight: 2 });
    const all = [search("b0"), search("b1"), search("b2"), search("b3")];
    // Worker startup time varies, so wait until both slots are taken before the interactive call arrives.
    const deadline = Date.now() + 5_000;
    while (starts.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts.length).toBe(2);
    all.push(search("i0", "interactive"));
    await Promise.all(all);
    const names = starts.map((start) => start.name);
    expect(names.slice(0, 2).sort()).toEqual(["b0", "b1"]);
    expect(names[2]).toBe("i0");
  }, 15_000);

  it("persists plugin storage through the main thread", async () => {
    const { dataDir, host, plugin } = await setup();
    await plugin.parseChapter("set:hello");
    expect(await plugin.parseChapter("get")).toBe("hello");
    const stored = new Map(JSON.parse(await readFile(join(dataDir, "storage/looper/storage.json"), "utf8")) as Array<[string, { value: string }]>);
    expect(stored.get("key")?.value).toBe("hello");
    await host.close();
    const reloaded = await new PluginHost({ dataDir, fetcher: new SourceFetcher({ intervalMs: 0 }) });
    hosts.push(reloaded);
    const again = await reloaded.loadSource(pluginSource, "looper");
    expect(await again.parseChapter("get")).toBe("hello");
  });
});
