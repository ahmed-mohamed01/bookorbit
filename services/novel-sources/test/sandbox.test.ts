import { execFile } from "node:child_process";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetcher, runWithDeadline } from "../src/fetcher.js";
import { MAX_STORAGE_BYTES, MAX_STORAGE_KEYS, StorageHub } from "../src/libs/storage.js";
import { syncIfAllowed } from "../src/atomic-write.js";
import { MAX_UPSTREAM_BYTES } from "../src/plugin-pool.js";
import { PluginHost } from "../src/plugin-host.js";
import type { StorageOp } from "../src/worker-protocol.js";
import { makeTempDir, removeTempDirs } from "./support/temp.js";

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const workerPath = resolve(import.meta.dirname, "../src/plugin-worker.ts");
const atomicWritePath = resolve(import.meta.dirname, "../src/atomic-write.ts");

const escapeSource = `
exports.default = {
  id: "escape", name: "Escape", site: "https://escape.test/", version: "1.0.0",
  popularNovels: async () => [], searchNovels: async () => [], parseNovel: async () => ({}),
  parseChapter: async () => {
    const proc = setTimeout.constructor("return process")();
    const attempt = (fn) => { try { fn(); return "allowed"; } catch (error) { return error.code || error.message; } };
    return JSON.stringify({
      env: Object.keys(proc.env).length,
      restoreKill: attempt(() => { proc._kill = () => 0; }),
      kill: attempt(() => proc.kill(proc.pid, 0)),
      rawKill: attempt(() => proc._kill(proc.pid, 0)),
      reallyExit: attempt(() => proc.reallyExit(0)),
      abort: attempt(() => proc.abort()),
      readRoot: attempt(() => proc.getBuiltinModule("fs").readdirSync("/")),
      spawn: attempt(() => proc.getBuiltinModule("child_process").execFileSync("true")),
    });
  },
};`;

const globalsSource = `
exports.default = {
  id: "globals", name: "Globals", site: "https://globals.test/", version: "1.0.0",
  popularNovels: async () => [], searchNovels: async () => [], parseNovel: async () => ({}),
  parseChapter: async (path) => {
    if (path === "big") return "x".repeat(10_000_001);
    if (path === "upstream") return String((await fetch("https://globals.test/huge")).status);
    const response = await fetch("https://globals.test/page");
    return btoa(await response.text()) + "|" + atob("aGk=");
  },
};`;

const blockedProcessFunctions = {
  kill: "process.kill is not available to plugins",
  rawKill: "process._kill is not available to plugins",
  reallyExit: "process.reallyExit is not available to plugins",
  abort: "process.abort is not available to plugins",
};

const hosts: PluginHost[] = [];

// The flags come from the image's CMD, with the image paths mapped onto this checkout, so editing the Dockerfile
// changes what this test runs.
const imageNodeFlags = async (dataDir: string): Promise<string[]> => {
  const dockerfile = await readFile(resolve(import.meta.dirname, "../Dockerfile"), "utf8");
  const cmd = dockerfile.match(/^CMD (\[.*\])$/mu)?.[1];
  if (!cmd) throw new Error("Dockerfile has no exec-form CMD");
  const [shell, , script] = JSON.parse(cmd) as string[];
  if (shell !== "sh" || typeof script !== "string") throw new Error("Dockerfile CMD is not an sh -c command");
  const command = script.match(/^exec node (.*) dist\/main\.js$/u)?.[1];
  if (!command) throw new Error("Dockerfile CMD does not start dist/main.js with node");
  let allowNet = false;
  try {
    await run(process.execPath, ["--allow-net", "-e", ""]);
    allowNet = true;
  } catch {
    allowNet = false;
  }
  return command
    .replace(/\$\(node --allow-net -e '' 2>\/dev\/null && echo --allow-net\)/u, allowNet ? "--allow-net" : "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((flag) => flag.replace(/=\/app$/u, `=${repoRoot}`).replace(/=\/data$/u, `=${dataDir}`));
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await removeTempDirs();
});

const load = async (source: string, id: string, fetchImpl: typeof fetch = vi.fn(async () => new Response("ok"))) => {
  const host = new PluginHost({ dataDir: await makeTempDir(), fetcher: new SourceFetcher({ intervalMs: 0, fetchImpl }) });
  hosts.push(host);
  return host.loadSource(source, id);
};

describe("plugin sandbox", () => {
  it("starts workers without the service environment and blocks every way to end or signal the process", async () => {
    process.env.NOVEL_SOURCES_SANDBOX_PROBE = "secret";
    try {
      const plugin = await load(escapeSource, "escape");
      const result = JSON.parse(await runWithDeadline(5_000, () => plugin.parseChapter("x"))) as Record<string, unknown>;
      expect(result.env).toBe(0);
      expect(result).toMatchObject(blockedProcessFunctions);
    } finally {
      delete process.env.NOVEL_SOURCES_SANDBOX_PROBE;
    }
  });

  it("provides atob, btoa and a fetch that goes through the source limiter", async () => {
    const fetchImpl = vi.fn(async () => new Response("page"));
    const plugin = await load(globalsSource, "globals", fetchImpl as unknown as typeof fetch);
    expect(await runWithDeadline(5_000, () => plugin.parseChapter("x"))).toBe(`${btoa("page")}|hi`);
    expect(fetchImpl).toHaveBeenCalledWith("https://globals.test/page", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("caps chapter html and upstream bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(MAX_UPSTREAM_BYTES + 1)));
    const plugin = await load(globalsSource, "globals", fetchImpl as unknown as typeof fetch);
    await expect(runWithDeadline(10_000, () => plugin.parseChapter("big"))).rejects.toThrow("Chapter content is too large");
    await expect(runWithDeadline(10_000, () => plugin.parseChapter("upstream"))).rejects.toThrow("Upstream response is too large");
  });

  it("denies file system reads and child processes under the image's permission flags", async () => {
    const dataDir = await realpath(await makeTempDir());
    const runner = join(dataDir, "runner.mjs");
    await writeFile(
      runner,
      `import { Worker } from "node:worker_threads";
const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(workerPath).href)}), {
  env: {},
  workerData: { source: ${JSON.stringify(escapeSource)}, filename: "escape.js", expectedId: "escape", siteHint: "" },
});
worker.on("message", (message) => {
  if (message.type === "boot") {
    worker.postMessage({ type: "call", callId: 1, method: "parseChapter", args: ["x"], storage: { storage: {}, localStorage: {}, sessionStorage: {} } });
  } else if (message.type === "result" || message.type === "error") {
    console.log(JSON.stringify(message));
    process.exit(0);
  }
});`,
    );
    const { stdout } = await run(process.execPath, [...(await imageNodeFlags(dataDir)), runner]);
    const message = JSON.parse(stdout.trim()) as { type: string; value: string };
    expect(message.type).toBe("result");
    expect(JSON.parse(message.value)).toMatchObject({ readRoot: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", ...blockedProcessFunctions });
  });
  it("writes files atomically under the image's permission flags, where fsync is refused", async () => {
    const dataDir = await realpath(await makeTempDir());
    const runner = join(dataDir, "write.mjs");
    const target = join(dataDir, "installed.json");
    await writeFile(
      runner,
      `import { writeFileAtomic } from ${JSON.stringify(pathToFileURL(atomicWritePath).href)};
await writeFileAtomic(${JSON.stringify(target)}, "[]\\n");
console.log("written");`,
    );
    const { stdout } = await run(process.execPath, [...(await imageNodeFlags(dataDir)), runner]);
    expect(stdout.trim()).toBe("written");
    expect(await readFile(target, "utf8")).toBe("[]\n");
  });

  it("treats a refused fsync as written and still reports other fsync failures", async () => {
    const refused = Object.assign(new Error("fsync API is disabled"), { code: "ERR_ACCESS_DENIED" });
    await expect(syncIfAllowed({ sync: () => Promise.reject(refused) })).resolves.toBeUndefined();
    const failed = Object.assign(new Error("disk failed"), { code: "EIO" });
    await expect(syncIfAllowed({ sync: () => Promise.reject(failed) })).rejects.toThrow("disk failed");
  });
});

describe("StorageHub", () => {
  const hub = async () => {
    const basePath = await makeTempDir();
    return { basePath, hub: new StorageHub(basePath) };
  };

  it("rejects unknown store names and never pollutes prototypes", async () => {
    const { hub: storage } = await hub();
    expect(storage.apply({ store: "__proto__", kind: "set", key: "polluted", value: "yes" } as unknown as StorageOp)).toBe(false);
    expect(storage.apply({ store: "constructor", kind: "clear" } as unknown as StorageOp)).toBe(false);
    expect(storage.apply({ store: "localStorage", kind: "set", key: "__proto__", value: "x" })).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(storage.snapshot().localStorage)).toBeNull();
    expect(storage.snapshot().localStorage["__proto__"]).toBe("x");
  });

  it("bounds keys and bytes and writes atomically", async () => {
    const { basePath, hub: storage } = await hub();
    for (let index = 0; index <= MAX_STORAGE_KEYS; index += 1) {
      storage.apply({ store: "localStorage", kind: "set", key: `k${index}`, value: "v" });
    }
    const keys = Object.keys(storage.snapshot().localStorage);
    expect(keys).toHaveLength(MAX_STORAGE_KEYS);
    expect(keys[0]).toBe("k1");
    expect(storage.apply({ store: "localStorage", kind: "set", key: "huge", value: "x".repeat(MAX_STORAGE_BYTES) })).toBe(false);
    expect(storage.snapshot().localStorage.huge).toBeUndefined();
    expect(await readdir(basePath)).toEqual(["local-storage.json"]);
    const persisted = JSON.parse(await readFile(join(basePath, "local-storage.json"), "utf8")) as Array<[string, string]>;
    expect(persisted).toHaveLength(MAX_STORAGE_KEYS);
  });

  it("drops the oldest entries to make room when a store reaches its byte cap", async () => {
    const { basePath, hub: storage } = await hub();
    const big = "x".repeat(Math.floor(MAX_STORAGE_BYTES / 5));
    for (const key of ["9", "10", "1", "a", "b"]) {
      expect(storage.apply({ store: "localStorage", kind: "set", key, value: big })).toBe(true);
    }
    expect(new Set(Object.keys(storage.snapshot().localStorage))).toEqual(new Set(["10", "1", "a", "b"]));
    expect(storage.apply({ store: "localStorage", kind: "set", key: "c", value: big })).toBe(true);
    expect(new Set(Object.keys(storage.snapshot().localStorage))).toEqual(new Set(["1", "a", "b", "c"]));
    const reloaded = new StorageHub(basePath);
    expect(reloaded.apply({ store: "localStorage", kind: "set", key: "d", value: big })).toBe(true);
    expect(new Set(Object.keys(reloaded.snapshot().localStorage))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("refuses a value JSON cannot encode instead of throwing", async () => {
    const logger = { error: vi.fn() };
    const storage = new StorageHub(await makeTempDir(), logger);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(storage.apply({ store: "localStorage", kind: "set", key: "k", value: circular as unknown as string })).toBe(false);
    expect(storage.snapshot().localStorage.k).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("[novel_sources.storage] [fail] durationMs="));
    expect(storage.apply({ store: "localStorage", kind: "set", key: "k", value: "ok" })).toBe(true);
  });

  it("returns false and logs when the store cannot be written to disk", async () => {
    const dir = await makeTempDir();
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    const logger = { error: vi.fn() };
    const storage = new StorageHub(join(blocker, "source"), logger);
    expect(storage.apply({ store: "localStorage", kind: "set", key: "k", value: "v" })).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/errorClass=Error error=".*" - storage write failed/u));
  });

  it("keeps the service running when a plugin stores a circular object", async () => {
    const plugin = await load(
      `const { storage } = require("@libs/storage");
exports.default = {
  id: "cycle", name: "Cycle", site: "https://cycle.test/", version: "1.0.0",
  popularNovels: async () => [], searchNovels: async () => [], parseNovel: async () => ({}),
  parseChapter: async () => { const o = {}; o.self = o; storage.set("k", o); return "<p>ok</p>"; },
};`,
      "cycle",
    );
    expect(await runWithDeadline(5_000, () => plugin.parseChapter("x"))).toBe("<p>ok</p>");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await runWithDeadline(5_000, () => plugin.parseChapter("x"))).toBe("<p>ok</p>");
  });

  it("drops the oldest key at the key cap even when keys look like numbers", async () => {
    const { hub: storage } = await hub();
    for (let index = MAX_STORAGE_KEYS; index >= 0; index -= 1) {
      storage.apply({ store: "localStorage", kind: "set", key: String(index), value: "v" });
    }
    const keys = Object.keys(storage.snapshot().localStorage);
    expect(keys).toHaveLength(MAX_STORAGE_KEYS);
    expect(keys).not.toContain(String(MAX_STORAGE_KEYS));
    expect(keys).toContain("0");
  });
});
