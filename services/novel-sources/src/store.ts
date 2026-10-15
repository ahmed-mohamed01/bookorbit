import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { readCappedText } from "./libs/read-capped.js";
import type { PluginHost } from "./plugin-host.js";
import type { IndexEntry, InstalledEntry, NovelPlugin } from "./types.js";
import { ServiceError, sanitizeMessage } from "./types.js";

const HOUR_MS = 60 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_INDEX_BYTES = 10_000_000;
export const MAX_PLUGIN_BYTES = 5_000_000;

const sha256 = (source: string): string => createHash("sha256").update(source).digest("hex");

const isIndexEntry = (value: unknown): value is IndexEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["id", "name", "site", "lang", "version", "url", "iconUrl"].every((key) => typeof entry[key] === "string");
};

const compareVersions = (left: string, right: string): number => {
  const a = left.split(/[.-]/);
  const b = right.split(/[.-]/);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? "0";
    const bv = b[index] ?? "0";
    const an = Number(av);
    const bn = Number(bv);
    const result = Number.isNaN(an) || Number.isNaN(bn) ? av.localeCompare(bv) : an - bn;
    if (result !== 0) return result;
  }
  return 0;
};

export interface SourceStoreOptions {
  dataDir: string;
  indexUrl: string;
  host: PluginHost;
  fetchImpl?: typeof fetch;
  now?: () => number;
  downloadTimeoutMs?: number;
  safeMode?: boolean;
  logger?: Pick<Console, "error">;
}

export class SourceStore {
  private readonly installed = new Map<string, InstalledEntry>();
  private readonly plugins = new Map<string, NovelPlugin>();
  private readonly broken = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private index?: IndexEntry[];
  private indexLoadedAt = 0;

  constructor(private readonly options: SourceStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.pluginsDir, { recursive: true });
    await mkdir(join(this.options.dataDir, "storage"), { recursive: true });
    const entries = await this.readManifest();
    for (const entry of entries) {
      if (!this.isSafeIdentifier(entry?.id) || !this.isSafeIdentifier(entry.version)) {
        this.logLoadFailure("-", Date.now(), new Error("Installed plugin manifest contains an unsafe identifier"));
        continue;
      }
      this.installed.set(entry.id, entry);
      const startedAt = Date.now();
      if (this.options.safeMode) {
        this.broken.add(entry.id);
        this.logLoadFailure(entry.id, startedAt, new Error("Safe mode: installed sources are not loaded"));
        continue;
      }
      try {
        this.plugins.set(entry.id, await this.loadInstalled(entry));
      } catch (error) {
        this.broken.add(entry.id);
        this.logLoadFailure(entry.id, startedAt, error);
      }
    }
  }

  // A manifest cut short by a power loss must not keep the service from starting: fall back to the backup written
  // with every change, and to an empty list when that is unreadable too.
  private async readManifest(): Promise<InstalledEntry[]> {
    for (const path of [this.installedPath, this.backupPath]) {
      const startedAt = Date.now();
      try {
        const entries = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (!Array.isArray(entries)) throw new Error("manifest is not an array");
        return entries as InstalledEntry[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        (this.options.logger ?? console).error(
          `[novel_sources.read_manifest] [fail] source=- durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : "Error"} error="${sanitizeMessage(error)}" file=${path === this.installedPath ? "installed" : "backup"} - installed source manifest unreadable`,
        );
      }
    }
    return [];
  }

  private async loadInstalled(entry: InstalledEntry): Promise<NovelPlugin> {
    const source = await readFile(this.pluginPath(entry.id, entry.version), "utf8");
    if (sha256(source) !== entry.sha256) throw new Error("Installed plugin checksum mismatch");
    const plugin = await this.options.host.loadSource(source, entry.id);
    if (plugin.version !== entry.version) {
      await plugin.dispose?.();
      throw new Error("Installed plugin version mismatch");
    }
    return plugin;
  }

  private logLoadFailure(id: string, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : "Error";
    (this.options.logger ?? console).error(
      `[novel_sources.load_installed] [fail] source=${id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeMessage(error)}" - installed source skipped`,
    );
  }

  isBroken(id: string): boolean {
    return this.broken.has(id);
  }

  get installedCount(): number {
    return this.installed.size;
  }

  get loadedCount(): number {
    return this.plugins.size;
  }

  get brokenCount(): number {
    return this.broken.size;
  }

  listInstalled(): Array<InstalledEntry & { filters: Record<string, unknown>; broken: boolean }> {
    return [...this.installed.values()].map((entry) => {
      const filters = this.plugins.get(entry.id)?.filters;
      return { ...entry, filters: filters ?? {}, broken: this.broken.has(entry.id) };
    });
  }

  getPlugin(id: string): NovelPlugin | undefined {
    return this.plugins.get(id);
  }

  async listAvailable(lang?: string) {
    const entries = await this.getIndex();
    return entries
      .filter((entry) => !lang || entry.lang === lang)
      .map((entry) => {
        const installed = this.installed.get(entry.id);
        return {
          ...entry,
          installed: Boolean(installed),
          installedVersion: installed?.version ?? null,
          updateAvailable: installed ? compareVersions(entry.version, installed.version) > 0 : false,
        };
      });
  }

  install(id: string): Promise<InstalledEntry> {
    return this.withLock(id, async () => this.installEntry(await this.findIndexEntry(id)));
  }

  update(id: string): Promise<InstalledEntry> {
    return this.withLock(id, async () => {
      const current = this.installed.get(id);
      if (!current) throw new ServiceError("Source is not installed", 409);
      const entry = await this.findIndexEntry(id);
      if (compareVersions(entry.version, current.version) <= 0) return current;
      return this.installEntry(entry, current);
    });
  }

  remove(id: string): Promise<void> {
    return this.withLock(id, async () => {
      const entry = this.installed.get(id);
      if (!entry) throw new ServiceError("Source is not installed", 409);
      this.installed.delete(id);
      this.broken.delete(id);
      await this.plugins.get(id)?.dispose?.();
      this.plugins.delete(id);
      await this.writeInstalled();
      await unlink(this.pluginPath(id, entry.version)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await this.options.host.removeStorage(id);
    });
  }

  // Install, update and remove of one source run one at a time, so a remove that lands during an update download
  // is not undone when the update finishes.
  private withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return result;
  }

  async getIndex(): Promise<IndexEntry[]> {
    if (this.index && this.now() - this.indexLoadedAt < HOUR_MS) return this.index;
    const cached = await this.readFreshCache();
    if (cached) return cached;
    try {
      const response = await this.download(this.options.indexUrl);
      if (!response.ok) throw new Error(`Index returned HTTP ${response.status}`);
      const value = JSON.parse(await readCappedText(response, MAX_INDEX_BYTES)) as unknown;
      if (!Array.isArray(value) || !value.every(isIndexEntry)) {
        throw new Error("Index response is invalid");
      }
      this.index = value;
      this.indexLoadedAt = this.now();
      await this.writeAtomic(this.indexPath, `${JSON.stringify(value)}\n`);
      return value;
    } catch (error) {
      const stale = await this.readJson<unknown>(this.indexPath, undefined);
      if (Array.isArray(stale) && stale.every(isIndexEntry)) {
        this.index = stale;
        this.indexLoadedAt = this.now();
        return stale;
      }
      throw new ServiceError("Source index refresh failed", 502, "SITE_FAILED", {
        cause: error,
      });
    }
  }

  private async installEntry(entry: IndexEntry, previous?: InstalledEntry): Promise<InstalledEntry> {
    if (!this.isSafeIdentifier(entry.id) || !this.isSafeIdentifier(entry.version)) {
      throw new ServiceError("Index contains an unsafe plugin identifier", 502, "PLUGIN_ERROR");
    }
    let source: string;
    try {
      const response = await this.download(entry.url);
      if (!response.ok) throw new Error(`Plugin download returned HTTP ${response.status}`);
      source = await readCappedText(response, MAX_PLUGIN_BYTES);
    } catch (error) {
      throw new ServiceError(sanitizeMessage(error), 502, "SITE_FAILED", { cause: error });
    }
    const plugin = await this.options.host.loadSource(source, entry.id);
    if (plugin.version !== entry.version) {
      await plugin.dispose?.();
      throw new ServiceError("Plugin version does not match the index", 502, "PLUGIN_ERROR");
    }
    try {
      await this.writeAtomic(this.pluginPath(entry.id, entry.version), source);
    } catch (error) {
      await plugin.dispose?.();
      throw error;
    }
    const installed: InstalledEntry = {
      id: entry.id,
      name: entry.name,
      site: entry.site,
      lang: entry.lang,
      version: entry.version,
      sha256: sha256(source),
      installedAt: new Date(this.now()).toISOString(),
    };
    this.installed.set(entry.id, installed);
    this.broken.delete(entry.id);
    const replaced = this.plugins.get(entry.id);
    this.plugins.set(entry.id, plugin);
    await replaced?.dispose?.();
    await this.writeInstalled();
    if (previous && previous.version !== entry.version) {
      await unlink(this.pluginPath(previous.id, previous.version)).catch(() => undefined);
    }
    return installed;
  }

  private async findIndexEntry(id: string): Promise<IndexEntry> {
    const entry = (await this.getIndex()).find((candidate) => candidate.id === id);
    if (!entry) throw new ServiceError("Unknown source", 404);
    return entry;
  }

  private async readFreshCache(): Promise<IndexEntry[] | undefined> {
    try {
      const details = await stat(this.indexPath);
      if (this.now() - details.mtimeMs >= HOUR_MS) return undefined;
      const value = await this.readJson<unknown>(this.indexPath, undefined);
      if (!Array.isArray(value) || !value.every(isIndexEntry)) return undefined;
      this.index = value;
      this.indexLoadedAt = details.mtimeMs;
      return value;
    } catch {
      return undefined;
    }
  }

  // The backup is written first, so a crash while the manifest is replaced leaves a complete backup behind.
  private async writeInstalled(): Promise<void> {
    const content = `${JSON.stringify([...this.installed.values()], null, 2)}\n`;
    await this.writeAtomic(this.backupPath, content);
    await this.writeAtomic(this.installedPath, content);
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await writeFileAtomic(path, content);
  }

  private download(url: string): Promise<Response> {
    return this.fetchImpl(url, { signal: AbortSignal.timeout(this.options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS) });
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private pluginPath(id: string, version: string): string {
    return join(this.pluginsDir, `${id}@${version}.js`);
  }

  private isSafeIdentifier(value: unknown): value is string {
    return typeof value === "string" && /^[\w.-]+$/u.test(value);
  }

  private get pluginsDir(): string {
    return join(this.options.dataDir, "plugins");
  }

  private get installedPath(): string {
    return join(this.options.dataDir, "installed.json");
  }

  private get backupPath(): string {
    return join(this.options.dataDir, "installed.json.bak");
  }

  private get indexPath(): string {
    return join(this.options.dataDir, "plugins-index.json");
  }
}
