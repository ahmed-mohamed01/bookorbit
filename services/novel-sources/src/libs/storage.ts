import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeMessage } from "../types.js";
import { STORAGE_NAMES, type StorageName, type StorageOp, type StorageSnapshot } from "../worker-protocol.js";

export const MAX_STORAGE_KEYS = 1_000;
export const MAX_STORAGE_BYTES = 1_000_000;

const FILE_NAMES: Record<StorageName, string> = {
  storage: "storage",
  localStorage: "local-storage",
  sessionStorage: "session-storage",
};

type Store = Map<string, unknown>;

// Stores persist as an entry list so insertion order survives a restart even for keys that look like numbers.
const readStore = (path: string): Store => {
  const target: Store = new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string") target.set(entry[0], entry[1]);
      }
    } else if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) target.set(key, value);
    }
  } catch {
    // A missing or unreadable file starts the store empty.
  }
  return target;
};

const entryBytes = (key: string, value: unknown): number => Buffer.byteLength(JSON.stringify([key, value])) + 1;

const serialize = (store: Store): string => `${JSON.stringify([...store])}\n`;

const toRecord = (store: Store): Record<string, unknown> => {
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, value] of store) record[key] = value;
  return record;
};

const persist = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

const isStorageName = (value: unknown): value is StorageName => STORAGE_NAMES.includes(value as StorageName);

// The main thread owns plugin storage so every worker of a source sees one persisted copy.
// Ops arrive from untrusted plugin code, so each one is validated and each store is bounded: a full store drops
// its oldest entries to make room, and only a single entry larger than the whole cap is refused.
export class StorageHub {
  private readonly stores: Record<StorageName, Store>;
  private cached: StorageSnapshot | undefined;

  constructor(
    private readonly basePath: string,
    private readonly logger: Pick<Console, "error"> = console,
  ) {
    this.stores = {
      storage: readStore(this.pathFor("storage")),
      localStorage: readStore(this.pathFor("localStorage")),
      sessionStorage: readStore(this.pathFor("sessionStorage")),
    };
  }

  snapshot(): StorageSnapshot {
    this.cached ??= {
      storage: toRecord(this.stores.storage) as StorageSnapshot["storage"],
      localStorage: toRecord(this.stores.localStorage) as StorageSnapshot["localStorage"],
      sessionStorage: toRecord(this.stores.sessionStorage) as StorageSnapshot["sessionStorage"],
    };
    return this.cached;
  }

  // A value JSON cannot encode or a failed disk write must never throw: this runs in a worker message listener,
  // where a throw is an uncaught exception that ends the whole service.
  apply(op: StorageOp): boolean {
    const startedAt = Date.now();
    try {
      return this.applyUnsafe(op);
    } catch (error) {
      this.cached = undefined;
      const errorClass = error instanceof Error ? error.name : "Error";
      this.logger.error(
        `[novel_sources.storage] [fail] durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeMessage(error)}" - storage write failed`,
      );
      return false;
    }
  }

  private applyUnsafe(op: StorageOp): boolean {
    const candidate = op as { store?: unknown; kind?: unknown; key?: unknown };
    if (!isStorageName(candidate.store)) return false;
    if (candidate.kind !== "clear" && typeof candidate.key !== "string") return false;
    const target = this.stores[candidate.store];
    if (op.kind === "set") {
      const value = op.store === "storage" ? op.item : op.value;
      if (entryBytes(op.key, value) + 3 > MAX_STORAGE_BYTES) return false;
      target.delete(op.key);
      target.set(op.key, value);
      this.evictOldest(target);
    } else if (op.kind === "delete") target.delete(op.key);
    else if (op.kind === "clear") target.clear();
    else return false;
    this.cached = undefined;
    persist(this.pathFor(candidate.store), serialize(target));
    return true;
  }

  private evictOldest(target: Store): void {
    let bytes = 3;
    for (const [key, value] of target) bytes += entryBytes(key, value);
    for (const [key, value] of target) {
      if (target.size <= MAX_STORAGE_KEYS && bytes <= MAX_STORAGE_BYTES) return;
      target.delete(key);
      bytes -= entryBytes(key, value);
    }
  }

  private pathFor(store: StorageName): string {
    return `${this.basePath}/${FILE_NAMES[store]}.json`;
  }
}
