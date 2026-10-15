import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceFetcher } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";

const fixtureDir = join(import.meta.dirname, "fixtures/plugins");

describe("PluginHost", () => {
  it("loads every real fixture and exposes the required methods", async () => {
    const host = new PluginHost({
      dataDir: join(import.meta.dirname, ".data"),
      fetcher: new SourceFetcher({ intervalMs: 0 }),
    });
    const files = await readdir(fixtureDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const plugin = await host.loadSource(await readFile(join(fixtureDir, file), "utf8"));
      expect(plugin.id).toBeTruthy();
      expect(plugin.popularNovels).toBeTypeOf("function");
      expect(plugin.searchNovels).toBeTypeOf("function");
      expect(plugin.parseNovel).toBeTypeOf("function");
      expect(plugin.parseChapter).toBeTypeOf("function");
    }
  });

  it("rejects modules outside the allow-list", async () => {
    const host = new PluginHost({
      dataDir: join(import.meta.dirname, ".data"),
      fetcher: new SourceFetcher({ intervalMs: 0 }),
    });
    await expect(host.loadSource('require("node:fs")')).rejects.toThrow("Module is not allowed: node:fs");
  });

  it("exposes parsePage only for plugins with paged chapter lists", async () => {
    const host = new PluginHost({
      dataDir: join(import.meta.dirname, ".data"),
      fetcher: new SourceFetcher({ intervalMs: 0 }),
    });
    try {
      const paged = await host.loadSource(`exports.default = {
        id: "paged", name: "Paged", site: "https://paged.test/", version: "1.0.0",
        popularNovels: async () => [], searchNovels: async () => [], parseChapter: async () => "",
        parseNovel: async (path) => ({ name: "N", path, chapters: [], totalPages: 2 }),
        parsePage: async (path, page) => ({ chapters: [{ name: "C" + page, path: "c/" + page }] }),
        resolveUrl: (path) => "https://paged.test/read/" + path,
      };`);
      expect(await paged.parsePage!("n", "2")).toEqual({
        chapters: [{ name: "C2", path: "c/2", resolvedUrl: "https://paged.test/read/c/2" }],
      });
      expect((await paged.parseNovel("n")).totalPages).toBe(2);
      const flat = await host.loadSource(await readFile(join(fixtureDir, "royalroad.js"), "utf8"));
      expect(flat.parsePage).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});
