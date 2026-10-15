import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { gcm } from "@noble/ciphers/aes.js";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import * as htmlparser2 from "htmlparser2";
import { FilterTypes, NovelStatus, defaultCover, isUrlAbsolute } from "./libs/constants.ts";
import { errorFromWire } from "./libs/errors.ts";
import { buildFetchModule } from "./libs/fetch-module.ts";
import { WorkerStorage } from "./libs/worker-storage.ts";
import type { CallMethod, ToMain, ToWorker, WireBody, WireInit, WorkerData } from "./worker-protocol.ts";

const REQUIRED_METHODS = ["popularNovels", "searchNovels", "parseNovel", "parseChapter"] as const;
const MAX_CHAPTER_CHARS = 10_000_000;

// The VM is not a security boundary: any host function leads back to this process object, so remove what a plugin
// could use against the service itself. The permission model and the container stop file system and process access.
// process._kill is the raw binding behind kill, and reallyExit sits behind exit; both stay reachable otherwise.
const endThread = (process as unknown as { reallyExit: (code: number) => void }).reallyExit.bind(process);
for (const name of ["kill", "_kill", "reallyExit", "abort", "dlopen"] as const) {
  Object.defineProperty(process, name, {
    configurable: false,
    writable: false,
    value: () => {
      throw new Error(`process.${name} is not available to plugins`);
    },
  });
}

const port = parentPort!;
const data = workerData as WorkerData;
const send = (message: ToMain, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

let currentCallId = 0;
let nextRequestId = 1;
const pendingFetches = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();

const toBytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    : new Uint8Array(value.slice(0));

const serializeBody = async (body: unknown): Promise<WireBody | undefined> => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return { kind: "text", value: body };
  if (body instanceof URLSearchParams) return { kind: "text", value: body.toString() };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { kind: "bytes", value: toBytes(body) };
  if (body instanceof FormData) {
    const entries: Array<[string, string | { name: string; type: string; bytes: Uint8Array }]> = [];
    for (const [name, value] of body.entries()) {
      entries.push([
        name,
        typeof value === "string" ? value : { name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) },
      ]);
    }
    return { kind: "form", entries };
  }
  return { kind: "text", value: String(body) };
};

const serializeInit = async (init: RequestInit | undefined): Promise<WireInit> => {
  const headers = [...new Headers(init?.headers).entries()];
  const body = await serializeBody(init?.body);
  return {
    ...(init?.method ? { method: init.method } : {}),
    headers,
    ...(body ? { body } : {}),
  };
};

const fetchViaMain = async (url: string, init?: RequestInit): Promise<Response> => {
  const wireInit = await serializeInit(init);
  const requestId = nextRequestId++;
  return new Promise<Response>((resolve, reject) => {
    pendingFetches.set(requestId, { resolve, reject });
    send({ type: "fetch", callId: currentCallId, requestId, url: String(url), init: wireInit });
  });
};

const storage = new WorkerStorage((op) => send({ type: "storage", op }));

const pluginConsole = {
  log: (...values: unknown[]) => send({ type: "log", level: "log", text: values.map(String).join(" ") }),
  warn: (...values: unknown[]) => send({ type: "log", level: "warn", text: values.map(String).join(" ") }),
  error: (...values: unknown[]) => send({ type: "log", level: "error", text: values.map(String).join(" ") }),
};

const modules: Record<string, unknown> = {
  "@libs/fetch": buildFetchModule(fetchViaMain),
  "@libs/storage": storage.module(),
  "@libs/aes": { gcm },
  "@libs/filterInputs": { FilterTypes },
  "@libs/novelStatus": { NovelStatus },
  "@libs/defaultCover": { defaultCover },
  "@libs/isAbsoluteUrl": { isUrlAbsolute },
  "@/types/constants": { NovelStatus, defaultCover },
  cheerio,
  htmlparser2,
  dayjs,
};

interface LoadedPlugin {
  id: string;
  name: string;
  site: string;
  version: string;
  filters?: Record<string, unknown>;
  resolveUrl?: (path: string, isNovel?: boolean) => string;
  [method: string]: unknown;
}

const loadPlugin = (): LoadedPlugin => {
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = vm.createContext({
    module: moduleObject,
    exports: exportsObject,
    require: (name: string) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Module is not allowed: ${name}`);
      return modules[name];
    },
    console: pluginConsole,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    atob,
    btoa,
    fetch: (input: unknown, init?: RequestInit) => fetchViaMain(String(input), init),
    Buffer,
    FormData,
    Headers,
  });
  new vm.Script(data.source, { filename: data.filename }).runInContext(context, { timeout: 5_000 });
  const exported = moduleObject.exports as Record<string, unknown>;
  const plugin = (exported.default ?? exported) as Partial<LoadedPlugin>;
  if (!plugin || typeof plugin !== "object") throw new Error("Plugin has no default export");
  if (!plugin.id || !plugin.name || !plugin.site || !plugin.version) throw new Error("Plugin metadata is incomplete");
  if (data.expectedId && plugin.id !== data.expectedId) throw new Error(`Plugin id ${plugin.id} does not match ${data.expectedId}`);
  for (const method of REQUIRED_METHODS) {
    if (typeof plugin[method] !== "function") throw new Error(`Plugin is missing ${method}`);
  }
  return plugin as LoadedPlugin;
};

const resolvedUrl = (plugin: LoadedPlugin, path: string, isNovel: boolean): string =>
  new URL(plugin.resolveUrl!(path, isNovel), plugin.site).toString();

const annotateItems = (plugin: LoadedPlugin, items: unknown): unknown => {
  if (!plugin.resolveUrl || !Array.isArray(items)) return items;
  return items.map((item: { path: string }) => ({ ...item, resolvedUrl: resolvedUrl(plugin, item.path, true) }));
};

const annotateChapters = (plugin: LoadedPlugin, holder: unknown, isNovel: boolean): unknown => {
  if (!plugin.resolveUrl || !holder || typeof holder !== "object") return holder;
  const value = holder as { path?: string; chapters?: Array<{ path: string }> };
  return {
    ...value,
    ...(isNovel && value.path ? { resolvedUrl: resolvedUrl(plugin, value.path, true) } : {}),
    chapters: (value.chapters ?? []).map((chapter) => ({ ...chapter, resolvedUrl: resolvedUrl(plugin, chapter.path, false) })),
  };
};

const runCall = async (plugin: LoadedPlugin, method: CallMethod, args: unknown[]): Promise<unknown> => {
  const invoke = plugin[method];
  if (typeof invoke !== "function") throw new Error(`Plugin does not support ${method}`);
  const value: unknown = await invoke.apply(plugin, args);
  if (method === "popularNovels" || method === "searchNovels") return annotateItems(plugin, value);
  if (method === "parseNovel") return annotateChapters(plugin, value, true);
  if (method === "parsePage") return annotateChapters(plugin, value, false);
  if (method === "parseChapter" && typeof value === "string" && value.length > MAX_CHAPTER_CHARS) {
    throw new Error("Chapter content is too large");
  }
  return value;
};

const describeError = (error: unknown): { name: string; message: string } => {
  const candidate = error as { name?: unknown; message?: unknown } | null;
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
};

let plugin: LoadedPlugin;
try {
  plugin = loadPlugin();
  send({
    type: "boot",
    ok: true,
    meta: {
      id: plugin.id,
      name: plugin.name,
      site: plugin.site,
      version: plugin.version,
      filters: plugin.filters,
      pagedChapters: typeof plugin.parsePage === "function",
    },
  });
} catch (error) {
  send({ type: "boot", ok: false, message: describeError(error).message });
  endThread(0);
}

port.on("message", (message: ToWorker) => {
  if (message.type === "fetchResult") {
    const pending = pendingFetches.get(message.requestId);
    pendingFetches.delete(message.requestId);
    const noBody = message.status === 204 || message.status === 205 || message.status === 304 || message.body.byteLength === 0;
    pending?.resolve(
      new Response(noBody ? null : message.body, { status: message.status, statusText: message.statusText, headers: message.headers }),
    );
    return;
  }
  if (message.type === "fetchError") {
    const pending = pendingFetches.get(message.requestId);
    pendingFetches.delete(message.requestId);
    pending?.reject(errorFromWire(message.name, message.message));
    return;
  }
  currentCallId = message.callId;
  storage.load(message.storage);
  runCall(plugin, message.method, message.args).then(
    (value) => {
      try {
        send({ type: "result", callId: message.callId, value });
      } catch {
        send({ type: "error", callId: message.callId, name: "Error", message: "Plugin returned data that cannot be transferred" });
      }
    },
    (error: unknown) => send({ type: "error", callId: message.callId, ...describeError(error) }),
  );
});
