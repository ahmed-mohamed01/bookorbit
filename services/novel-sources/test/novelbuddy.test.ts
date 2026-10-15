import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SourceFetcher } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";

describe("NovelBuddy fixture", () => {
  it("runs browse and search against recorded API-shaped JSON", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        success: true,
        data: {
          items: [
            {
              name: "Recorded Novel",
              url: "/novel/recorded-novel",
              cover: "https://images.test/recorded.jpg",
            },
          ],
        },
      });
    });
    const host = new PluginHost({
      dataDir: join(import.meta.dirname, ".data"),
      fetcher: new SourceFetcher({ intervalMs: 0, fetchImpl }),
    });
    const source = await readFile(join(import.meta.dirname, "fixtures/plugins/novelbuddy.js"), "utf8");
    const plugin = await host.loadSource(source, "novelbuddy");
    const browse = await plugin.popularNovels(1, {
      showLatestNovels: false,
      filters: plugin.filters,
    });
    const search = await plugin.searchNovels("recorded", 2);
    expect(browse).toEqual([
      {
        name: "Recorded Novel",
        path: "novel/recorded-novel",
        cover: "https://images.test/recorded.jpg",
      },
    ]);
    expect(search).toEqual(browse);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("https://api.novelbuddy.me/titles/search?");
    expect(urls[1]).toContain("q=recorded");
  });
});
