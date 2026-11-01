import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { chapterAligned, classifySpine, markup, upgradeEpub, type ReportV4 } from "@storyteller-platform/align";
import { RebuildMismatchError } from "./rebuild-error.js";
import type { StageContext } from "./pipeline-contract.js";

const alignRequire = createRequire(import.meta.resolve("@storyteller-platform/align"));
const epubRequire = createRequire(alignRequire.resolve("@storyteller-platform/epub"));
const { DOMParser, XMLSerializer } = epubRequire("@xmldom/xmldom") as {
  DOMParser: new (options: { onError: () => void }) => { parseFromString(text: string, type: string): Document };
  XMLSerializer: new () => { serializeToString(document: Document): string };
};
export interface MetadataEntry {
  filename: string;
  uncompressedSize: number;
  openReadStream(): Promise<Readable>;
}
const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS("*", name));
const required = (node: Document | Element, name: string) => {
  const result = elements(node, name)[0];
  if (!result) throw new RebuildMismatchError(`Missing ${name}`);
  return result;
};
async function documentBytes(entry: MetadataEntry | undefined): Promise<Buffer> {
  if (!entry || entry.uncompressedSize > 16 * 1024 * 1024) throw new RebuildMismatchError("Missing or oversized EPUB document");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await entry.openReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new RebuildMismatchError("Oversized EPUB document");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function parseXml(bytes: Buffer): Document {
  return new DOMParser({ onError: () => {} }).parseFromString(bytes.toString("utf8").replace(/^\uFEFF/u, ""), "application/xml");
}
async function xml(entry: MetadataEntry | undefined): Promise<Document> {
  return parseXml(await documentBytes(entry));
}
async function packageDocument(entries: MetadataEntry[]) {
  const container = await xml(entries.find((entry) => entry.filename === "META-INF/container.xml"));
  const path = required(container, "rootfile").getAttribute("full-path");
  if (!path) throw new RebuildMismatchError("Missing package path");
  return { path, document: await xml(entries.find((entry) => entry.filename === path)) };
}
export async function sourceChapterFingerprint(entries: MetadataEntry[]): Promise<string> {
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  const { path, document } = await packageDocument(entries);
  const manifest = new Map(elements(required(document, "manifest"), "item").map((item) => [item.getAttribute("id"), item]));
  const hash = createHash("sha256");
  const spine = elements(required(document, "spine"), "itemref");
  if (!spine.length) throw new RebuildMismatchError("Empty source spine");
  for (const ref of spine) {
    const href = manifest.get(ref.getAttribute("idref"))?.getAttribute("href");
    if (!href) throw new RebuildMismatchError("Missing source chapter");
    const bytes = await documentBytes(byName.get(posix.join(posix.dirname(path), decodeURIComponent(href))));
    const chapter = parseXml(bytes);
    const text = required(chapter, "body").textContent ?? "";
    const hasText = text.replace(/\s+/gu, " ").trim().length > 0;
    hash.update(JSON.stringify([href, hasText ? createHash("sha256").update(bytes).digest("hex") : ""]) + "\n");
  }
  return hash.digest("hex");
}

export async function upgradeRebuildSource(context: StageContext): Promise<void> {
  try {
    await upgradeEpub(context.job.epub.path, context.paths.upgradedEpubPath, { removeNcx: false });
  } catch {
    throw new RebuildMismatchError("Cannot upgrade the current source EPUB");
  }
}

export async function markupRebuildSource(context: StageContext): Promise<void> {
  try {
    await markup(context.paths.upgradedEpubPath, context.paths.markedEpubPath, {
      granularity: context.job.granularity,
      primaryLocale: new Intl.Locale(context.job.language),
    });
  } catch {
    throw new RebuildMismatchError("Cannot mark up the current source EPUB");
  }
}

async function verifyReplayExclusions(context: StageContext, entries: MetadataEntry[]): Promise<void> {
  const bytes = await documentBytes(entries.find((entry) => entry.filename === context.job.rebuild!.reportEntry));
  let report: ReportV4 | null;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RebuildMismatchError("Cannot parse timing index report");
  }
  if (!Array.isArray(report?.spine)) throw new RebuildMismatchError("Missing timing index report spine");
  const { Epub } = (await import(pathToFileURL(alignRequire.resolve("@storyteller-platform/epub")).href)) as {
    Epub: { from(path: string): Promise<Parameters<typeof classifySpine>[0]> };
  };
  const epub = await Epub.from(context.paths.markedEpubPath);
  try {
    const locale = new Intl.Locale(context.job.language);
    const classifications = await classifySpine(epub, { locale });
    if (classifications.length !== report.spine.length) throw new RebuildMismatchError("Timing index report spine length changed");
    for (const classification of classifications) {
      context.signal.throwIfAborted();
      const { index, href } = classification;
      const stored = report.spine[index];
      if (stored?.index !== index || stored.href !== href || !stored.classification)
        throw new RebuildMismatchError("Timing index report chapter identity or classification is missing or changed");
      if (
        chapterAligned(classification, context.job.decisions.chapters[href] ?? null, true) !==
        chapterAligned(stored.classification, stored.decision ?? null, true)
      )
        throw new RebuildMismatchError(`Chapter exclusion changed: ${href}`);
    }
  } finally {
    epub.discardAndClose();
  }
}

export async function replayMetadata(stored: MetadataEntry[], current: MetadataEntry[], context: StageContext): Promise<MetadataEntry[]> {
  const storedByName = new Map(stored.map((entry) => [entry.filename, entry]));
  const currentByName = new Map(current.map((entry) => [entry.filename, entry]));
  const old = await packageDocument(stored);
  const base = await packageDocument(current);
  if (old.path !== base.path) throw new RebuildMismatchError("Package path changed");
  await verifyReplayExclusions(context, stored);
  const oldManifest = required(old.document, "manifest");
  const manifest = required(base.document, "manifest");
  const oldItems = elements(oldManifest, "item");
  const currentItems = elements(manifest, "item");
  const currentById = new Map(currentItems.map((item) => [item.getAttribute("id"), item]));
  const oldById = new Map(oldItems.map((item) => [item.getAttribute("id"), item]));
  const byHref = new Map(currentItems.map((item) => [item.getAttribute("href"), item]));
  const ids = new Set(currentItems.map((item) => item.getAttribute("id")));
  const aligned = new Set<string>();
  const added = new Set<string>();
  const pathFor = (href: string) => posix.join(posix.dirname(base.path), decodeURIComponent(href));
  for (const item of oldItems) {
    const href = item.getAttribute("href");
    const id = item.getAttribute("id");
    if (!href || !id) throw new RebuildMismatchError("Invalid aligned manifest");
    const existing = byHref.get(href);
    if (existing) {
      const overlay = item.getAttribute("media-overlay");
      if (overlay) {
        if (existing.getAttribute("id") !== id || overlay !== `${id}_overlay`) throw new RebuildMismatchError("Chapter identity changed");
        existing.setAttribute("media-overlay", overlay);
        aligned.add(pathFor(href));
      }
      continue;
    }
    const type = item.getAttribute("media-type");
    if (!(type?.startsWith("audio/") || type === "application/smil+xml" || id === "storyteller_readaloud_styles"))
      throw new RebuildMismatchError("Unsupported alignment manifest delta");
    if (ids.has(id)) throw new RebuildMismatchError("Alignment manifest id collision");
    ids.add(id);
    manifest.appendChild(base.document.importNode(item, true));
    added.add(pathFor(href));
  }
  const currentSpine = elements(required(base.document, "spine"), "itemref").map((item) => item.getAttribute("idref"));
  const oldSpine = elements(required(old.document, "spine"), "itemref").map((item) => item.getAttribute("idref"));
  for (const id of currentSpine) {
    const item = currentById.get(id);
    const previous = oldById.get(id);
    if (!item || !previous || item.getAttribute("href") !== previous.getAttribute("href"))
      throw new RebuildMismatchError("Spine chapter identity changed");
    if (item.getAttribute("properties")?.split(/\s+/).includes("nav")) continue;
    const path = pathFor(item.getAttribute("href")!);
    const chapter = await xml(currentByName.get(path));
    if (required(chapter, "body").textContent?.trim()) aligned.add(path);
  }

  if (JSON.stringify(currentSpine) !== JSON.stringify(oldSpine)) throw new RebuildMismatchError("Alignment changed the spine or navigation");
  for (const item of oldItems.filter((item) => item.hasAttribute("media-overlay"))) {
    if (!byHref.has(item.getAttribute("href"))) throw new RebuildMismatchError("Aligned chapter is missing");
  }
  const metadata = required(base.document, "metadata");
  for (const meta of elements(metadata, "meta")) {
    if (["media:duration", "media:active-class"].includes(meta.getAttribute("property") ?? "")) metadata.removeChild(meta);
  }
  for (const meta of elements(required(old.document, "metadata"), "meta")) {
    if (!["media:duration", "media:active-class"].includes(meta.getAttribute("property") ?? "")) continue;
    const refines = meta.getAttribute("refines");
    if (refines && !ids.has(refines.slice(1))) throw new RebuildMismatchError("Missing overlay metadata target");
    metadata.appendChild(base.document.importNode(meta, true));
  }
  const text = new XMLSerializer().serializeToString(base.document);
  const result: MetadataEntry[] = [];
  for (const entry of current) {
    if (entry.filename === base.path)
      result.push({ filename: base.path, uncompressedSize: Buffer.byteLength(text), openReadStream: async () => Readable.from([text]) });
    else if (aligned.has(entry.filename)) {
      const chapter = storedByName.get(entry.filename);
      if (!chapter) throw new RebuildMismatchError("Missing aligned chapter bytes");
      result.push(chapter);
    } else result.push(entry);
  }
  for (const entry of stored) if (added.has(entry.filename)) result.push(entry);
  return result;
}
