import type { FilterDefinition } from "./types.ts";

export interface StorageItem {
  created: string;
  value: unknown;
  expires?: number;
}

export interface StorageSnapshot {
  storage: Record<string, StorageItem>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export type StorageOp =
  | { store: "storage"; kind: "set"; key: string; item: StorageItem }
  | { store: "localStorage" | "sessionStorage"; kind: "set"; key: string; value: string }
  | { kind: "delete"; store: "storage" | "localStorage" | "sessionStorage"; key: string }
  | { kind: "clear"; store: "storage" | "localStorage" | "sessionStorage" };

export type WireBody =
  | { kind: "text"; value: string }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "form"; entries: Array<[string, string | { name: string; type: string; bytes: Uint8Array }]> };

export interface WireInit {
  method?: string;
  headers: Array<[string, string]>;
  body?: WireBody;
}

export type CallMethod = "popularNovels" | "searchNovels" | "parseNovel" | "parseChapter" | "parsePage";

export const STORAGE_NAMES = ["storage", "localStorage", "sessionStorage"] as const;

export type StorageName = (typeof STORAGE_NAMES)[number];

export interface WorkerData {
  source: string;
  filename: string;
  expectedId: string | undefined;
  siteHint: string;
}

export interface PluginMeta {
  id: string;
  name: string;
  site: string;
  version: string;
  filters: FilterDefinition | undefined;
  pagedChapters: boolean;
}

export type ToMain =
  | { type: "boot"; ok: true; meta: PluginMeta }
  | { type: "boot"; ok: false; message: string }
  | { type: "result"; callId: number; value: unknown }
  | { type: "error"; callId: number; name: string; message: string }
  | { type: "fetch"; callId: number; requestId: number; url: string; init: WireInit }
  | { type: "storage"; op: StorageOp }
  | { type: "log"; level: "log" | "warn" | "error"; text: string };

export type ToWorker =
  | { type: "call"; callId: number; method: CallMethod; args: unknown[]; storage: StorageSnapshot }
  | { type: "fetchResult"; requestId: number; status: number; statusText: string; headers: Array<[string, string]>; body: ArrayBuffer }
  | { type: "fetchError"; requestId: number; name: string; message: string };
