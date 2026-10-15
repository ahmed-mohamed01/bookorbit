import { SourceFetcher } from "./fetcher.js";
import { DEFAULT_MAX_WORKERS, DEFAULT_WORKER_HEAP_MB, PluginHost } from "./plugin-host.js";
import { NOVEL_WAIT_MS, createNovelSourcesServer } from "./server.js";
import { SourceStore } from "./store.js";

const DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";

const token = process.env.NOVEL_SOURCES_TOKEN;
if (!token?.trim()) throw new Error("NOVEL_SOURCES_TOKEN is required");

const integerEnv = (name: string, fallback: number, minimum: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} is invalid`);
  return value;
};

const dataDir = process.env.NOVEL_SOURCES_DATA_DIR ?? "/data";
const port = integerEnv("PORT", 8282, 1);
if (port > 65_535) throw new Error("PORT is invalid");

const fetcher = new SourceFetcher({
  ...(process.env.NOVEL_SOURCES_SOLVER_URL ? { solverUrl: process.env.NOVEL_SOURCES_SOLVER_URL } : {}),
  intervalMs: integerEnv("NOVEL_SOURCES_REQUEST_INTERVAL_MS", 1_500, 0),
  maxInFlight: integerEnv("NOVEL_SOURCES_MAX_IN_FLIGHT", 2, 1),
  timeoutMs: integerEnv("NOVEL_SOURCES_FETCH_TIMEOUT_MS", 20_000, 1),
});
const host = new PluginHost({
  dataDir,
  fetcher,
  maxWorkers: integerEnv("NOVEL_SOURCES_MAX_WORKERS", DEFAULT_MAX_WORKERS, 1),
  workerHeapMb: integerEnv("NOVEL_SOURCES_WORKER_HEAP_MB", DEFAULT_WORKER_HEAP_MB, 16),
});
const safeMode = process.env.NOVEL_SOURCES_SAFE_MODE === "1" || process.env.NOVEL_SOURCES_SAFE_MODE === "true";
const store = new SourceStore({
  dataDir,
  host,
  indexUrl: process.env.NOVEL_SOURCES_INDEX_URL ?? DEFAULT_INDEX_URL,
  safeMode,
});
await store.initialize();

const server = createNovelSourcesServer({
  token,
  store,
  solver: Boolean(process.env.NOVEL_SOURCES_SOLVER_URL),
  novelWaitMs: integerEnv("NOVEL_SOURCES_NOVEL_WAIT_MS", NOVEL_WAIT_MS, 0),
});
const shutdown = (): void => {
  server.close();
  void host.close().finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(port, "0.0.0.0", () => {
  console.log(
    `[novel_sources.server] [end] source=- durationMs=0 port=${port} installed=${store.installedCount} loaded=${store.loadedCount} safeMode=${safeMode} permission=${Boolean(process.permission)} - server started`,
  );
});
