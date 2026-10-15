import { afterEach, describe, expect, it } from "vitest";
import { SourceFetcher, runWithDeadline } from "../src/fetcher.js";
import { PluginHost } from "../src/plugin-host.js";
import { makeTempDir, removeTempDirs } from "./support/temp.js";

const pluginSource = `
const { load } = require("cheerio");
class Source {
  constructor() { this.id = "longlist"; this.name = "Long list"; this.site = "https://longlist.test/"; this.version = "1.0.0"; }
  async popularNovels() {
    const hoard = [];
    for (;;) hoard.push(new Array(100_000).fill("runaway"));
  }
  async searchNovels() { return []; }
  async parseNovel(path) {
    let html = "<html><body><div class=wrap><ul class=chapters>";
    for (let i = 0; i < 10_000; i++) {
      html += '<li class="row"><a href="/novel/some-long-novel-name/chapter-' + i + '" title="Chapter ' + i + ': A fairly typical chapter title here">Chapter ' + i + ': A fairly typical chapter title here</a><span class="date">2024-01-01</span></li>';
    }
    html += "</ul></div></body></html>";
    const $ = load(html);
    const chapters = $("ul.chapters li a").map((_, a) => ({ name: $(a).text(), path: $(a).attr("href") })).get();
    return { name: path, path, chapters };
  }
  async parseChapter() { return ""; }
}
exports.default = new Source();`;

const hosts: PluginHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await removeTempDirs();
});

describe("plugin worker heap at the default limits", () => {
  it("parses a 10,000-row chapter list page and still ends a runaway allocation cleanly", async () => {
    const host = new PluginHost({ dataDir: await makeTempDir(), fetcher: new SourceFetcher({ intervalMs: 0 }) });
    hosts.push(host);
    const plugin = await host.loadSource(pluginSource, "longlist");

    const novel = await runWithDeadline(30_000, () => plugin.parseNovel("long"));
    expect(novel.chapters).toHaveLength(10_000);

    const runaway = runWithDeadline(30_000, () => plugin.popularNovels(1, { showLatestNovels: false, filters: undefined }));
    await expect(runaway).rejects.toThrow(/Plugin worker crashed/u);

    const again = await runWithDeadline(30_000, () => plugin.parseNovel("again"));
    expect(again.chapters).toHaveLength(10_000);
  }, 60_000);
});
