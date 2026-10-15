import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

import { ZipArchive } from 'archiver';
import { vi } from 'vitest';

import { MangaBakaClient } from '../../../src/modules/web-serials/lookup/mangabaka.client';
import { MangaDexClient } from '../../../src/modules/web-serials/lookup/mangadex.client';

/**
 * In-process HTTP fakes for the services the Web Serials feature talks to: Suwayomi (manga),
 * lightnovel-crawler and the LNReader novel-sources service (novels), MangaBaka and MangaDex (series details). Every fake listens on an
 * ephemeral loopback port, counts requests per operation, and can be told to misbehave.
 */

// --------------------------------------------------------------------------------------------
// Tiny file builders
// --------------------------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A valid 8x12 solid-colour PNG carrying `label` in a tEXt chunk, so tests can read page order back. */
export function makePng(label: string): Buffer {
  const width = 8;
  const height = 12;
  const hash = crc32(Buffer.from(label)) >>> 0;
  const rgb = [(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from(`Comment\0${label}`, 'latin1')),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function readPngLabel(png: Buffer): string | null {
  const at = png.indexOf('tEXt');
  if (at < 4) return null;
  const length = png.readUInt32BE(at - 4);
  const text = png.subarray(at + 4, at + 4 + length).toString('latin1');
  return text.split('\0')[1] ?? null;
}

interface ZipEntrySpec {
  name: string;
  data: Buffer | string;
  store?: boolean;
}

async function zipToBuffer(entries: ZipEntrySpec[]): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  for (const entry of entries) archive.append(entry.data, { name: entry.name, ...(entry.store ? { store: true } : {}) });
  void archive.finalize();
  return done;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface BuildCbzInput {
  /** Prefix of every page label, e.g. `c12`. Pages are labelled `<prefix>p<n>`. */
  labelPrefix: string;
  pages: number;
  series?: string;
  number?: string;
}

export function buildCbz(input: BuildCbzInput): Promise<Buffer> {
  const entries: ZipEntrySpec[] = [];
  for (let page = 1; page <= input.pages; page += 1) {
    entries.push({ name: `${String(page).padStart(3, '0')}.png`, data: makePng(`${input.labelPrefix}p${page}`) });
  }
  entries.push({
    name: 'ComicInfo.xml',
    data: `<?xml version="1.0"?>\n<ComicInfo><Series>${escapeXml(input.series ?? 'Fake')}</Series><Number>${escapeXml(input.number ?? '1')}</Number><PageCount>${input.pages}</PageCount></ComicInfo>`,
  });
  return zipToBuffer(entries);
}

export interface BuildEpubInput {
  title: string;
  authors?: string[];
  language?: string;
  sections?: number;
}

/** A minimal valid EPUB 3: stored mimetype first, container, package document with a nav, and a few XHTML sections. */
export function buildEpub(input: BuildEpubInput): Promise<Buffer> {
  const sections = Math.max(1, input.sections ?? 2);
  const identifier = `urn:uuid:${randomUUID()}`;
  const creators = (input.authors ?? ['Fake Author']).map((author) => `    <dc:creator>${escapeXml(author)}</dc:creator>`).join('\n');
  const manifest = Array.from(
    { length: sections },
    (_, index) => `    <item id="s${index + 1}" href="s${index + 1}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('\n');
  const spine = Array.from({ length: sections }, (_, index) => `    <itemref idref="s${index + 1}"/>`).join('\n');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
${creators}
    <dc:language>${input.language ?? 'en'}</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`;
  const xhtml = (title: string, body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(title)}</title></head><body>${body}</body></html>`;
  const toc = Array.from({ length: sections }, (_, index) => `<li><a href="s${index + 1}.xhtml">Section ${index + 1}</a></li>`).join('');
  return zipToBuffer([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: xhtml('Contents', `<nav epub:type="toc"><ol>${toc}</ol></nav>`) },
    ...Array.from({ length: sections }, (_, index) => ({
      name: `OEBPS/s${index + 1}.xhtml`,
      data: xhtml(`Section ${index + 1}`, `<h1>Section ${index + 1}</h1><p>${escapeXml(input.title)} fixture text.</p>`),
    })),
  ]);
}

// --------------------------------------------------------------------------------------------
// HTTP plumbing
// --------------------------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  path: string;
  /** Logical operation name (GraphQL operation, route key). */
  op: string;
  at: number;
}

interface FakeRequest {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: string;
  record: RecordedRequest;
  socket: IncomingMessage['socket'];
}

export class Gate {
  private released = false;
  private readonly waiters: Array<() => void> = [];
  private reachedResolve!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.reachedResolve = resolve;
  });

  touched = false;

  /** Called by the fake each time the runner asks about a held unit. */
  touch(): void {
    this.touched = true;
    this.reachedResolve();
  }

  get isReleased(): boolean {
    return this.released;
  }

  release(): void {
    this.released = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, ...headers });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FailurePlan {
  /** status: answer with this HTTP status; reset: destroy the socket; graphql-error: a GraphQL errors envelope. */
  mode: 'status' | 'reset' | 'graphql-error';
  status?: number;
  /** Number of requests it applies to; Infinity keeps it forever. */
  times: number;
}

abstract class FakeHttpServer {
  readonly requests: RecordedRequest[] = [];
  latencyMs = 0;
  readonly opLatencyMs = new Map<string, number>();
  peakInFlight = 0;
  private inFlight = 0;
  private server: Server | null = null;
  private port = 0;
  private readonly opFailures = new Map<string, FailurePlan[]>();
  private readonly sockets = new Set<IncomingMessage['socket']>();

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.dispatch(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.beforeStop();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  protected beforeStop(): void {}

  resetStats(): void {
    this.requests.length = 0;
    this.peakInFlight = 0;
  }

  /** Makes every request of the named operation fail as described, for the given number of requests. */
  failOp(op: string, plan: FailurePlan): void {
    this.opFailures.set(op, [...(this.opFailures.get(op) ?? []), { ...plan }]);
  }

  clearFailures(): void {
    this.opFailures.clear();
  }

  count(op: string | RegExp): number {
    return this.requests.filter((request) => (typeof op === 'string' ? request.op === op : op.test(request.op))).length;
  }

  countsByOp(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const request of this.requests) counts[request.op] = (counts[request.op] ?? 0) + 1;
    return counts;
  }

  protected abstract route(req: FakeRequest, res: ServerResponse): Promise<void> | void;

  /** Applies a failure plan registered for this operation. Returns true when the request was consumed. */
  protected applyFailure(req: FakeRequest, res: ServerResponse): boolean {
    const plans = this.opFailures.get(req.record.op);
    const plan = plans?.[0];
    if (!plan) return false;
    plan.times -= 1;
    if (plan.times <= 0) plans!.shift();
    if (plan.mode === 'reset') req.socket.destroy();
    else if (plan.mode === 'graphql-error') sendJson(res, 200, { errors: [{ message: 'injected failure' }] });
    else sendText(res, plan.status ?? 503, 'injected failure');
    return true;
  }

  private async dispatch(incoming: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const url = new URL(incoming.url ?? '/', 'http://fake');
    const record: RecordedRequest = { method: incoming.method ?? 'GET', path: url.pathname, op: '?', at: performance.now() };
    this.requests.push(record);
    const req: FakeRequest = {
      method: record.method,
      url,
      headers: incoming.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      record,
      socket: incoming.socket,
    };
    try {
      await this.route(req, res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlight -= 1;
    }
  }

  protected async pause(op: string): Promise<void> {
    const ms = this.opLatencyMs.get(op) ?? this.latencyMs;
    if (ms > 0) await delay(ms);
  }
}

// --------------------------------------------------------------------------------------------
// Suwayomi
// --------------------------------------------------------------------------------------------

export interface FakeMangaSource {
  id: string;
  name: string;
  displayName?: string;
  lang: string;
  nsfw?: boolean;
  pkgName?: string;
}

export interface FakeMangaChapter {
  id: number;
  name: string;
  chapterNumber: number;
  uploadDate: number;
  sourceOrder: number;
  scanlator: string | null;
  pages: number;
}

export interface FakeMangaInput {
  id?: number;
  title: string;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  genre?: string[];
  status?: string;
  sourceId?: string;
  realUrl?: string | null;
  chapters: FakeMangaChapter[];
  thumbnail?: boolean;
}

export interface FakeManga extends Required<Omit<FakeMangaInput, 'id'>> {
  id: number;
}

export interface FakeExtension {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW' | null;
  iconUrl: string | null;
  repo: string | null;
}

export interface GenerateChaptersOptions {
  count: number;
  /** When set, chapter names read `Vol.<v> Ch.<n>` so the volume can be parsed from the name. */
  chaptersPerVolume?: number;
  pages?: number;
  firstChapterNumber?: number;
  /** Upload date of the first chapter (ms epoch). Each next chapter is one day later. */
  startDate?: number;
  /** Chapter numbers to leave out, e.g. to build a source with gaps. */
  skip?: number[];
}

let chapterIdCounter = 1000;

export function generateMangaChapters(options: GenerateChaptersOptions): FakeMangaChapter[] {
  const first = options.firstChapterNumber ?? 1;
  const start = options.startDate ?? Date.UTC(2024, 0, 1);
  const skip = new Set(options.skip ?? []);
  const chapters: FakeMangaChapter[] = [];
  for (let offset = 0; chapters.length < options.count; offset += 1) {
    const number = first + offset;
    if (skip.has(number)) continue;
    const index = chapters.length;
    const volume = options.chaptersPerVolume ? Math.floor(index / options.chaptersPerVolume) + 1 : null;
    chapters.push({
      id: ++chapterIdCounter,
      name: volume ? `Vol.${volume} Ch.${number}` : `Chapter ${number}`,
      chapterNumber: number,
      uploadDate: start + index * 86_400_000,
      sourceOrder: options.count - index,
      scanlator: null,
      pages: options.pages ?? 3,
    });
  }
  return chapters;
}

export type ChapterPollPlan =
  | { kind: 'hold'; gate: Gate }
  | { kind: 'queue-error'; times: number }
  | { kind: 'vanish'; times: number }
  | { kind: 'slow'; polls: number }
  | { kind: 'reset'; times: number };

export type ChapterDownloadPlan = { kind: 'http'; status: number; times: number } | { kind: 'reset'; times: number };

interface ChapterState {
  downloaded: boolean;
  queued: boolean;
  slowPolls: number;
}

export class FakeSuwayomi extends FakeHttpServer {
  version = '2.1.1900-fake';
  credentials: { username: string; password: string } | null = null;
  readonly sources: FakeMangaSource[] = [{ id: '0', name: 'Local source', lang: 'localsourcelang' }];
  readonly mangas = new Map<number, FakeManga>();
  readonly extensions: FakeExtension[] = [];
  readonly repos: string[] = [];
  private nextMangaId = 1;
  private readonly states = new Map<number, ChapterState>();
  private readonly pollPlans = new Map<number, ChapterPollPlan[]>();
  private readonly downloadPlans = new Map<number, ChapterDownloadPlan[]>();
  private readonly failingSources = new Set<string>();
  private readonly cbzCache = new Map<string, Buffer>();
  private readonly gates: Gate[] = [];
  readonly enqueues = new Map<number, number>();
  readonly polls = new Map<number, number>();
  readonly downloads = new Map<number, number>();
  /** One entry per `deleteDownloadedChapters` call, holding the chapter ids it asked to delete. */
  readonly deleteCalls: number[][] = [];

  addSource(source: FakeMangaSource): FakeMangaSource {
    this.sources.push(source);
    return source;
  }

  addManga(input: FakeMangaInput): FakeManga {
    const id = input.id ?? this.nextMangaId++;
    const manga: FakeManga = {
      id,
      title: input.title,
      author: input.author ?? null,
      artist: input.artist ?? null,
      description: input.description ?? null,
      genre: input.genre ?? [],
      status: input.status ?? 'ONGOING',
      sourceId: input.sourceId ?? this.defaultSourceId(),
      realUrl: input.realUrl ?? `https://fake.example/manga/${id}`,
      chapters: input.chapters,
      thumbnail: input.thumbnail ?? true,
    };
    this.mangas.set(id, manga);
    return manga;
  }

  private defaultSourceId(): string {
    const source = this.sources.find((entry) => entry.id !== '0');
    if (!source) throw new Error('Add a source before adding manga');
    return source.id;
  }

  /** Makes every chapter of the manga count as already present on disk. */
  markDownloaded(chapterId: number): void {
    this.state(chapterId).downloaded = true;
  }

  hold(chapterId: number): Gate {
    const gate = new Gate();
    this.gates.push(gate);
    this.pollPlansFor(chapterId).push({ kind: 'hold', gate });
    return gate;
  }

  failPoll(chapterId: number, plan: Exclude<ChapterPollPlan, { kind: 'hold' }>): void {
    this.pollPlansFor(chapterId).push({ ...plan });
  }

  failDownload(chapterId: number, plan: ChapterDownloadPlan): void {
    const plans = this.downloadPlans.get(chapterId) ?? [];
    plans.push({ ...plan });
    this.downloadPlans.set(chapterId, plans);
  }

  failSource(sourceId: string): void {
    this.failingSources.add(sourceId);
  }

  clearPlans(): void {
    this.pollPlans.clear();
    this.downloadPlans.clear();
    this.failingSources.clear();
    this.clearFailures();
  }

  /** Forgets every downloaded/queued chapter and counter, as if Suwayomi restarted with an empty download folder. */
  resetDownloads(): void {
    this.states.clear();
    this.enqueues.clear();
    this.polls.clear();
    this.downloads.clear();
  }

  override resetStats(): void {
    super.resetStats();
    this.enqueues.clear();
    this.polls.clear();
    this.downloads.clear();
    this.deleteCalls.length = 0;
  }

  protected override beforeStop(): void {
    for (const gate of this.gates) gate.release();
  }

  maxPerChapter(map: Map<number, number>): number {
    return Math.max(0, ...map.values());
  }

  private pollPlansFor(chapterId: number): ChapterPollPlan[] {
    const plans = this.pollPlans.get(chapterId) ?? [];
    this.pollPlans.set(chapterId, plans);
    return plans;
  }

  private state(chapterId: number): ChapterState {
    let state = this.states.get(chapterId);
    if (!state) {
      state = { downloaded: false, queued: false, slowPolls: 0 };
      this.states.set(chapterId, state);
    }
    return state;
  }

  private findChapter(chapterId: number): { manga: FakeManga; chapter: FakeMangaChapter } | null {
    for (const manga of this.mangas.values()) {
      const chapter = manga.chapters.find((entry) => entry.id === chapterId);
      if (chapter) return { manga, chapter };
    }
    return null;
  }

  protected async route(req: FakeRequest, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      req.record.op = 'unauthorized';
      return sendText(res, 401, 'unauthorized');
    }
    const path = req.url.pathname;
    if (req.method === 'POST' && path === '/api/graphql') return this.graphql(req, res);

    const download = /^\/api\/v1\/chapter\/(\d+)\/download$/.exec(path);
    if (download) {
      req.record.op = 'download';
      await this.pause('download');
      return this.serveDownload(Number(download[1]), req, res);
    }
    const thumbnail = /^\/api\/v1\/manga\/(\d+)\/thumbnail$/.exec(path);
    if (thumbnail) {
      req.record.op = 'thumbnail';
      await this.pause('thumbnail');
      return sendBuffer(res, 200, makePng(`thumb-${thumbnail[1]}`), 'image/png');
    }
    const icon = /^\/api\/v1\/extension\/icon\/(.+)$/.exec(path);
    if (icon) {
      req.record.op = 'extension-icon';
      return sendBuffer(res, 200, makePng(`icon-${icon[1]}`), 'image/png');
    }
    req.record.op = 'unknown';
    return sendText(res, 404, 'not found');
  }

  private authorized(req: FakeRequest): boolean {
    if (!this.credentials) return true;
    const expected = `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`;
    return req.headers.authorization === expected;
  }

  private async serveDownload(chapterId: number, req: FakeRequest, res: ServerResponse): Promise<void> {
    this.downloads.set(chapterId, (this.downloads.get(chapterId) ?? 0) + 1);
    const plans = this.downloadPlans.get(chapterId);
    const plan = plans?.[0];
    if (plan) {
      plan.times -= 1;
      if (plan.times <= 0) plans!.shift();
      if (plan.kind === 'reset') {
        req.socket.destroy();
        return;
      }
      return sendText(res, plan.status, 'injected failure');
    }
    const found = this.findChapter(chapterId);
    if (!found || !this.state(chapterId).downloaded) return sendText(res, 404, 'chapter not downloaded');
    const key = `${found.chapter.id}:${found.chapter.pages}`;
    let cbz = this.cbzCache.get(key);
    if (!cbz) {
      cbz = await buildCbz({
        labelPrefix: `c${found.chapter.id}`,
        pages: found.chapter.pages,
        series: found.manga.title,
        number: String(found.chapter.chapterNumber),
      });
      this.cbzCache.set(key, cbz);
    }
    return sendBuffer(res, 200, cbz, 'application/vnd.comicbook+zip', {
      'Content-Disposition': `attachment; filename="${found.chapter.id}.cbz"`,
    });
  }

  private async graphql(req: FakeRequest, res: ServerResponse): Promise<void> {
    const query = (JSON.parse(req.body) as { query: string }).query;
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
    req.record.op = `graphql:${op}`;
    await this.pause(req.record.op);
    if (this.applyFailure(req, res)) return;
    const data = this.graphqlData(op, query, req, res);
    if (data === undefined) return;
    sendJson(res, 200, { data });
  }

  private sourceNode(source: FakeMangaSource) {
    return { id: source.id, name: source.name, lang: source.lang, displayName: source.displayName ?? source.name, isNsfw: source.nsfw ?? false };
  }

  private graphqlData(op: string, query: string, req: FakeRequest, res: ServerResponse): unknown {
    const number = (pattern: RegExp, fallback = 0) => Number(pattern.exec(query)?.[1] ?? fallback);
    const quoted = (pattern: RegExp) => {
      const raw = pattern.exec(query)?.[1];
      return raw ? (JSON.parse(raw) as string) : null;
    };
    switch (op) {
      case 'BookOrbitHealth':
        return { aboutServer: { version: this.version }, sources: { nodes: this.sources.map((s) => this.sourceNode(s)) } };
      case 'BookOrbitSourceList':
      case 'BookOrbitSources':
        return { sources: { nodes: this.sources.map((s) => this.sourceNode(s)) } };
      case 'BookOrbitExtensionRepos':
        return { settings: { extensionRepos: [...this.repos] } };
      case 'BookOrbitAddExtensionRepo': {
        const url = quoted(/indexUrl: ("(?:[^"\\]|\\.)*")/)!;
        if (!this.repos.includes(url)) this.repos.push(url);
        return { addExtensionStore: { clientMutationId: null } };
      }
      case 'BookOrbitRemoveExtensionRepo': {
        const url = quoted(/indexUrl: ("(?:[^"\\]|\\.)*")/)!;
        const at = this.repos.indexOf(url);
        if (at >= 0) this.repos.splice(at, 1);
        return { removeExtensionStore: { clientMutationId: null } };
      }
      case 'BookOrbitRefreshExtensions':
        return { fetchExtensions: { clientMutationId: null } };
      case 'BookOrbitExtensionCount':
        return { extensions: { totalCount: this.extensions.length } };
      case 'BookOrbitExtensionLanguages': {
        const offset = number(/offset: (\d+)/);
        const nodes = this.extensions.slice(offset, offset + 100).map((extension) => ({ lang: extension.lang }));
        return { extensions: { totalCount: this.extensions.length, nodes } };
      }
      case 'BookOrbitExtensions': {
        const installed = /isInstalled: true/.test(query);
        const lang = quoted(/condition: \{[^}]*lang: ("(?:[^"\\]|\\.)*")/);
        const name = quoted(/includesInsensitive: ("(?:[^"\\]|\\.)*")/);
        const hideAdult = /notEqualTo: NSFW/.test(query);
        const matches = this.extensions
          .filter((extension) => extension.isInstalled === installed)
          .filter((extension) => (lang ? extension.lang === lang : true))
          .filter((extension) => (name ? extension.name.toLowerCase().includes(name.toLowerCase()) : true))
          .filter((extension) => (hideAdult ? extension.contentWarning !== 'NSFW' : true))
          .sort((left, right) => left.name.localeCompare(right.name));
        const first = number(/first: (\d+)/, 50);
        const offset = number(/offset: (\d+)/);
        return { extensions: { totalCount: matches.length, nodes: matches.slice(offset, offset + first) } };
      }
      case 'BookOrbitExtensionSources': {
        const offset = number(/offset: (\d+)/);
        const nodes = this.sources.slice(offset, offset + 100).map((source) => ({
          id: source.id,
          extension: source.pkgName ? { pkgName: source.pkgName } : null,
        }));
        return { sources: { totalCount: this.sources.length, nodes } };
      }
      case 'BookOrbitUpdateExtension': {
        const pkgName = quoted(/updateExtension\(input: \{ id: ("(?:[^"\\]|\\.)*")/)!;
        const extension = this.extensions.find((entry) => entry.pkgName === pkgName);
        if (!extension) {
          sendJson(res, 200, { errors: [{ message: 'no such extension' }] });
          return undefined;
        }
        if (/install: true/.test(query)) extension.isInstalled = true;
        if (/uninstall: true/.test(query)) extension.isInstalled = false;
        if (/\bupdate: true/.test(query)) extension.hasUpdate = false;
        return { updateExtension: { extension } };
      }
      case 'BookOrbitSearch': {
        const sourceId = quoted(/source: ("(?:[^"\\]|\\.)*")/)!;
        const text = (quoted(/query: ("(?:[^"\\]|\\.)*")/) ?? '').toLowerCase();
        if (this.failingSources.has(sourceId)) {
          sendJson(res, 200, { errors: [{ message: 'source down' }] });
          return undefined;
        }
        const mangas = [...this.mangas.values()]
          .filter((manga) => manga.sourceId === sourceId && manga.title.toLowerCase().includes(text))
          .map((manga) => ({
            id: String(manga.id),
            title: manga.title,
            author: manga.author,
            thumbnailUrl: manga.thumbnail ? `/api/v1/manga/${manga.id}/thumbnail` : null,
            status: manga.status,
            url: manga.realUrl,
            realUrl: manga.realUrl,
          }));
        return { fetchSourceManga: { mangas, hasNextPage: false } };
      }
      case 'BookOrbitSeries': {
        const manga = this.mangas.get(number(/id: (\d+)/));
        if (!manga) {
          sendJson(res, 200, { errors: [{ message: 'no such manga' }] });
          return undefined;
        }
        const source = this.sources.find((entry) => entry.id === manga.sourceId);
        return {
          fetchMangaAndChapters: {
            manga: {
              id: String(manga.id),
              title: manga.title,
              author: manga.author,
              artist: manga.artist,
              description: manga.description,
              genre: manga.genre,
              status: manga.status,
              thumbnailUrl: manga.thumbnail ? `/api/v1/manga/${manga.id}/thumbnail` : null,
              realUrl: manga.realUrl,
              source: { id: manga.sourceId, displayName: source?.displayName ?? source?.name ?? 'Fake', lang: source?.lang ?? 'en' },
            },
            chapters: manga.chapters.map((chapter) => ({
              id: String(chapter.id),
              name: chapter.name,
              chapterNumber: chapter.chapterNumber,
              uploadDate: String(chapter.uploadDate),
              sourceOrder: chapter.sourceOrder,
              scanlator: chapter.scanlator,
              isDownloaded: this.state(chapter.id).downloaded,
              pageCount: chapter.pages,
            })),
          },
        };
      }
      case 'BookOrbitDownload': {
        const ids = [...query.matchAll(/ids: \[(\d+)\]/g)].map((match) => Number(match[1]));
        for (const id of ids) {
          this.enqueues.set(id, (this.enqueues.get(id) ?? 0) + 1);
          const state = this.state(id);
          if (!state.downloaded) state.queued = true;
        }
        return { enqueue: { downloadStatus: { state: 'STARTED' } }, start: { downloadStatus: { state: 'STARTED' } } };
      }
      case 'BookOrbitDeleteDownloaded': {
        const match = /deleteDownloadedChapters\(input: \{ ids: \[([\d,\s]*)\] \}\)/.exec(query);
        const ids = (match?.[1] ?? '').split(',').flatMap((entry) => (entry.trim() ? [Number(entry)] : []));
        this.deleteCalls.push(ids);
        for (const id of ids) this.state(id).downloaded = false;
        return { deleteDownloadedChapters: { chapters: ids.map((id) => ({ id: String(id), isDownloaded: false })) } };
      }
      case 'BookOrbitDequeue': {
        const id = number(/ids: \[(\d+)\]/);
        this.state(id).queued = false;
        return { dequeueChapterDownloads: { downloadStatus: { state: 'STARTED' } } };
      }
      case 'BookOrbitDownloadStatus':
        return this.downloadStatus(number(/chapter\(id: (\d+)\)/), req);
      default:
        sendJson(res, 200, { errors: [{ message: `unsupported operation ${op}` }] });
        return undefined;
    }
  }

  private downloadStatus(chapterId: number, req: FakeRequest): unknown {
    this.polls.set(chapterId, (this.polls.get(chapterId) ?? 0) + 1);
    const state = this.state(chapterId);
    const reply = (isDownloaded: boolean, queue: Array<{ state: string; progress: number | null }> = []) => ({
      chapter: { id: String(chapterId), isDownloaded },
      downloadStatus: {
        state: 'STARTED',
        queue: queue.map((entry) => ({ ...entry, tries: 0, chapter: { id: String(chapterId) } })),
      },
    });
    if (state.downloaded) return reply(true);

    const plans = this.pollPlans.get(chapterId);
    const plan = plans?.[0];
    if (plan) {
      if (plan.kind === 'hold') {
        plan.gate.touch();
        if (!plan.gate.isReleased) return reply(false, [{ state: 'DOWNLOADING', progress: 0.25 }]);
        plans!.shift();
      } else if (plan.kind === 'reset') {
        plan.times -= 1;
        if (plan.times <= 0) plans!.shift();
        req.socket.destroy();
        return undefined;
      } else if (plan.kind === 'queue-error') {
        plan.times -= 1;
        if (plan.times <= 0) plans!.shift();
        return reply(false, [{ state: 'ERROR', progress: null }]);
      } else if (plan.kind === 'vanish') {
        plan.times -= 1;
        if (plan.times <= 0) plans!.shift();
        state.queued = false;
        return reply(false);
      } else {
        if (state.slowPolls < plan.polls) {
          state.slowPolls += 1;
          return reply(false, [{ state: 'DOWNLOADING', progress: state.slowPolls / plan.polls }]);
        }
        plans!.shift();
        state.slowPolls = 0;
      }
    }
    if (!state.queued) return reply(false);
    state.downloaded = true;
    state.queued = false;
    return reply(true);
  }
}

// --------------------------------------------------------------------------------------------
// lightnovel-crawler
// --------------------------------------------------------------------------------------------

export interface FakeNovelVolume {
  id: string;
  serial: number;
  title: string;
  chapterCount: number;
}

export interface FakeNovelInput {
  id?: string;
  title: string;
  url?: string;
  domain?: string;
  authors?: string;
  synopsis?: string;
  tags?: string[];
  language?: string;
  info?: string;
  volumes: FakeNovelVolume[];
  cover?: boolean;
}

export interface FakeNovel extends Required<Omit<FakeNovelInput, 'id'>> {
  id: string;
}

export function generateNovelVolumes(count: number, chaptersPerVolume: number): FakeNovelVolume[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `vol-${randomUUID()}`,
    serial: index + 1,
    title: `Volume ${index + 1}`,
    chapterCount: chaptersPerVolume,
  }));
}

interface FakeJob {
  id: string;
  type: string;
  params: Record<string, unknown>;
  polls: number;
  extra: Record<string, unknown>;
  totalChapters: number;
  cancelled: boolean;
  outcome: JobFailureRule | null;
}

export interface JobFailureRule {
  /** Job type to match (`fetch-volumes`, `make-artifacts`, `search-sources`, `fetch-novels`). */
  type: string;
  /** Match only jobs that touch this volume serial. */
  volumeSerial?: number;
  /** Match only this search domain. */
  domain?: string;
  times: number;
  /** Final error text; status becomes failed. */
  error?: string | null;
  /** Failed chapter count reported on the finished job. */
  failed?: number;
  /** The job disappears: GET answers 404. */
  gone?: boolean;
}

interface FakeArtifact {
  id: string;
  novelId: string;
  volume: number | null;
  fileName: string;
  createdAt: number;
}

export class FakeLncrawl extends FakeHttpServer {
  version = '3.0.0-fake';
  credentials: { email: string; password: string } | null = null;
  readonly novels = new Map<string, FakeNovel>();
  readonly domains: Array<{ domain: string; language: string; canSearch: boolean; disabled: boolean }> = [];
  /** GETs a job needs before it reports done; per job type. 0 means done as created. */
  readonly jobPolls = new Map<string, number>();
  defaultJobPolls = 0;
  epubSections = 2;
  private tokens = new Set<string>();
  private readonly jobs = new Map<string, FakeJob>();
  private readonly artifacts: FakeArtifact[] = [];
  private readonly failureRules: JobFailureRule[] = [];
  private artifactClock = 1_700_000_000_000;
  readonly jobsCreated: Array<{ type: string; params: Record<string, unknown> }> = [];

  addNovel(input: FakeNovelInput): FakeNovel {
    const id = input.id ?? `novel-${randomUUID()}`;
    const domain = input.domain ?? 'fake-novels.example';
    const novel: FakeNovel = {
      id,
      title: input.title,
      url: input.url ?? `https://${domain}/fiction/${id}`,
      domain,
      authors: input.authors ?? 'Fake Author',
      synopsis: input.synopsis ?? '<p>A fixture novel.</p>',
      tags: input.tags ?? ['fantasy'],
      language: input.language ?? 'en',
      info: input.info ?? 'Ongoing',
      volumes: input.volumes,
      cover: input.cover ?? true,
    };
    this.novels.set(id, novel);
    if (!this.domains.some((entry) => entry.domain === domain)) {
      this.domains.push({ domain, language: 'en', canSearch: true, disabled: false });
    }
    return novel;
  }

  failJobs(rule: JobFailureRule): void {
    this.failureRules.push({ ...rule });
  }

  /** Makes every issued token invalid, so the next authenticated call is answered 401 and the client must log in again. */
  invalidateTokens(): void {
    this.tokens = new Set();
  }

  clearPlans(): void {
    this.failureRules.length = 0;
    this.clearFailures();
  }

  resetState(): void {
    this.clearPlans();
    this.novels.clear();
    this.domains.length = 0;
    this.jobs.clear();
    this.artifacts.length = 0;
    this.tokens = new Set();
    this.jobPolls.clear();
    this.defaultJobPolls = 0;
    this.credentials = null;
  }

  override resetStats(): void {
    super.resetStats();
    this.jobsCreated.length = 0;
  }

  protected async route(req: FakeRequest, res: ServerResponse): Promise<void> {
    const path = req.url.pathname;
    if (req.method === 'GET' && path === '/health') {
      req.record.op = 'health';
      return sendJson(res, 200, { version: this.version, status: 'ok' });
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      req.record.op = 'login';
      const body = JSON.parse(req.body) as { email: string; password: string };
      if (this.credentials && (body.email !== this.credentials.email || body.password !== this.credentials.password)) {
        return sendText(res, 401, 'bad credentials');
      }
      const token = `tok-${randomUUID()}`;
      this.tokens.add(token);
      return sendJson(res, 200, { token });
    }
    if (!this.authorized(req)) {
      req.record.op = 'unauthorized';
      return sendText(res, 401, 'unauthorized');
    }

    let match: RegExpExecArray | null;
    if (req.method === 'GET' && path === '/api/sources') {
      req.record.op = 'sources';
      await this.pause('sources');
      if (this.applyFailure(req, res)) return;
      return sendJson(
        res,
        200,
        this.domains.map((entry) => ({ domain: entry.domain, language: entry.language, can_search: entry.canSearch, is_disabled: entry.disabled })),
      );
    }
    if ((match = /^\/api\/job\/create\/([a-z-]+)$/.exec(path)) && req.method === 'POST') {
      req.record.op = `job:create:${match[1]}`;
      await this.pause(req.record.op);
      if (this.applyFailure(req, res)) return;
      return sendJson(res, 200, this.createJob(match[1]!, JSON.parse(req.body) as Record<string, unknown>));
    }
    if ((match = /^\/api\/job\/([^/]+)\/cancel$/.exec(path)) && req.method === 'POST') {
      req.record.op = 'job:cancel';
      const job = this.jobs.get(decodeURIComponent(match[1]!));
      if (job) job.cancelled = true;
      return sendJson(res, 200, { ok: true });
    }
    if ((match = /^\/api\/job\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      req.record.op = 'job:get';
      await this.pause('job:get');
      if (this.applyFailure(req, res)) return;
      const job = this.jobs.get(decodeURIComponent(match[1]!));
      if (!job || job.outcome?.gone) return sendText(res, 404, 'no such job');
      job.polls += 1;
      return sendJson(res, 200, this.jobJson(job));
    }
    if ((match = /^\/api\/novel\/([^/]+)\/volumes$/.exec(path))) {
      req.record.op = 'novel:volumes';
      const novel = this.novels.get(decodeURIComponent(match[1]!));
      if (!novel) return sendText(res, 404, 'no such novel');
      return sendJson(
        res,
        200,
        novel.volumes.map((volume) => ({
          id: volume.id,
          serial: volume.serial,
          title: volume.title,
          chapter_count: volume.chapterCount,
          novel_id: novel.id,
        })),
      );
    }
    if ((match = /^\/api\/novel\/([^/]+)$/.exec(path))) {
      req.record.op = 'novel:get';
      await this.pause('novel:get');
      if (this.applyFailure(req, res)) return;
      const novel = this.novels.get(decodeURIComponent(match[1]!));
      if (!novel) return sendText(res, 404, 'no such novel');
      return sendJson(res, 200, {
        id: novel.id,
        url: novel.url,
        title: novel.title,
        synopsis: novel.synopsis,
        authors: novel.authors,
        tags: novel.tags,
        language: novel.language,
        domain: novel.domain,
        chapter_count: novel.volumes.reduce((sum, volume) => sum + volume.chapterCount, 0),
        volume_count: novel.volumes.length,
        cover_file: novel.cover ? `novels/${novel.id}/cover.png` : null,
        cover_available: novel.cover,
      });
    }
    if (req.method === 'GET' && path === '/api/artifacts') {
      req.record.op = 'artifacts';
      await this.pause('artifacts');
      if (this.applyFailure(req, res)) return;
      const novelId = req.url.searchParams.get('novel_id');
      const offset = Number(req.url.searchParams.get('offset') ?? 0);
      const limit = Number(req.url.searchParams.get('limit') ?? 100);
      const all = this.artifacts.filter((artifact) => !novelId || artifact.novelId === novelId);
      return sendJson(res, 200, {
        total: all.length,
        offset,
        limit,
        items: all.slice(offset, offset + limit).map((artifact) => ({
          id: artifact.id,
          novel_id: artifact.novelId,
          format: 'epub',
          volume: artifact.volume,
          file_name: artifact.fileName,
          file_size: 1,
          created_at: artifact.createdAt,
          is_available: true,
        })),
      });
    }
    if ((match = /^\/static\/novels\/([^/]+)\/artifacts\/(.+)$/.exec(path))) {
      req.record.op = 'static:artifact';
      await this.pause('static:artifact');
      if (this.applyFailure(req, res)) return;
      const novel = this.novels.get(decodeURIComponent(match[1]!));
      const fileName = decodeURIComponent(match[2]!);
      const artifact = this.artifacts.find((entry) => entry.novelId === novel?.id && entry.fileName === fileName);
      if (!novel || !artifact) return sendText(res, 404, 'no such artifact');
      const volume = artifact.volume === null ? null : novel.volumes.find((entry) => entry.serial === artifact.volume);
      const epub = await buildEpub({
        title: volume ? `${novel.title}, ${volume.title}` : novel.title,
        authors: novel.authors.split(',').map((author) => author.trim()),
        language: novel.language,
        sections: this.epubSections,
      });
      return sendBuffer(res, 200, epub, 'application/epub+zip');
    }
    if ((match = /^\/static\/novels\/([^/]+)\/cover\.png$/.exec(path))) {
      req.record.op = 'static:cover';
      return sendBuffer(res, 200, makePng(`cover-${match[1]}`), 'image/png');
    }
    req.record.op = 'unknown';
    return sendText(res, 404, 'not found');
  }

  private authorized(req: FakeRequest): boolean {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? req.url.searchParams.get('token');
    return token !== null && token !== undefined && this.tokens.has(token);
  }

  private createJob(type: string, params: Record<string, unknown>): Record<string, unknown> {
    this.jobsCreated.push({ type, params });
    const job: FakeJob = {
      id: `job-${randomUUID()}`,
      type,
      params,
      polls: 0,
      extra: {},
      totalChapters: 0,
      cancelled: false,
      outcome: null,
    };
    this.resolveJob(job);
    this.jobs.set(job.id, job);
    return this.jobJson(job);
  }

  private resolveJob(job: FakeJob): void {
    const volumeSerials = this.volumeSerialsOf(job);
    const ruleIndex = this.failureRules.findIndex(
      (rule) =>
        rule.type === job.type &&
        (rule.volumeSerial === undefined || volumeSerials.includes(rule.volumeSerial)) &&
        (rule.domain === undefined || rule.domain === job.params['domain']),
    );
    if (ruleIndex >= 0) {
      const rule = this.failureRules[ruleIndex]!;
      job.outcome = rule;
      rule.times -= 1;
      if (rule.times <= 0) this.failureRules.splice(ruleIndex, 1);
    }

    if (job.type === 'search-sources') {
      const query = text(job.params['query']).toLowerCase();
      const domain = text(job.params['domain']);
      job.extra['search_results'] = [...this.novels.values()]
        .filter((novel) => !job.outcome && novel.domain === domain && novel.title.toLowerCase().includes(query))
        .map((novel) => ({ title: novel.title, url: novel.url, info: novel.info }));
    } else if (job.type === 'fetch-novels') {
      const urls = (job.params['urls'] as string[] | undefined) ?? [];
      const novel = [...this.novels.values()].find((entry) => entry.url === urls[0]);
      if (novel) job.extra['novel_id'] = novel.id;
      else job.outcome = job.outcome ?? { type: job.type, times: 1, error: 'unsupported link' };
    } else if (job.type === 'fetch-volumes') {
      for (const novel of this.novels.values()) {
        const wanted = novel.volumes.filter((volume) => ((job.params['volumes'] as string[]) ?? []).includes(volume.id));
        job.totalChapters += wanted.reduce((sum, volume) => sum + volume.chapterCount, 0);
      }
    } else if (job.type === 'make-artifacts') {
      const novelId = text(job.params['novel_id']);
      const volume = typeof job.params['volume'] === 'number' ? (job.params['volume'] as number) : null;
      const novel = this.novels.get(novelId);
      if (novel && !job.outcome) {
        const suffix = volume === null ? 'All' : `Vol_${String(volume).padStart(3, '0')}`;
        this.artifacts.push({
          id: `artifact-${randomUUID()}`,
          novelId,
          volume,
          fileName: `${novel.title}.${suffix}.epub`,
          createdAt: (this.artifactClock += 1000),
        });
      }
    }
  }

  private volumeSerialsOf(job: FakeJob): number[] {
    if (job.type === 'make-artifacts') return typeof job.params['volume'] === 'number' ? [job.params['volume'] as number] : [];
    if (job.type !== 'fetch-volumes') return [];
    const ids = (job.params['volumes'] as string[] | undefined) ?? [];
    return [...this.novels.values()].flatMap((novel) => novel.volumes.filter((volume) => ids.includes(volume.id)).map((volume) => volume.serial));
  }

  private jobJson(job: FakeJob): Record<string, unknown> {
    const needed = this.jobPolls.get(job.type) ?? this.defaultJobPolls;
    const base = { id: job.id, extra: job.extra, type: 0, error: null as string | null, failed: 0 };
    if (job.cancelled) {
      return { ...base, status: 4, is_done: true, is_running: 0, progress: 0, done: 0, total: job.totalChapters };
    }
    if (job.polls < needed) {
      const fraction = job.polls / needed;
      return {
        ...base,
        status: job.polls === 0 ? 0 : 1,
        is_done: false,
        is_running: job.polls === 0 ? 0 : 1,
        progress: Math.round(fraction * 100),
        done: Math.floor(job.totalChapters * fraction),
        total: job.totalChapters,
      };
    }
    if (job.outcome) {
      return {
        ...base,
        status: 3,
        is_done: true,
        is_running: 0,
        progress: 100,
        done: Math.max(0, job.totalChapters - (job.outcome.failed ?? 0)),
        total: job.totalChapters,
        error: job.outcome.error ?? null,
        failed: job.outcome.failed ?? 0,
      };
    }
    return { ...base, status: 2, is_done: true, is_running: 0, progress: 100, done: job.totalChapters, total: job.totalChapters };
  }
}

// --------------------------------------------------------------------------------------------
// MangaBaka and MangaDex
// --------------------------------------------------------------------------------------------

export interface FakeBakaSeriesInput {
  id: number;
  title: string;
  type?: 'manga' | 'novel' | 'manhwa' | 'manhua' | 'oel' | 'other';
  authors?: string[];
  artists?: string[];
  status?: string;
  year?: number | null;
  genres?: string[];
  anilistId?: number | null;
  secondaryTitles?: string[];
  state?: string;
  mergedWith?: number | null;
  description?: string | null;
  /** Served as the series cover; the proxy only follows https, so a fake http address is refused. */
  coverUrl?: string | null;
}

export class FakeMangaBaka extends FakeHttpServer {
  readonly series = new Map<number, FakeBakaSeriesInput>();

  addSeries(input: FakeBakaSeriesInput): FakeBakaSeriesInput {
    this.series.set(input.id, input);
    return input;
  }

  private json(series: FakeBakaSeriesInput) {
    return {
      id: series.id,
      state: series.state ?? 'active',
      merged_with: series.mergedWith ?? null,
      title: series.title,
      native_title: null,
      romanized_title: null,
      secondary_titles: series.secondaryTitles ? { en: series.secondaryTitles.map((title) => ({ title })) } : null,
      authors: series.authors ?? [],
      artists: series.artists ?? [],
      status: series.status ?? 'releasing',
      year: series.year === undefined ? 2020 : series.year,
      genres: series.genres ?? [],
      type: series.type ?? 'manga',
      content_rating: 'safe',
      description: series.description ?? null,
      cover: series.coverUrl ? { default: series.coverUrl, raw: null, small: null } : null,
      source: series.anilistId ? { anilist: { id: series.anilistId } } : null,
    };
  }

  protected async route(req: FakeRequest, res: ServerResponse): Promise<void> {
    const path = req.url.pathname;
    const query = (req.url.searchParams.get('q') ?? '').toLowerCase();
    let match: RegExpExecArray | null;
    if (path === '/v1/series/search') {
      req.record.op = 'search';
      await this.pause('search');
      if (this.applyFailure(req, res)) return;
      const wantNovel = req.url.searchParams.get('type') === 'novel';
      const hits = [...this.series.values()]
        .filter((series) => ((series.type ?? 'manga') === 'novel') === wantNovel)
        .filter((series) => [series.title, ...(series.secondaryTitles ?? [])].some((title) => title.toLowerCase().includes(query)))
        .slice(0, Number(req.url.searchParams.get('limit') ?? 5))
        .map((series) => this.json(series));
      return sendJson(res, 200, { status: 200, data: hits });
    }
    if (path === '/v1/series/match') {
      req.record.op = 'match';
      await this.pause('match');
      if (this.applyFailure(req, res)) return;
      const hit = [...this.series.values()].find((series) => series.title.toLowerCase() === query);
      return sendJson(res, 200, { status: 200, data: hit ? [this.json(hit)] : [] });
    }
    if ((match = /^\/v1\/series\/(\d+)$/.exec(path))) {
      req.record.op = 'series';
      await this.pause('series');
      if (this.applyFailure(req, res)) return;
      const series = this.series.get(Number(match[1]));
      if (!series) return sendJson(res, 404, { status: 404, error: 'not found' });
      return sendJson(res, 200, { status: 200, data: this.json(series) });
    }
    req.record.op = 'unknown';
    return sendText(res, 404, 'not found');
  }
}

export interface FakeDexEntry {
  id: string;
  title: string;
  anilistId: number;
  /** Volume number to the chapter numbers it holds. */
  volumes: Record<string, number[]>;
}

export class FakeMangaDex extends FakeHttpServer {
  readonly entries: FakeDexEntry[] = [];

  addEntry(entry: FakeDexEntry): FakeDexEntry {
    this.entries.push(entry);
    return entry;
  }

  protected async route(req: FakeRequest, res: ServerResponse): Promise<void> {
    const path = req.url.pathname;
    let match: RegExpExecArray | null;
    if (path === '/manga') {
      req.record.op = 'search';
      await this.pause('search');
      if (this.applyFailure(req, res)) return;
      const title = (req.url.searchParams.get('title') ?? '').toLowerCase();
      const data = this.entries
        .filter((entry) => entry.title.toLowerCase().includes(title))
        .map((entry) => ({ id: entry.id, attributes: { links: { al: String(entry.anilistId) } } }));
      return sendJson(res, 200, { data });
    }
    if ((match = /^\/manga\/([^/]+)\/aggregate$/.exec(path))) {
      req.record.op = 'aggregate';
      await this.pause('aggregate');
      if (this.applyFailure(req, res)) return;
      const entry = this.entries.find((candidate) => candidate.id === match![1]);
      if (!entry) return sendJson(res, 404, {});
      const volumes: Record<string, unknown> = {};
      for (const [volume, chapters] of Object.entries(entry.volumes)) {
        volumes[volume] = {
          volume,
          chapters: Object.fromEntries(chapters.map((chapter) => [String(chapter), { chapter: String(chapter) }])),
        };
      }
      return sendJson(res, 200, { volumes });
    }
    req.record.op = 'unknown';
    return sendText(res, 404, 'not found');
  }
}

/**
 * The lookup clients talk to fixed public hosts. Their one request method is redirected to the
 * fakes, so request parsing, envelopes and error mapping all still run for real while no packet
 * leaves the machine. Returns a function that undoes the redirect.
 */
export function installLookupStubs(baka: FakeMangaBaka, dex: FakeMangaDex): () => void {
  const bakaSpy = vi
    .spyOn(MangaBakaClient.prototype as unknown as { get: (path: string, signal?: AbortSignal) => Promise<unknown> }, 'get')
    .mockImplementation(async (path: string, signal?: AbortSignal) => {
      const response = await fetch(`${baka.url}${path}`, { headers: { Accept: 'application/json' }, signal });
      if (!response.ok) throw new Error('MangaBaka did not accept the request');
      const envelope = (await response.json()) as { status?: number; data?: unknown };
      if (typeof envelope.status === 'number' && (envelope.status < 200 || envelope.status >= 300)) throw new Error('MangaBaka unsuccessful');
      return envelope.data;
    });
  const dexSpy = vi
    .spyOn(MangaDexClient.prototype as unknown as { get: (path: string, signal?: AbortSignal) => Promise<unknown> }, 'get')
    .mockImplementation(async (path: string, signal?: AbortSignal) => {
      const response = await fetch(`${dex.url}${path}`, { headers: { Accept: 'application/json' }, signal });
      if (!response.ok) throw new Error('MangaDex did not accept the request');
      return response.json();
    });
  return () => {
    bakaSpy.mockRestore();
    dexSpy.mockRestore();
  };
}

// --------------------------------------------------------------------------------------------
// novel-sources (LNReader sources service)
// --------------------------------------------------------------------------------------------

export interface FakeNovelSource {
  id: string;
  name: string;
  site: string;
  /** LNReader filter definitions; the default has an order picker with latest and A-Z options. */
  filters?: Record<string, unknown>;
}

export interface FakeSourceNovel {
  sourceId: string;
  path: string;
  name: string;
  cover?: string | null;
  status?: string;
  chapters?: number;
  /** Higher is newer, for the latest listing. */
  updated?: number;
  /** Defaults to the author of the Omniscient Reader fixtures. */
  author?: string;
}

export const FAKE_ORDER_FILTER = {
  orderBy: {
    type: 'Picker',
    label: 'Order by',
    value: '',
    options: [
      { label: 'Default', value: '' },
      { label: 'Latest', value: 'latest' },
      { label: 'A-Z', value: 'alphabetical' },
    ],
  },
};

export class FakeNovelSources extends FakeHttpServer {
  readonly sources: FakeNovelSource[] = [];
  readonly novels: FakeSourceNovel[] = [];
  pageSize = 3;
  readonly browseCalls: Array<{ sourceId: string; page: number; latest: boolean; order: string | null }> = [];
  /** The next browse of this source and page answers 503 once. */
  failBrowse: { sourceId: string; page: number } | null = null;
  /** Chapter paths that answer 502 every time. */
  readonly failChapters = new Set<string>();
  /** Every chapter path asked for, in order. */
  readonly chapterCalls: string[] = [];
  /** Chapter paths held open until their gate is released or the caller hangs up. */
  readonly heldChapters = new Map<string, Gate>();

  holdChapter(path: string): Gate {
    const gate = new Gate();
    this.heldChapters.set(path, gate);
    return gate;
  }

  addSource(source: Omit<FakeNovelSource, 'site'> & { site?: string }): FakeNovelSource {
    const entry = { site: `https://${source.id}.example/`, filters: FAKE_ORDER_FILTER, ...source };
    this.sources.push(entry);
    return entry;
  }

  addNovel(novel: FakeSourceNovel): FakeSourceNovel {
    this.novels.push({ cover: null, status: 'Ongoing', chapters: 5, updated: this.novels.length, ...novel });
    return novel;
  }

  resetState(): void {
    this.sources.length = 0;
    this.novels.length = 0;
    this.browseCalls.length = 0;
    this.failBrowse = null;
    this.failChapters.clear();
    this.chapterCalls.length = 0;
    for (const gate of this.heldChapters.values()) gate.release();
    this.heldChapters.clear();
    this.pageSize = 3;
  }

  private listed(sourceId: string, order: string | null, latest: boolean): FakeSourceNovel[] {
    const list = this.novels.filter((novel) => novel.sourceId === sourceId);
    if (order === 'alphabetical') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (order === 'latest' || latest) return [...list].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    return list;
  }

  private item(novel: FakeSourceNovel) {
    const source = this.sources.find((entry) => entry.id === novel.sourceId)!;
    return { name: novel.name, path: novel.path, url: new URL(novel.path, source.site).href, cover: novel.cover ?? null };
  }

  protected async route(req: FakeRequest, res: ServerResponse): Promise<void> {
    const path = req.url.pathname;
    let match: RegExpExecArray | null;
    if (path === '/api/v1/health') {
      req.record.op = 'health';
      return sendJson(res, 200, { ok: true, version: '1.0.0', installed: this.sources.length });
    }
    if (path === '/api/v1/sources' && req.method === 'GET') {
      req.record.op = 'sources';
      return sendJson(
        res,
        200,
        this.sources.map((source) => ({
          id: source.id,
          name: source.name,
          site: source.site,
          lang: 'English',
          version: '1.0.0',
          filters: source.filters ?? {},
        })),
      );
    }
    if ((match = /^\/api\/v1\/sources\/([^/]+)(?:\/([a-z]+))?$/.exec(path))) {
      const sourceId = decodeURIComponent(match[1]!);
      const action = match[2] ?? '';
      req.record.op = `${action || req.method.toLowerCase()}:${sourceId}`;
      await this.pause(req.record.op);
      if (this.applyFailure(req, res)) return;
      const source = this.sources.find((entry) => entry.id === sourceId);
      if (!action && req.method === 'DELETE') {
        const index = this.sources.findIndex((entry) => entry.id === sourceId);
        if (index >= 0) this.sources.splice(index, 1);
        res.writeHead(204).end();
        return;
      }
      if (!source) return sendJson(res, 404, { error: 'Source is not installed' });
      if (action === 'browse') {
        const page = Number(req.url.searchParams.get('page') ?? '1');
        const latest = req.url.searchParams.get('latest') === '1';
        const filters = req.url.searchParams.get('filters');
        const value = filters ? (JSON.parse(filters) as { orderBy?: { value?: unknown } }).orderBy?.value : undefined;
        const order = filters ? (typeof value === 'string' ? value : '') : null;
        this.browseCalls.push({ sourceId, page, latest, order });
        if (this.failBrowse && this.failBrowse.sourceId === sourceId && this.failBrowse.page === page) {
          this.failBrowse = null;
          return sendJson(res, 503, { error: 'site timeout', code: 'TIMEOUT_X' });
        }
        const items = this.listed(sourceId, order, latest)
          .slice((page - 1) * this.pageSize, page * this.pageSize)
          .map((novel) => this.item(novel));
        return sendJson(res, 200, { items, page, hasMore: items.length > 0 });
      }
      if (action === 'search') {
        const q = (req.url.searchParams.get('q') ?? '').toLowerCase();
        const items = this.novels
          .filter((novel) => novel.sourceId === sourceId && novel.name.toLowerCase().includes(q))
          .map((novel) => this.item(novel));
        return sendJson(res, 200, { items, page: 1, hasMore: false });
      }
      if (action === 'chapter') {
        const chapterPath = req.url.searchParams.get('path') ?? '';
        this.chapterCalls.push(chapterPath);
        const gate = this.heldChapters.get(chapterPath);
        if (gate && !gate.isReleased) {
          gate.touch();
          while (!gate.isReleased && !req.socket.destroyed) await delay(20);
          if (req.socket.destroyed) return;
        }
        if (this.failChapters.has(chapterPath)) return sendJson(res, 502, { error: 'The site failed', code: 'SITE_FAILED' });
        return sendJson(res, 200, { html: `<p>Text of ${chapterPath}.</p>` });
      }
      if (action === 'novel') {
        const novelPath = req.url.searchParams.get('path');
        const novel = this.novels.find((entry) => entry.sourceId === sourceId && entry.path === novelPath);
        if (!novel) return sendJson(res, 404, { error: 'Novel not found' });
        return sendJson(res, 200, {
          ...this.item(novel),
          author: novel.author ?? 'Sing Shong',
          summary: 'A reader survives.',
          status: novel.status,
          genres: ['Fantasy'],
          chapters: Array.from({ length: novel.chapters ?? 5 }, (_, index) => ({
            name: `Chapter ${index + 1}`,
            path: `${novel.path}/c${index + 1}`,
          })),
        });
      }
    }
    req.record.op = 'unknown';
    return sendText(res, 404, 'not found');
  }
}

// --------------------------------------------------------------------------------------------
// All of them together
// --------------------------------------------------------------------------------------------

export interface FakeEngines {
  suwayomi: FakeSuwayomi;
  lncrawl: FakeLncrawl;
  mangabaka: FakeMangaBaka;
  mangadex: FakeMangaDex;
  novelSources: FakeNovelSources;
  restoreLookupStubs: () => void;
  stop: () => Promise<void>;
  resetAll: () => void;
}

export async function startFakeEngines(): Promise<FakeEngines> {
  const suwayomi = new FakeSuwayomi();
  const lncrawl = new FakeLncrawl();
  const mangabaka = new FakeMangaBaka();
  const mangadex = new FakeMangaDex();
  const novelSources = new FakeNovelSources();
  await Promise.all([suwayomi.start(), lncrawl.start(), mangabaka.start(), mangadex.start(), novelSources.start()]);
  const restoreLookupStubs = installLookupStubs(mangabaka, mangadex);
  return {
    suwayomi,
    lncrawl,
    mangabaka,
    mangadex,
    novelSources,
    restoreLookupStubs,
    stop: async () => {
      restoreLookupStubs();
      await Promise.all([suwayomi.stop(), lncrawl.stop(), mangabaka.stop(), mangadex.stop(), novelSources.stop()]);
    },
    resetAll: () => {
      novelSources.resetState();
      for (const server of [suwayomi, lncrawl, mangabaka, mangadex, novelSources]) {
        server.resetStats();
        server.clearFailures();
        server.latencyMs = 0;
        server.opLatencyMs.clear();
      }
      suwayomi.clearPlans();
      suwayomi.resetDownloads();
      suwayomi.mangas.clear();
      suwayomi.extensions.length = 0;
      suwayomi.repos.length = 0;
      suwayomi.credentials = null;
      lncrawl.resetState();
      suwayomi.sources.length = 1;
      mangabaka.series.clear();
      mangadex.entries.length = 0;
    },
  };
}
