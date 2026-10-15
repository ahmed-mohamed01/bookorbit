import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetcher } from "../src/fetcher.js";
import { ChallengeError, FetchTimeoutError } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SourceFetcher", () => {
  it("spaces starts for one source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(Date.now());
      return new Response("ok");
    });
    const fetcher = new SourceFetcher({ intervalMs: 100, fetchImpl });
    const first = fetcher.request("source", "https://site.test", "https://site.test/1");
    const second = fetcher.request("source", "https://site.test", "https://site.test/2");
    await first;
    expect(starts).toEqual([10_000]);
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(starts).toEqual([10_000, 10_100]);
  });

  it("aborts an upstream request at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const fetcher = new SourceFetcher({ intervalMs: 0, timeoutMs: 50, fetchImpl });
    const request = fetcher.request("source", "https://site.test", "https://site.test/slow");
    const expectation = expect(request).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });

  it("uses the solver for challenges and reuses its session", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url === "http://solver") {
        return Response.json({
          status: "ok",
          solution: {
            status: 200,
            response: "<html>solved</html>",
            userAgent: "solver-agent",
            cookies: [{ name: "cf_clearance", value: "secret" }],
          },
        });
      }
      if (calls.filter((call) => call.url !== "http://solver").length === 1) {
        return new Response('<title>Just a moment...</title><div class="cf-chl-test">', {
          status: 503,
        });
      }
      return new Response("direct");
    });
    const fetcher = new SourceFetcher({
      intervalMs: 0,
      solverUrl: "http://solver",
      fetchImpl,
    });
    expect(await (await fetcher.request("source", "https://site.test/", "https://site.test/a")).text()).toContain("solved");
    await fetcher.request("source", "https://site.test/", "https://site.test/b");
    expect(calls[2]!.headers.get("cookie")).toBe("cf_clearance=secret");
    expect(calls[2]!.headers.get("user-agent")).toBe("solver-agent");
  });

  it("reports an unsolved challenge without a solver", async () => {
    const fetcher = new SourceFetcher({
      intervalMs: 0,
      fetchImpl: vi.fn(async () => new Response("cf-chl-test", { status: 403 })),
    });
    await expect(fetcher.request("source", "https://site.test", "https://site.test")).rejects.toBeInstanceOf(ChallengeError);
  });

  it("drops an aborted queued request without spending a spacing slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const starts: Array<{ url: string; at: number }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      starts.push({ url: String(input), at: Date.now() });
      return new Response("ok");
    });
    const fetcher = new SourceFetcher({ intervalMs: 100, fetchImpl });
    const controller = new AbortController();
    await fetcher.request("source", "https://site.test", "https://site.test/1");
    const aborted = fetcher.request("source", "https://site.test", "https://site.test/2", { signal: controller.signal });
    const live = fetcher.request("source", "https://site.test", "https://site.test/3");
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    await live;
    expect(starts).toEqual([
      { url: "https://site.test/1", at: 10_000 },
      { url: "https://site.test/3", at: 10_100 },
    ]);
  });

  it("replays a challenged POST through the solver and keeps the solved session", async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), body: init?.body, signal: init?.signal });
      if (url === "http://solver") {
        return Response.json({
          status: "ok",
          solution: { status: 200, response: "results", userAgent: "solver-agent", cookies: [{ name: "cf_clearance", value: "c" }] },
        });
      }
      if (calls.length === 1) return new Response("<title>Just a moment...</title>", { status: 403 });
      return new Response("direct");
    });
    const fetcher = new SourceFetcher({ intervalMs: 0, timeoutMs: 50, solverUrl: "http://solver", fetchImpl });
    const controller = new AbortController();
    const response = await fetcher.request("source", "https://site.test/", "https://site.test/search", {
      method: "POST",
      body: "q=term",
      signal: controller.signal,
    });
    expect(await response.text()).toBe("results");
    const command = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(command).toEqual({ cmd: "request.post", url: "https://site.test/search", postData: "q=term", maxTimeout: 50 });
    expect(calls[1]!.signal?.aborted).toBe(false);
    await fetcher.request("source", "https://site.test/", "https://site.test/next", {
      headers: { cookie: "session=1", "user-agent": "plugin-agent" },
    });
    expect(calls[2]!.headers.get("cookie")).toBe("session=1; cf_clearance=c");
    expect(calls[2]!.headers.get("user-agent")).toBe("solver-agent");
  });

  it("gives the solver more time than its own maxTimeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== "http://solver") return Promise.resolve(new Response("cf-chl-x", { status: 503 }));
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ status: "ok", solution: { status: 200, response: "late" } })), 60);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    });
    const fetcher = new SourceFetcher({ intervalMs: 0, timeoutMs: 50, solverUrl: "http://solver", fetchImpl });
    const request = fetcher.request("source", "https://site.test/", "https://site.test/a");
    await vi.advanceTimersByTimeAsync(60);
    expect(await (await request).text()).toBe("late");
  });
  it("keeps solving after the caller gives up and stores the cookie for the next request", async () => {
    let finishSolve: (() => void) | undefined;
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url === "http://solver") {
        return new Promise<Response>((resolve) => {
          finishSolve = () =>
            resolve(Response.json({ status: "ok", solution: { status: 200, response: "late", cookies: [{ name: "cf_clearance", value: "kept" }] } }));
        });
      }
      if (calls.filter((call) => call.url !== "http://solver").length === 1) {
        return Promise.resolve(new Response("<title>Just a moment...</title>", { status: 503 }));
      }
      return Promise.resolve(new Response("direct"));
    });
    const fetcher = new SourceFetcher({ intervalMs: 0, solverUrl: "http://solver", fetchImpl });
    const controller = new AbortController();
    const first = fetcher.request("source", "https://site.test/", "https://site.test/a", { signal: controller.signal });
    await vi.waitFor(() => expect(finishSolve).toBeDefined());
    controller.abort();
    await expect(first).rejects.toBeDefined();
    finishSolve!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fetcher.request("source", "https://site.test/", "https://site.test/b");
    expect(calls.at(-1)!.headers.get("cookie")).toBe("cf_clearance=kept");
  });

  it("runs one solve per site and lets concurrent challenged requests retry with its cookie", async () => {
    let finishSolve: (() => void) | undefined;
    let solverCalls = 0;
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://solver") {
        solverCalls += 1;
        return new Promise<Response>((resolve) => {
          finishSolve = () =>
            resolve(Response.json({ status: "ok", solution: { status: 200, response: "solved", cookies: [{ name: "cf_clearance", value: "c" }] } }));
        });
      }
      const cleared = new Headers(init?.headers).get("cookie") === "cf_clearance=c";
      return Promise.resolve(cleared ? new Response(`direct ${url}`) : new Response("cf-chl-x", { status: 503 }));
    });
    const fetcher = new SourceFetcher({ intervalMs: 0, maxInFlight: 3, solverUrl: "http://solver", fetchImpl });
    const first = fetcher.request("source", "https://site.test/", "https://site.test/a");
    await vi.waitFor(() => expect(finishSolve).toBeDefined());
    const second = fetcher.request("source", "https://site.test/", "https://site.test/b");
    const third = fetcher.request("source", "https://site.test/", "https://site.test/c");
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishSolve!();
    expect(await (await first).text()).toBe("solved");
    expect(await (await second).text()).toBe("direct https://site.test/b");
    expect(await (await third).text()).toBe("direct https://site.test/c");
    expect(solverCalls).toBe(1);
  });
});
