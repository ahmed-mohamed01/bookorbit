import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import v8 from 'v8';
import vm from 'vm';

import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { vi } from 'vitest';
import type {
  WebSerialJob,
  WebSerialJobDetail,
  WebSerialJobList,
  WebSerialSeriesDetail,
  WebSerialSeriesLookup,
  WebSerialSourceOptions,
} from '@bookorbit/types';

import { webSerialNovelIndex } from '../src/modules/web-serials/schema/web-serials.schema';
import { WebSerialsImportService } from '../src/modules/web-serials/web-serials-import.service';
import { WebSerialsNovelIndexRepository } from '../src/modules/web-serials/web-serials-novel-index.repository';
import { WebSerialsRepository } from '../src/modules/web-serials/web-serials.repository';
import {
  api,
  closeWebSerialsContext,
  configureEngines,
  countBooks,
  createJob,
  createLibrary,
  createWebSerialsContext,
  resetWebSerialsState,
  TERMINAL_STATUSES,
  type WebSerialsContext,
  type WebSerialsLibrary,
} from './e2e/web-serials/web-serials-harness';
import { generateMangaChapters, generateNovelVolumes, type FakeManga, type FakeNovel } from './e2e/web-serials/fake-serial-engines';

/**
 * Scale checks for the shapes of the biggest series people ask for: a 1,160 chapter manga (One Piece) as
 * chapters and as ~110 volumes, and a 2,100 chapter novel (The Wandering Inn) as volumes and as one book.
 *
 * Opt in with WEB_SERIALS_SCALE=1. The runs take minutes, so the wrapper's default 15 minute cap needs raising:
 *   WEB_SERIALS_SCALE=1 E2E_DATABASE_URL=... node ../scripts/dev/with-test-lock.mjs --run-timeout=3600000 -- \
 *     vitest run --config vitest.config.e2e.ts test/web-serials-scale.e2e-spec.ts
 */
const enabled = process.env.WEB_SERIALS_SCALE === '1';
const describeScale = enabled ? describe : describe.skip;

vi.setConfig({ testTimeout: 30 * 60_000, hookTimeout: 5 * 60_000 });

const MANGA_CHAPTERS = 1160;
const MANGA_CHAPTERS_PER_VOLUME = 11;
const NOVEL_VOLUMES = 21;
const NOVEL_CHAPTERS_PER_VOLUME = 100;
const LATENCY_BUDGET_MS = 500;
const RSS_GROWTH_CAP_MB = 300;
const MB = 1024 * 1024;
const HEAP_RETAINED_CAP_MB = 64;
/** Index search budgets, about three times the medians measured on a laptop so a slower CI machine still passes. */
const INDEX_FEW_SOURCES_MS = 75;
const INDEX_NO_MATCH_MS = 12;
const INDEX_COMMON_WORD_MS = 50;
const INDEX_WORDS = [
  'the',
  'i',
  'my',
  'a',
  'reincarnated',
  'return',
  'of',
  'villainess',
  'in',
  'another',
  'world',
  'with',
  'level',
  'up',
  'system',
  'demon',
  'king',
  'is',
  'god',
  'sword',
  'saint',
  'dragon',
  'academy',
  'tower',
  'hunter',
  'solo',
  'strongest',
  'mage',
  'as',
  'was',
  'but',
  'and',
  'to',
  'an',
  'otome',
  'game',
  'duke',
  'daughter',
  'prince',
  'princess',
  'emperor',
  'martial',
  'regression',
  'regressor',
  'genius',
  'talent',
  'monster',
  'slime',
  'spider',
  'so',
  'what',
  'lady',
  'knight',
  'healer',
  'alchemist',
  'farming',
  'life',
  'slow',
  'cheat',
  'skill',
  'dungeon',
  'summoned',
  'hero',
  'party',
  'kicked',
  'out',
  'revenge',
  'time',
  'loop',
  'second',
  'chance',
  'after',
  'death',
  'became',
  'abandoned',
  'fiance',
  'engagement',
  'broken',
  'cursed',
  'witch',
  'familiar',
  'beast',
  'tamer',
  'rank',
  'f',
  's',
  'class',
  'overpowered',
  'lazy',
  'noble',
  'house',
  'family',
  'youngest',
  'eldest',
  'son',
  'heir',
  'apocalypse',
  'zombie',
  'survival',
  'tutorial',
  'floor',
  'clear',
  'player',
  'returned',
  'hidden',
  'legendary',
  'blacksmith',
  'chef',
  'merchant',
  'shop',
  'inn',
  'isekai',
  'transmigrated',
  'novel',
  'extra',
  'side',
  'character',
  'mob',
  'villain',
  'cultivation',
  'immortal',
  'sect',
  'realm',
  'heaven',
  'path',
  'peak',
  'supreme',
  'divine',
  'ancestor',
  'young',
  'master',
  'evil',
  'sovereign',
];

/** A forced collection without needing --expose-gc on the command line, so heap numbers mean retained memory rather than garbage. */
function loadCollector(): () => void {
  v8.setFlagsFromString('--expose_gc');
  return vm.runInNewContext('gc') as () => void;
}

interface ItemEvent {
  at: number;
  pgQueries: number;
  repoCalls: number;
  importMs: number;
}

interface ScenarioSummary {
  scenario: string;
  units: number;
  engineChapters: number;
  wallSeconds: number;
  unitsPerSecond: number;
  engineDownloadsPerSecond: number;
  window: number;
  msPerUnitFirst: number;
  msPerUnitLast: number;
  pgQueriesPerUnitFirst: number;
  pgQueriesPerUnitLast: number;
  repoCallsPerUnit: number;
  importMsPerUnitFirst: number;
  importMsPerUnitLast: number;
  engineRequestsPerChapter: number;
  engineRequestsByOp: Record<string, number>;
  rssStartMb: number;
  rssPeakMb: number;
  rssEndMb: number;
  heapStartMb: number;
  heapEndMb: number;
  createJobMs: number;
  previewSeriesMs: number;
  previewLookupMs: number;
  previewSourcesMs: number;
  listJobsIdleMaxMs: number;
  detailIdleMaxMs: number;
  detailPayloadKb: number;
  listJobsBusyP50Ms: number;
  listJobsBusyMaxMs: number;
  detailBusyP50Ms: number;
  detailBusyMaxMs: number;
}

const summaries: ScenarioSummary[] = [];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  const value = await run();
  return { value, ms: performance.now() - startedAt };
}

describeScale('Web Serials at scale (e2e)', () => {
  let ctx!: WebSerialsContext;
  let library!: WebSerialsLibrary;

  let pgQueries = 0;
  let restorePg: (() => void) | null = null;
  let events: ItemEvent[] = [];
  let repoCalls = 0;
  let importMs = 0;
  let restoreInstrumentation: (() => void) | null = null;

  beforeAll(async () => {
    ctx = await createWebSerialsContext();
    const original = Client.prototype.query;
    (Client.prototype as unknown as { query: unknown }).query = function (this: Client, ...args: unknown[]) {
      pgQueries += 1;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restorePg = () => {
      (Client.prototype as unknown as { query: unknown }).query = original;
    };
  });

  afterAll(async () => {
    restorePg?.();
    if (ctx) await closeWebSerialsContext(ctx);
    if (summaries.length > 0) await reportSummaries();
  });

  beforeEach(async () => {
    await resetWebSerialsState(ctx);
    library = await createLibrary(ctx);
    events = [];
    repoCalls = 0;
    importMs = 0;
    instrument();
  });

  afterEach(() => {
    restoreInstrumentation?.();
    restoreInstrumentation = null;
  });

  /** Counts repository calls, notes every imported item, and times the Book Dock hand-off, without changing behaviour. */
  function instrument(): void {
    const repo = ctx.app.get(WebSerialsRepository) as unknown as Record<string, unknown>;
    const importer = ctx.app.get(WebSerialsImportService) as unknown as { importUnit: (request: unknown) => Promise<number> };
    const replaced: Array<[object, string, unknown]> = [];
    const names = Object.getOwnPropertyNames(WebSerialsRepository.prototype).filter((name) => name !== 'constructor');
    for (const name of names) {
      const original = repo[name];
      if (typeof original !== 'function') continue;
      replaced.push([repo, name, Object.getOwnPropertyDescriptor(repo, name)?.value]);
      repo[name] = (...args: unknown[]) => {
        const result = (original as (...a: unknown[]) => unknown).apply(repo, args);
        if (!(result instanceof Promise)) return result;
        repoCalls += 1;
        return result.then((value: unknown) => {
          if (name === 'updateItem' && (args[1] as { status?: string } | undefined)?.status === 'imported') {
            events.push({ at: performance.now(), pgQueries, repoCalls, importMs });
          }
          return value;
        });
      };
    }
    const importOriginal = importer.importUnit;
    importer.importUnit = async function (this: unknown, request: unknown) {
      const startedAt = performance.now();
      try {
        return await importOriginal.call(importer, request);
      } finally {
        importMs += performance.now() - startedAt;
      }
    };
    restoreInstrumentation = () => {
      for (const [target, name, value] of replaced) {
        if (value === undefined) delete (target as Record<string, unknown>)[name];
        else (target as Record<string, unknown>)[name] = value;
      }
      importer.importUnit = importOriginal;
    };
  }

  function seedBigManga(options: { chaptersPerVolume?: number } = {}): FakeManga {
    ctx.fakes.suwayomi.addSource({ id: '1001', name: 'Scale Scans', lang: 'en' });
    return ctx.fakes.suwayomi.addManga({
      title: 'Scale Pirates',
      author: 'Scale Author',
      artist: 'Scale Artist',
      chapters: generateMangaChapters({ count: MANGA_CHAPTERS, pages: 2, chaptersPerVolume: options.chaptersPerVolume }),
    });
  }

  function seedBigNovel(): FakeNovel {
    return ctx.fakes.lncrawl.addNovel({
      title: 'Scale Inn',
      authors: 'Scale Writer',
      volumes: generateNovelVolumes(NOVEL_VOLUMES, NOVEL_CHAPTERS_PER_VOLUME),
    });
  }

  async function runScenario(
    scenario: string,
    body: Record<string, unknown>,
    expected: { units: number; books: number; engineChapters: number; engineFake: 'suwayomi' | 'lncrawl' },
  ): Promise<ScenarioSummary> {
    const seriesKey = body['seriesKey'] as string;

    // What a user waits for in the preview of a huge series.
    const series = await timed(() => api(ctx, 'GET', `/web-serials/series/${seriesKey}`, ctx.user.token));
    expect(series.value.statusCode).toBe(200);
    if (expected.engineFake === 'suwayomi') expect((series.value.json() as WebSerialSeriesDetail).units).toHaveLength(expected.engineChapters);
    const lookup = await timed(() => api(ctx, 'GET', `/web-serials/series/${seriesKey}/lookup`, ctx.user.token));
    expect((lookup.value.json() as WebSerialSeriesLookup).state).toBeDefined();
    const sources = await timed(() => api(ctx, 'GET', `/web-serials/series/${seriesKey}/sources`, ctx.user.token));
    expect((sources.value.json() as WebSerialSourceOptions).options.length).toBeGreaterThanOrEqual(1);
    for (const preview of [series, lookup, sources]) expect(preview.ms).toBeLessThan(LATENCY_BUDGET_MS);

    const engine = expected.engineFake === 'suwayomi' ? ctx.fakes.suwayomi : ctx.fakes.lncrawl;
    engine.resetStats();
    ctx.fakes.mangabaka.resetStats();
    const collect = loadCollector();
    collect();
    const rssStart = process.memoryUsage().rss;
    const heapStart = process.memoryUsage().heapUsed;
    let rssPeak = rssStart;
    const rssTimer = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 200);
    const queriesAtStart = pgQueries;

    const created = await timed(() => createJob(ctx, ctx.user.token, body));
    const startedAt = performance.now();
    const listBusy: number[] = [];
    const detailBusy: number[] = [];
    let lastReport = startedAt;
    let final: WebSerialJob | undefined;
    try {
      for (;;) {
        await ctx.runner.tick();
        const list = await timed(() => api(ctx, 'GET', '/web-serials/jobs?limit=50', ctx.user.token));
        const job = (list.value.json() as WebSerialJobList).items.find((item) => item.id === created.value.id)!;
        listBusy.push(list.ms);
        if (detailBusy.length < 400 && listBusy.length % 3 === 0) {
          const detail = await timed(() => api(ctx, 'GET', `/web-serials/jobs/${created.value.id}`, ctx.user.token));
          detailBusy.push(detail.ms);
        }
        final = job;
        if (TERMINAL_STATUSES.includes(job.status)) break;
        if (performance.now() - lastReport > 15_000) {
          lastReport = performance.now();
          console.log(
            `[scale:${scenario}] ${job.status} ${job.unitsDone}/${job.unitsTotal} units, ${round((performance.now() - startedAt) / 1000)}s`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } finally {
      clearInterval(rssTimer);
    }
    const wallSeconds = (performance.now() - startedAt) / 1000;
    const rssEnd = process.memoryUsage().rss;
    collect();
    const heapEnd = process.memoryUsage().heapUsed;

    expect(final?.status).toBe('completed');
    expect(final).toMatchObject({ unitsTotal: expected.units, unitsDone: expected.units, unitsFailed: 0, unitsSkipped: 0 });
    expect(await countBooks(ctx, library.libraryId)).toBe(expected.books);
    expect(events).toHaveLength(expected.units);

    const idleList: number[] = [];
    const idleDetail: number[] = [];
    let payloadBytes = 0;
    for (let index = 0; index < 15; index += 1) {
      idleList.push((await timed(() => api(ctx, 'GET', '/web-serials/jobs?limit=50', ctx.user.token))).ms);
      const detail = await timed(() => api(ctx, 'GET', `/web-serials/jobs/${created.value.id}`, ctx.user.token));
      idleDetail.push(detail.ms);
      payloadBytes = detail.value.rawPayload.length;
      expect((detail.value.json() as WebSerialJobDetail).items).toHaveLength(expected.units);
    }

    const window = Math.max(1, Math.min(100, Math.floor(expected.units / 4)));
    const first = events.slice(0, window);
    const last = events.slice(-window);
    const gap = (slice: ItemEvent[], before: ItemEvent | undefined, key: keyof ItemEvent) => {
      const start = before ? before[key] : key === 'at' ? startedAt : key === 'pgQueries' ? queriesAtStart : 0;
      return (slice[slice.length - 1]![key] - start) / slice.length;
    };
    const lastBefore = events[events.length - window - 1];

    const requests = engine.requests.length;
    const summary: ScenarioSummary = {
      scenario,
      units: expected.units,
      engineChapters: expected.engineChapters,
      wallSeconds: round(wallSeconds),
      unitsPerSecond: round(expected.units / wallSeconds, 2),
      engineDownloadsPerSecond: round(
        (expected.engineFake === 'suwayomi' ? engine.count('download') : engine.count('static:artifact')) / wallSeconds,
        2,
      ),
      window,
      msPerUnitFirst: round(gap(first, undefined, 'at')),
      msPerUnitLast: round(gap(last, lastBefore, 'at')),
      pgQueriesPerUnitFirst: round(gap(first, undefined, 'pgQueries')),
      pgQueriesPerUnitLast: round(gap(last, lastBefore, 'pgQueries')),
      repoCallsPerUnit: round(repoCalls / expected.units),
      importMsPerUnitFirst: round(gap(first, undefined, 'importMs')),
      importMsPerUnitLast: round(gap(last, lastBefore, 'importMs')),
      engineRequestsPerChapter: round(requests / expected.engineChapters, 2),
      engineRequestsByOp: engine.countsByOp(),
      rssStartMb: round(rssStart / MB),
      rssPeakMb: round(rssPeak / MB),
      rssEndMb: round(rssEnd / MB),
      heapStartMb: round(heapStart / MB),
      heapEndMb: round(heapEnd / MB),
      createJobMs: round(created.ms),
      previewSeriesMs: round(series.ms),
      previewLookupMs: round(lookup.ms),
      previewSourcesMs: round(sources.ms),
      listJobsIdleMaxMs: round(Math.max(...idleList)),
      detailIdleMaxMs: round(Math.max(...idleDetail)),
      detailPayloadKb: round(payloadBytes / 1024),
      listJobsBusyP50Ms: round(percentile(listBusy, 0.5)),
      listJobsBusyMaxMs: round(Math.max(...listBusy)),
      detailBusyP50Ms: round(percentile(detailBusy, 0.5)),
      detailBusyMaxMs: round(Math.max(0, ...detailBusy)),
    };
    summaries.push(summary);

    expect(summary.listJobsIdleMaxMs).toBeLessThan(LATENCY_BUDGET_MS);
    expect(summary.detailIdleMaxMs).toBeLessThan(LATENCY_BUDGET_MS);
    expect(summary.listJobsBusyP50Ms).toBeLessThan(LATENCY_BUDGET_MS);
    expect(summary.detailBusyP50Ms).toBeLessThan(LATENCY_BUDGET_MS);
    expect(summary.rssPeakMb - summary.rssStartMb).toBeLessThan(RSS_GROWTH_CAP_MB);
    expect(summary.rssEndMb - summary.rssStartMb).toBeLessThan(RSS_GROWTH_CAP_MB);
    expect(summary.heapEndMb - summary.heapStartMb).toBeLessThan(HEAP_RETAINED_CAP_MB);
    // The runner's per-unit cost must not grow with the size of the job. The bounds are loose on purpose: they catch a
    // quadratic loop, not a noisy machine.
    expect(summary.msPerUnitLast).toBeLessThan(summary.msPerUnitFirst * 3 + 50);
    expect(summary.pgQueriesPerUnitLast).toBeLessThan(summary.pgQueriesPerUnitFirst * 1.5 + 5);
    return summary;
  }

  it('downloads a 1,160 chapter manga one book per chapter', async () => {
    const manga = seedBigManga();
    await configureEngines(ctx, { library, novel: false, maxConcurrentJobs: 1 });
    const summary = await runScenario(
      'manga-per-chapter',
      { seriesKey: `m:${manga.id}`, packaging: 'chapter', selection: { mode: 'all' }, libraryId: library.libraryId },
      { units: MANGA_CHAPTERS, books: MANGA_CHAPTERS, engineChapters: MANGA_CHAPTERS, engineFake: 'suwayomi' },
    );

    const suwayomi = ctx.fakes.suwayomi;
    expect(suwayomi.count('graphql:BookOrbitDownload')).toBe(MANGA_CHAPTERS);
    expect(suwayomi.count('download')).toBe(MANGA_CHAPTERS);
    expect(suwayomi.maxPerChapter(suwayomi.enqueues)).toBe(1);
    expect(suwayomi.maxPerChapter(suwayomi.downloads)).toBe(1);
    expect(suwayomi.maxPerChapter(suwayomi.polls)).toBeLessThanOrEqual(2);
    expect(suwayomi.peakInFlight).toBeLessThanOrEqual(2);
    expect(summary.engineRequestsPerChapter).toBeLessThanOrEqual(4);
  });

  it('downloads a 1,160 chapter manga merged into about 110 volumes', async () => {
    const manga = seedBigManga({ chaptersPerVolume: MANGA_CHAPTERS_PER_VOLUME });
    await configureEngines(ctx, { library, novel: false, maxConcurrentJobs: 1 });
    const volumes = Math.ceil(MANGA_CHAPTERS / MANGA_CHAPTERS_PER_VOLUME);
    const summary = await runScenario(
      'manga-per-volume',
      { seriesKey: `m:${manga.id}`, packaging: 'volume', selection: { mode: 'all' }, libraryId: library.libraryId },
      { units: volumes, books: volumes, engineChapters: MANGA_CHAPTERS, engineFake: 'suwayomi' },
    );

    const suwayomi = ctx.fakes.suwayomi;
    expect(suwayomi.count('download')).toBe(MANGA_CHAPTERS);
    expect(suwayomi.maxPerChapter(suwayomi.enqueues)).toBe(1);
    expect(suwayomi.maxPerChapter(suwayomi.downloads)).toBe(1);
    expect(suwayomi.peakInFlight).toBeLessThanOrEqual(2);
    expect(summary.engineRequestsPerChapter).toBeLessThanOrEqual(4);
  });

  it('downloads a 2,100 chapter novel as 21 volumes', async () => {
    const novel = seedBigNovel();
    ctx.fakes.lncrawl.epubSections = 3;
    await configureEngines(ctx, { library, manga: false, maxConcurrentJobs: 1 });
    const summary = await runScenario(
      'novel-per-volume',
      { seriesKey: `n:${novel.id}`, packaging: 'volume', selection: { mode: 'all' }, libraryId: library.libraryId },
      { units: NOVEL_VOLUMES, books: NOVEL_VOLUMES, engineChapters: NOVEL_VOLUMES * NOVEL_CHAPTERS_PER_VOLUME, engineFake: 'lncrawl' },
    );

    const lncrawl = ctx.fakes.lncrawl;
    expect(lncrawl.jobsCreated.filter((entry) => entry.type === 'fetch-volumes')).toHaveLength(NOVEL_VOLUMES);
    expect(lncrawl.jobsCreated.filter((entry) => entry.type === 'make-artifacts')).toHaveLength(NOVEL_VOLUMES);
    expect(lncrawl.count('static:artifact')).toBe(NOVEL_VOLUMES);
    expect(lncrawl.count('job:get')).toBeLessThanOrEqual(NOVEL_VOLUMES * 4);
    expect(lncrawl.peakInFlight).toBeLessThanOrEqual(3);
    expect(summary.engineRequestsPerChapter).toBeLessThan(1);
  });

  it('downloads a 2,100 chapter novel as one book', async () => {
    const novel = seedBigNovel();
    await configureEngines(ctx, { library, manga: false, maxConcurrentJobs: 1 });
    await runScenario(
      'novel-whole-series',
      { seriesKey: `n:${novel.id}`, packaging: 'series', selection: { mode: 'all' }, libraryId: library.libraryId },
      { units: 1, books: 1, engineChapters: NOVEL_VOLUMES * NOVEL_CHAPTERS_PER_VOLUME, engineFake: 'lncrawl' },
    );

    const lncrawl = ctx.fakes.lncrawl;
    const fetches = lncrawl.jobsCreated.filter((entry) => entry.type === 'fetch-volumes');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.params['volumes']).toHaveLength(NOVEL_VOLUMES);
    expect(lncrawl.jobsCreated.filter((entry) => entry.type === 'make-artifacts')).toHaveLength(1);
  });

  it('keeps the queue page fast with many finished downloads of different sizes', async () => {
    const manga = seedBigManga();
    await configureEngines(ctx, { library, novel: false, maxConcurrentJobs: 2 });
    for (let index = 0; index < 20; index += 1) {
      const job = await createJob(ctx, ctx.user.token, {
        seriesKey: `m:${manga.id}`,
        packaging: 'chapter',
        selection: { mode: 'list', sequences: [String(index + 1)] },
        skipImported: false,
        libraryId: library.libraryId,
      });
      for (;;) {
        await ctx.runner.tick();
        const list = (await api(ctx, 'GET', '/web-serials/jobs?limit=100', ctx.user.token)).json() as WebSerialJobList;
        if (list.items.find((item) => item.id === job.id && TERMINAL_STATUSES.includes(item.status))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      samples.push((await timed(() => api(ctx, 'GET', '/web-serials/jobs?limit=100', ctx.user.token))).ms);
    }
    console.log(`[scale:many-jobs] list of 20 finished jobs: p50 ${round(percentile(samples, 0.5))}ms max ${round(Math.max(...samples))}ms`);
    expect(Math.max(...samples)).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('measures the floor the runner puts under each chapter with the real first poll delay', async () => {
    ctx.fakes.suwayomi.addSource({ id: '1001', name: 'Scale Scans', lang: 'en' });
    const manga = ctx.fakes.suwayomi.addManga({ title: 'Real Waits', chapters: generateMangaChapters({ count: 3, pages: 1 }) });
    for (const chapter of manga.chapters) ctx.fakes.suwayomi.failPoll(chapter.id, { kind: 'slow', polls: 1 });
    await configureEngines(ctx, { library, novel: false, maxConcurrentJobs: 1 });

    const patched = ctx.runner as unknown as { sleep?: unknown; now?: unknown };
    const { sleep, now } = patched;
    delete patched.sleep;
    delete patched.now;
    try {
      const startedAt = performance.now();
      const job = await createJob(ctx, ctx.user.token, {
        seriesKey: `m:${manga.id}`,
        packaging: 'chapter',
        selection: { mode: 'all' },
        libraryId: library.libraryId,
      });
      for (;;) {
        await ctx.runner.tick();
        const list = (await api(ctx, 'GET', '/web-serials/jobs?limit=5', ctx.user.token)).json() as WebSerialJobList;
        if (TERMINAL_STATUSES.includes(list.items.find((item) => item.id === job.id)!.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const secondsPerChapter = (performance.now() - startedAt) / 1000 / 3;
      console.log(
        `[scale:poll-floor] ${round(secondsPerChapter, 2)}s per chapter when the engine needs one more poll; ` +
          `a 1,160 chapter series is at least ${round((secondsPerChapter * MANGA_CHAPTERS) / 3600, 2)} hours even if the engine downloads instantly`,
      );
      expect(secondsPerChapter).toBeGreaterThan(0.2);
      expect(secondsPerChapter).toBeLessThan(2);
    } finally {
      patched.sleep = sleep;
      patched.now = now;
    }
  });

  it('searches the light novel index quickly at 100k rows for few sources, no match and a common word', async () => {
    const words = sql.join(
      INDEX_WORDS.map((word) => sql`${word}`),
      sql`, `,
    );
    // Five sources holding 60, 25, 10, 4 and 1 percent of the rows; titles of 5 to 14 common light novel words.
    await ctx.db.execute(sql`insert into web_serial_novel_index (source_id, path, title, title_key, mtl)
      select src, 'p/' || i, t, t, i % 9 = 0 from (
        select i,
          case when i <= 60000 then 's1' when i <= 85000 then 's2' when i <= 95000 then 's3' when i <= 99000 then 's4' else 's5' end as src,
          (select string_agg(w[1 + (abs(hashtext(i::text || ':' || k)) % array_length(w, 1))], ' ')
            from (select array[${words}]::text[] as w) vocabulary, generate_series(1, 5 + abs(hashtext(i::text)) % 10) k)
            || ' ' || substr(md5(i::text), 1, 4) as t
        from generate_series(1, 100000) i
      ) generated`);
    await ctx.db
      .insert(webSerialNovelIndex)
      .values({ sourceId: 's5', path: 'target', title: 'The Villainess Turns the Hourglass', titleKey: 'the villainess turns the hourglass' });
    // Earlier runs leave the deleted rows of their own fills behind; autovacuum would clear them in a real installation.
    await ctx.db.execute(sql`vacuum analyze web_serial_novel_index`);
    const repo = ctx.app.get(WebSerialsNovelIndexRepository);
    const all = ['s1', 's2', 's3', 's4', 's5'];
    const few = ['s3', 's4'];
    const median = async (query: string, sourceIds: string[]) => {
      await repo.searchNovelIndex(query, sourceIds, 8);
      const runs: number[] = [];
      for (let run = 0; run < 7; run += 1) runs.push((await timed(() => repo.searchNovelIndex(query, sourceIds, 8))).ms);
      return round(percentile(runs, 0.5));
    };
    const plan = (query: string, sourceIds: string[]) =>
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = (await tx.execute<{ 'QUERY PLAN': string }>(sql`explain analyze ${repo.novelIndexSearchQuery(query, sourceIds, 8)}`)).rows;
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
    const gistLine = (text: string) => text.split('\n').find((line) => / (using|on) web_serial_novel_index_title_gist_idx /.test(line));
    // The scan under the "more than 1,000 matches" guard, whichever index the planner chose for it.
    const largeResultBranch = (text: string) => {
      const lines = text.split('\n');
      const guard = lines.findIndex((line) => /One-Time Filter: \(\(InitPlan \d+\)\.col1 > '1000'::bigint\)/.test(line));
      return guard === -1 ? undefined : lines.slice(guard + 1).find((line) => line.includes('->'));
    };
    try {
      const timings: Record<string, number> = {};
      for (const query of ['villainess turns', 'vilainess', 'the', 'reincarnated villainess']) timings[`few:${query}`] = await median(query, few);
      timings['few:no match'] = await median('xyzzyqq', few);
      timings['all:no match'] = await median('xyzzyqq', all);
      timings['all:the'] = await median('the', all);
      timings['all:villainess turns'] = await median('villainess turns', all);
      console.log(`[scale:novel-index] medianMs=${JSON.stringify(timings)}`);
      const fewPlan = await plan('villainess turns', few);
      const noMatchPlan = await plan('xyzzyqq', all);
      const common = await plan('the', all);
      console.log(`[scale:novel-index] few sources plan:\n${fewPlan}\n[scale:novel-index] no match plan:\n${noMatchPlan}`);
      console.log(`[scale:novel-index] common word plan:\n${common}`);

      expect((await repo.searchNovelIndex('villainess turns', all, 5))[0]).toMatchObject({ path: 'target' });
      expect((await repo.searchNovelIndex('vilainess turns', few, 5)).length).toBeGreaterThan(0);
      for (const query of ['villainess turns', 'vilainess', 'the', 'reincarnated villainess']) {
        expect(timings[`few:${query}`], query).toBeLessThan(INDEX_FEW_SOURCES_MS);
      }
      expect(timings['few:no match']).toBeLessThan(INDEX_NO_MATCH_MS);
      expect(timings['all:no match']).toBeLessThan(INDEX_NO_MATCH_MS);
      expect(timings['all:the']).toBeLessThan(INDEX_COMMON_WORD_MS);

      // Few matches in the user's sources: the GIN index finds them and the large-result half never runs, whichever
      // index the planner picked for it.
      for (const text of [noMatchPlan, fewPlan]) {
        expect(text).toContain('Bitmap Index Scan on web_serial_novel_index_title_filter_idx');
        expect(largeResultBranch(text)).toContain('(never executed)');
      }
      // A common word across every source: the GiST index ranks by distance and the full sort never runs.
      expect(gistLine(common)).toContain('(actual time');
      expect(common).toMatch(/CTE Scan on filtered {2}\(cost=[^\n]*\(never executed\)/);
    } finally {
      await ctx.db.delete(webSerialNovelIndex);
    }
  });

  async function reportSummaries(): Promise<void> {
    const rows = summaries.map((summary) => ({
      scenario: summary.scenario,
      units: summary.units,
      'wall s': summary.wallSeconds,
      'units/s': summary.unitsPerSecond,
      'dl/s': summary.engineDownloadsPerSecond,
      'ms/unit first>last': `${summary.msPerUnitFirst}>${summary.msPerUnitLast}`,
      'pg q/unit first>last': `${summary.pgQueriesPerUnitFirst}>${summary.pgQueriesPerUnitLast}`,
      'import ms first>last': `${summary.importMsPerUnitFirst}>${summary.importMsPerUnitLast}`,
      'engine req/chapter': summary.engineRequestsPerChapter,
      'rss MB start/peak/end': `${summary.rssStartMb}/${summary.rssPeakMb}/${summary.rssEndMb}`,
      'heap MB start/end (after gc)': `${summary.heapStartMb}/${summary.heapEndMb}`,
      'list ms idle/busy p50/busy max': `${summary.listJobsIdleMaxMs}/${summary.listJobsBusyP50Ms}/${summary.listJobsBusyMaxMs}`,
      'detail ms idle/busy p50/busy max': `${summary.detailIdleMaxMs}/${summary.detailBusyP50Ms}/${summary.detailBusyMaxMs}`,
      'preview ms series/lookup/sources': `${summary.previewSeriesMs}/${summary.previewLookupMs}/${summary.previewSourcesMs}`,
      'create job ms': summary.createJobMs,
    }));
    console.log('\nWeb Serials scale summary');
    console.table(rows);
    const directory = join(process.cwd(), '..', 'test-results', 'server');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'web-serials-scale-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summaries }, null, 2));
  }
});
