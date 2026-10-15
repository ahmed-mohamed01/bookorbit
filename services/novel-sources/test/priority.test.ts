import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetcher, runWithPriority } from "../src/fetcher.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = (options: { intervalMs?: number; maxInFlight?: number; hold?: boolean } = {}) => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const starts: Array<{ url: string; at: number }> = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    starts.push({ url: String(input), at: Date.now() });
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (options.hold) await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return new Response("ok");
  });
  const fetcher = new SourceFetcher({ intervalMs: options.intervalMs ?? 100, maxInFlight: options.maxInFlight ?? 1, fetchImpl });
  const bulk = (name: string) => runWithPriority("bulk", () => fetcher.request("s", "https://site.test", `https://site.test/${name}`));
  const interactive = (name: string) => runWithPriority("interactive", () => fetcher.request("s", "https://site.test", `https://site.test/${name}`));
  const names = () => starts.map((start) => start.url.split("/").pop());
  return { fetcher, fetchImpl, starts, releases, bulk, interactive, names, maxActive: () => maxActive };
};

describe("source priority lanes", () => {
  it("serves an interactive request next while ten bulk requests are queued", async () => {
    const t = setup();
    const pending = Array.from({ length: 10 }, (_, index) => t.bulk(`b${index}`));
    await vi.advanceTimersByTimeAsync(0);
    const search = t.interactive("search");
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([...pending, search]);
    expect(t.names().slice(0, 2)).toEqual(["b0", "search"]);
  });

  it("gives bulk a slot after three consecutive interactive slots", async () => {
    const t = setup();
    const all = [t.bulk("b0"), t.bulk("b1"), t.bulk("b2")];
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 8; index += 1) all.push(t.interactive(`i${index}`));
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(all);
    expect(t.names()).toEqual(["b0", "i0", "i1", "i2", "b1", "i3", "i4", "i5", "b2", "i6", "i7"]);
  });

  it("keeps spacing between starts across lanes", async () => {
    const t = setup({ maxInFlight: 5 });
    const all = [t.bulk("b0"), t.bulk("b1"), t.interactive("i0"), t.interactive("i1")];
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(all);
    expect(t.starts.map((start) => start.at)).toEqual([10_000, 10_100, 10_200, 10_300]);
  });

  it("keeps the in-flight cap across lanes", async () => {
    const t = setup({ intervalMs: 0, maxInFlight: 2, hold: true });
    const all = [t.bulk("b0"), t.bulk("b1"), t.interactive("i0"), t.interactive("i1")];
    await vi.advanceTimersByTimeAsync(0);
    expect(t.names()).toEqual(["b0", "b1"]);
    t.releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.names()).toEqual(["b0", "b1", "i0"]);
    while (t.releases.length > 0 || t.names().length < 4) {
      t.releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(all);
    expect(t.maxActive()).toBe(2);
  });

  it("treats requests with no lane as bulk", async () => {
    const t = setup();
    const all = [
      t.fetcher.request("s", "https://site.test", "https://site.test/b0"),
      t.fetcher.request("s", "https://site.test", "https://site.test/b1"),
    ];
    await vi.advanceTimersByTimeAsync(0);
    all.push(t.interactive("i0"));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(all);
    expect(t.names()).toEqual(["b0", "i0", "b1"]);
  });

  it("carries the lane into @libs/fetch calls made by plugin code", async () => {
    const t = setup();
    const { fetchText } = t.fetcher.createModule("s", "https://site.test");
    const first = t.bulk("b0");
    const others = [t.bulk("b1")];
    await vi.advanceTimersByTimeAsync(0);
    const plugin = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return fetchText("https://site.test/plugin");
    };
    others.push(runWithPriority("interactive", plugin) as Promise<never>);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, ...others]);
    expect(t.names()).toEqual(["b0", "plugin", "b1"]);
  });
});
