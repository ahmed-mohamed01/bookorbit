import type { StorageItem, StorageOp, StorageSnapshot } from "../worker-protocol.ts";

type Emit = (op: StorageOp) => void;

const replace = <T>(target: Record<string, T>, source: Record<string, T>): void => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
};

export class WorkerStorage {
  private readonly items: Record<string, StorageItem> = Object.create(null);
  private readonly local: Record<string, string> = Object.create(null);
  private readonly session: Record<string, string> = Object.create(null);
  private readonly emit: Emit;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  load(snapshot: StorageSnapshot): void {
    replace(this.items, snapshot.storage);
    replace(this.local, snapshot.localStorage);
    replace(this.session, snapshot.sessionStorage);
  }

  module() {
    const items = this.items;
    const emit = this.emit;
    const webStorage = (target: Record<string, string>, store: "localStorage" | "sessionStorage") => ({
      get: () =>
        new Proxy(target, {
          set: (object, key, value) => {
            object[String(key)] = String(value);
            emit({ store, kind: "set", key: String(key), value: String(value) });
            return true;
          },
          deleteProperty: (object, key) => {
            delete object[String(key)];
            emit({ store, kind: "delete", key: String(key) });
            return true;
          },
        }),
    });
    const storage = {
      set: (key: string, value: unknown, expires?: Date | number) => {
        const item: StorageItem = { created: new Date().toISOString(), value };
        if (expires !== undefined) item.expires = expires instanceof Date ? expires.getTime() : expires;
        items[key] = item;
        emit({ store: "storage", kind: "set", key, item });
      },
      get: (key: string, raw?: boolean) => {
        const item = items[key];
        if (item?.expires && Date.now() > item.expires) {
          storage.delete(key);
          return undefined;
        }
        return raw ? item : item?.value;
      },
      getAllKeys: () => Object.keys(items),
      delete: (key: string) => {
        delete items[key];
        emit({ store: "storage", kind: "delete", key });
      },
      clearAll: () => {
        for (const key of Object.keys(items)) delete items[key];
        emit({ store: "storage", kind: "clear" });
      },
    };
    return {
      storage,
      localStorage: webStorage(this.local, "localStorage"),
      sessionStorage: webStorage(this.session, "sessionStorage"),
    };
  }
}
