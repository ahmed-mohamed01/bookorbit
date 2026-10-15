import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetcher, runWithDeadline, runWithSignal } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";
import { makeTempDir, removeTempDirs } from "./support/temp.js";

const source = (id: string) => `
const { fetchText } = require("@libs/fetch");
exports.default = {
  id: "${id}", name: "${id}", site: "https://${id}.test/", version: "1.0.0",
  popularNovels: async (page) => { if (page === 99) { for (;;) {} } return []; },
  searchNovels: async (term) => { await fetchText("https://${id}.test/" + term); return [{ name: term, path: term }]; },
  parseNovel: async () => ({}),
  parseChapter: async (path) => { await new Promise((resolve) => setTimeout(resolve, 300)); return path; },
};`;

const hosts: PluginHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await removeTempDirs();
});

const setup = async (maxWorkers: number, ids: string[], fetchDelayMs = 0, acquireTimeoutMs?: number) => {
  const fetchImpl = vi.fn(async () => {
    if (fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
    return new Response("ok");
  });
  const host = new PluginHost({
    dataDir: await makeTempDir(),
    fetcher: new SourceFetcher({ intervalMs: 0, fetchImpl }),
    maxWorkers,
    ...(acquireTimeoutMs !== undefined ? { acquireTimeoutMs } : {}),
  });
  hosts.push(host);
  const plugins = [];
  for (const id of ids) plugins.push(await host.loadSource(source(id), id));
  return { host, plugins };
};

describe("global worker budget", () => {
  it("never runs more live workers than the cap across sources", async () => {
    const { host, plugins } = await setup(2, ["a", "b", "c"], 100);
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, host.budget.liveCount)), 5);
    try {
      const results = await Promise.all(
        plugins.flatMap((plugin) => [1, 2].map((n) => runWithDeadline(10_000, () => plugin.searchNovels(`t${n}`, 1)))),
      );
      expect(results).toHaveLength(6);
    } finally {
      clearInterval(sampler);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retires another source's idle worker instead of waiting for its idle timeout", async () => {
    const { host, plugins } = await setup(1, ["a", "b"]);
    await runWithDeadline(5_000, () => plugins[0]!.searchNovels("first", 1));
    expect(host.budget.liveCount).toBe(1);
    const started = Date.now();
    await runWithDeadline(5_000, () => plugins[1]!.searchNovels("second", 1));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(host.budget.liveCount).toBe(1);
  });

  it("stops a running plugin call when its request is aborted", async () => {
    const { host, plugins } = await setup(2, ["a"]);
    const controller = new AbortController();
    const stuck = runWithSignal(controller.signal, () =>
      runWithDeadline(30_000, () => plugins[0]!.popularNovels(99, { showLatestNovels: false, filters: undefined })),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    controller.abort();
    await expect(stuck).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(host.budget.liveCount).toBe(0);
  });

  it("gives a waiting source a slot while another source keeps both workers busy", async () => {
    const { plugins } = await setup(2, ["a", "b"]);
    const [a, b] = plugins as [NonNullable<(typeof plugins)[0]>, NonNullable<(typeof plugins)[0]>];
    let stop = false;
    let aDone = 0;
    const loop = async () => {
      while (!stop) {
        await runWithDeadline(60_000, () => a.parseChapter("a"));
        aDone += 1;
      }
    };
    const loops = [loop(), loop(), loop()];
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      await expect(runWithDeadline(5_000, () => b.parseChapter("b"))).resolves.toBe("b");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      stop = true;
      await Promise.all(loops);
    }
    expect(aDone).toBeGreaterThan(0);
  });

  it("fails a source load with 503 when no worker slot frees up in time", async () => {
    const { host, plugins } = await setup(1, ["a"], 0, 300);
    const controller = new AbortController();
    const busy = runWithSignal(controller.signal, () =>
      runWithDeadline(30_000, () => plugins[0]!.popularNovels(99, { showLatestNovels: false, filters: undefined })),
    ).catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      await expect(host.loadSource(source("b"), "b")).rejects.toMatchObject({ status: 503, code: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(host.budget.hasWaiters).toBe(false);
    } finally {
      controller.abort();
      await busy;
    }
  });

  it("drops a source from the slot queue when its last waiting call expires", async () => {
    const { host, plugins } = await setup(1, ["a", "b"]);
    const controller = new AbortController();
    const busy = runWithSignal(controller.signal, () =>
      runWithDeadline(30_000, () => plugins[0]!.popularNovels(99, { showLatestNovels: false, filters: undefined })),
    ).catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(runWithDeadline(200, () => plugins[1]!.parseChapter("b"))).rejects.toMatchObject({ name: "FetchTimeoutError" });
      expect(host.budget.hasWaiters).toBe(false);
    } finally {
      controller.abort();
      await busy;
    }
  });
});
