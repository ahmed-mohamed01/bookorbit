import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { hash } from 'bcryptjs';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { Permission, type WebSerialJob, type WebSerialJobDetail, type WebSerialJobStatus } from '@bookorbit/types';

import { AppModule } from '../../../src/app.module';
import { GlobalExceptionFilter } from '../../../src/common/filters/http-exception.filter';
import { DB } from '../../../src/db';
import * as schema from '../../../src/db/schema';
import { BookDockWatcherService } from '../../../src/modules/book-dock/book-dock-watcher.service';
import { LncrawlClient } from '../../../src/modules/web-serials/engines/lncrawl.client';
import { WebSerialsLookupService } from '../../../src/modules/web-serials/lookup/web-serials-lookup.service';
import { WebSerialsJobRunnerService } from '../../../src/modules/web-serials/web-serials-job-runner.service';
import { WebSerialsSettingsService } from '../../../src/modules/web-serials/web-serials-settings.service';
import { WebSerialsCatalogService } from '../../../src/modules/web-serials/web-serials-catalog.service';
import { WebSerialsDiscoverService } from '../../../src/modules/web-serials/web-serials-discover.service';
import {
  webSerialImports,
  webSerialJobItems,
  webSerialJobs,
  webSerialNovelIndex,
  webSerialNovelIndexSources,
  webSerialNovelPrefs,
  webSerialSettings,
} from '../../../src/modules/web-serials/schema/web-serials.schema';
import { WebSerialsNovelIndexFillerService } from '../../../src/modules/web-serials/web-serials-novel-index-filler.service';
import { extractCbzZipEntry, readCbzZipIndex } from '../../../src/common/cbz-zip-reader';
import { readPngLabel, startFakeEngines, type FakeEngines } from './fake-serial-engines';
import { seedLibrary, waitForCondition, type Db } from '../app-harness';
import { createBookDockFixtureRoot, type BookDockFixtureRoot } from '../book-dock/book-dock-fixture-builder';

export const ADMIN = { username: 'web-serials-e2e-admin', password: 'WebSerialsAdmin123' };
export const LIBRARY_NAME_PREFIX = 'ws-e2e-';
export const TERMINAL_STATUSES: WebSerialJobStatus[] = ['completed', 'completed_with_gaps', 'failed', 'cancelled'];

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface UserSession {
  userId: number;
  username: string;
  token: string;
}

export interface WebSerialsLibrary {
  libraryId: number;
  folderId: number;
  path: string;
}

/**
 * The job runner's real waits are minutes long (retry backoff) or seconds long (polling). The runner
 * exposes both as protected methods, so a test replaces them on the instance: `sleep` returns almost
 * at once and moves a virtual clock forward, and `now` reads that clock. `frozen` keeps the clock still
 * so a test can hold a job in its "waiting to retry" state and look at it.
 */
export class VirtualClock {
  offsetMs = 0;
  frozen = false;
  sleeps = 0;

  date(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    if (!this.frozen) this.offsetMs += ms;
    await new Promise((resolve) => setTimeout(resolve, this.frozen ? 25 : 2));
  }

  reset(): void {
    this.frozen = false;
    this.offsetMs = 0;
    this.sleeps = 0;
  }
}

export interface WebSerialsContext {
  app: NestFastifyApplication;
  db: Db;
  fixture: BookDockFixtureRoot;
  fakes: FakeEngines;
  clock: VirtualClock;
  admin: UserSession;
  /** Has the Web Serials permission and access to every library this harness creates. */
  user: UserSession;
  /** Has the Web Serials permission but no library access and owns nothing. */
  other: UserSession;
  /** Has no Web Serials permission at all. */
  outsider: UserSession;
  runner: WebSerialsJobRunnerService;
}

interface EnvSnapshot {
  appDataPath: string | undefined;
  fileWriteDebounceMs: string | undefined;
}

let envSnapshot: EnvSnapshot | null = null;

async function bootApp(
  fixture: BookDockFixtureRoot,
  clock: VirtualClock,
): Promise<{ app: NestFastifyApplication; db: Db; runner: WebSerialsJobRunnerService }> {
  process.env.APP_DATA_PATH = fixture.booksPath;
  process.env.FILE_WRITE_DEBOUNCE_MS = '25';

  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.register(fastifyCookie as never);
  await app.register(fastifyMultipart as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  await app.get(BookDockWatcherService).onModuleDestroy();

  const runner = app.get(WebSerialsJobRunnerService);
  const patched = runner as unknown as { sleep: (ms: number) => Promise<void>; now: () => Date };
  patched.sleep = (ms) => clock.sleep(ms);
  patched.now = () => clock.date();
  const lncrawl = app.get(LncrawlClient) as unknown as { sleep: (ms: number) => Promise<void> };
  lncrawl.sleep = () => new Promise((resolve) => setTimeout(resolve, 2));
  const filler = app.get(WebSerialsNovelIndexFillerService) as unknown as { sleep: (ms: number) => Promise<void> };
  filler.sleep = () => Promise.resolve();

  return { app, db: app.get<Db>(DB), runner };
}

export async function ensureUser(
  db: Db,
  app: NestFastifyApplication,
  username: string,
  options: { superuser?: boolean; permissions?: Permission[]; password?: string },
): Promise<UserSession> {
  const password = options.password ?? 'WebSerialsUser123';
  let [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
  if (!row) {
    [row] = await db
      .insert(schema.users)
      .values({
        username,
        name: username,
        email: `${username}@example.com`,
        passwordHash: await hash(password, 4),
        isSuperuser: options.superuser ?? false,
        isDefaultPassword: false,
        provisioningMethod: 'local',
      })
      .returning({ id: schema.users.id });
  }
  await db.delete(schema.userPermissions).where(eq(schema.userPermissions.userId, row!.id));
  const permissions = options.permissions ?? [];
  if (permissions.length > 0) {
    await db.insert(schema.userPermissions).values(permissions.map((permissionName) => ({ userId: row!.id, permissionName })));
  }
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  if (login.statusCode !== 200) throw new Error(`Login failed for ${username}: ${login.statusCode} ${login.body}`);
  return { userId: row!.id, username, token: (login.json() as { accessToken: string }).accessToken };
}

async function loginAll(db: Db, app: NestFastifyApplication) {
  return {
    admin: await ensureUser(db, app, ADMIN.username, { superuser: true, password: ADMIN.password }),
    user: await ensureUser(db, app, 'web-serials-e2e-user', { permissions: [Permission.WebSerialAccess] }),
    other: await ensureUser(db, app, 'web-serials-e2e-other', { permissions: [Permission.WebSerialAccess] }),
    outsider: await ensureUser(db, app, 'web-serials-e2e-outsider', {}),
  };
}

export async function createWebSerialsContext(): Promise<WebSerialsContext> {
  const fixture = await createBookDockFixtureRoot('web-serials-e2e-');
  envSnapshot = { appDataPath: process.env.APP_DATA_PATH, fileWriteDebounceMs: process.env.FILE_WRITE_DEBOUNCE_MS };
  const fakes = await startFakeEngines();
  const clock = new VirtualClock();
  const booted = await bootApp(fixture, clock);
  const sessions = await loginAll(booted.db, booted.app);

  await booted.db.update(schema.appSettings).set({ value: 'false' }).where(eq(schema.appSettings.key, 'book_dock_auto_fetch_metadata'));
  await booted.db.update(schema.appSettings).set({ value: 'false' }).where(eq(schema.appSettings.key, 'book_dock_auto_finalize_enabled'));

  return { ...booted, ...sessions, fixture, fakes, clock };
}

/** Stops the app and boots a new one on the same database, files and fakes, like a process restart. */
export async function restartApp(ctx: WebSerialsContext): Promise<void> {
  await ctx.app.close();
  const booted = await bootApp(ctx.fixture, ctx.clock);
  ctx.app = booted.app;
  ctx.db = booted.db;
  ctx.runner = booted.runner;
  const sessions = await loginAll(booted.db, booted.app);
  ctx.admin = sessions.admin;
  ctx.user = sessions.user;
  ctx.other = sessions.other;
  ctx.outsider = sessions.outsider;
}

export async function closeWebSerialsContext(ctx: WebSerialsContext): Promise<void> {
  await ctx.app.close();
  await ctx.fakes.stop();
  await ctx.fixture.cleanup();
  if (envSnapshot) {
    if (envSnapshot.appDataPath === undefined) delete process.env.APP_DATA_PATH;
    else process.env.APP_DATA_PATH = envSnapshot.appDataPath;
    if (envSnapshot.fileWriteDebounceMs === undefined) delete process.env.FILE_WRITE_DEBOUNCE_MS;
    else process.env.FILE_WRITE_DEBOUNCE_MS = envSnapshot.fileWriteDebounceMs;
  }
}

interface CacheLike {
  entries: Map<unknown, unknown>;
}

/** Returns the app to a known state: no jobs, no imports, no libraries of ours, queue running, fresh fakes. */
export async function resetWebSerialsState(ctx: WebSerialsContext): Promise<void> {
  await ctx.db.delete(webSerialJobs);
  await ctx.db.delete(webSerialImports);
  await ctx.db.delete(webSerialNovelPrefs);
  await ctx.db.delete(webSerialNovelIndex);
  await ctx.db.delete(webSerialNovelIndexSources);
  await ctx.db.delete(schema.notifications).where(like(schema.notifications.type, 'web_serial%'));
  await ctx.db.delete(schema.libraries).where(like(schema.libraries.name, `${LIBRARY_NAME_PREFIX}%`));
  await ctx.db.update(webSerialSettings).set({
    queuePaused: false,
    maxConcurrentJobs: 2,
    mangaLastCheck: null,
    novelLastCheck: null,
    lookupLastCheck: null,
    lookupEnabled: true,
    novelEngine: 'lncrawl',
    novelIndexDailyBudget: 1500,
  });
  (ctx.app.get(LncrawlClient) as unknown as { tokens: Map<string, string> }).tokens.clear();
  ctx.fakes.resetAll();
  ctx.clock.reset();
  const lookup = ctx.app.get(WebSerialsLookupService) as unknown as {
    lookups: CacheLike;
    matches: CacheLike;
    matchOnly: CacheLike;
    titleSearches: CacheLike;
    catalogSearches: CacheLike;
    catalogSeries: CacheLike;
    consecutiveFailures: number;
    pausedUntil: number;
    lastPersistedAt: number;
  };
  lookup.lookups.entries.clear();
  lookup.matches.entries.clear();
  lookup.matchOnly.entries.clear();
  lookup.titleSearches.entries.clear();
  lookup.catalogSearches.entries.clear();
  lookup.catalogSeries.entries.clear();
  lookup.consecutiveFailures = 0;
  lookup.pausedUntil = 0;
  lookup.lastPersistedAt = 0;
  const service = ctx.app.get(WebSerialsCatalogService) as unknown as { searchCache: CacheLike; sourceOptionsCache: CacheLike };
  service.searchCache.entries.clear();
  service.sourceOptionsCache.entries.clear();
  const discover = ctx.app.get(WebSerialsDiscoverService) as unknown as { info: CacheLike; sourcesCache: CacheLike };
  discover.info.entries.clear();
  discover.sourcesCache.entries.clear();
  ctx.app.get(WebSerialsSettingsService).bumpCatalogVersion();
}

export async function createLibrary(
  ctx: WebSerialsContext,
  options: { allowedFormats?: string[]; grantUser?: boolean } = {},
): Promise<WebSerialsLibrary> {
  const path = join(ctx.fixture.booksPath, `library-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  const { libraryId, libraryFolderId } = await seedLibrary(ctx.db, {
    rootPath: path,
    mode: 'book_per_file',
    allowedFormats: options.allowedFormats,
    watch: false,
    name: `${LIBRARY_NAME_PREFIX}${randomUUID()}`,
  });
  if (options.grantUser !== false) {
    await ctx.db.insert(schema.userLibraryAccess).values({ userId: ctx.user.userId, libraryId, accessLevel: 'editor' }).onConflictDoNothing();
  }
  return { libraryId, folderId: libraryFolderId, path };
}

export async function removeLibraryFolder(library: WebSerialsLibrary): Promise<void> {
  await rm(library.path, { recursive: true, force: true });
}

export interface ConfigureOptions {
  library: WebSerialsLibrary;
  /** Pass false to leave an engine unconfigured. */
  manga?: boolean;
  novel?: boolean;
  mangaSourceIds?: string[];
  novelDomains?: string[];
  maxConcurrentJobs?: number;
}

/** Points the app at the fakes through the real admin settings endpoint. */
export async function configureEngines(ctx: WebSerialsContext, options: ConfigureOptions): Promise<void> {
  const payload: Record<string, unknown> = { maxConcurrentJobs: options.maxConcurrentJobs ?? 2, lookup: { enabled: true } };
  if (options.manga !== false) {
    payload['manga'] = {
      url: ctx.fakes.suwayomi.url,
      username: 'suwayomi',
      password: 'suwayomi-secret',
      sourceIds: options.mangaSourceIds ?? ctx.fakes.suwayomi.sources.filter((source) => source.id !== '0').map((source) => source.id),
      targetLibraryId: options.library.libraryId,
      targetFolderId: options.library.folderId,
    };
    ctx.fakes.suwayomi.credentials = { username: 'suwayomi', password: 'suwayomi-secret' };
  }
  if (options.novel !== false) {
    payload['novel'] = {
      engine: 'lncrawl',
      url: ctx.fakes.lncrawl.url,
      username: 'crawler@example.com',
      password: 'crawler-secret',
      searchDomains: options.novelDomains ?? ctx.fakes.lncrawl.domains.map((entry) => entry.domain),
      targetLibraryId: options.library.libraryId,
      targetFolderId: options.library.folderId,
      defaultPackaging: 'volume',
    };
    ctx.fakes.lncrawl.credentials = { email: 'crawler@example.com', password: 'crawler-secret' };
  }
  const response = await api(ctx, 'PUT', '/web-serials/admin/settings', ctx.admin.token, payload);
  if (response.statusCode !== 200) throw new Error(`Settings update failed: ${response.statusCode} ${response.body}`);
}

export function api(ctx: WebSerialsContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url: `/api/v1${path}`,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export async function createJob(ctx: WebSerialsContext, token: string, payload: Record<string, unknown>): Promise<WebSerialJob> {
  const response = await api(ctx, 'POST', '/web-serials/jobs', token, payload);
  if (response.statusCode !== 201) throw new Error(`Job creation failed: ${response.statusCode} ${response.body}`);
  return response.json() as WebSerialJob;
}

export async function getJob(ctx: WebSerialsContext, token: string, id: number): Promise<WebSerialJobDetail> {
  const response = await api(ctx, 'GET', `/web-serials/jobs/${id}`, token);
  if (response.statusCode !== 200) throw new Error(`Job detail failed: ${response.statusCode} ${response.body}`);
  return response.json() as WebSerialJobDetail;
}

export async function jobStatus(ctx: WebSerialsContext, id: number): Promise<WebSerialJobStatus> {
  const [row] = await ctx.db.select({ status: webSerialJobs.status }).from(webSerialJobs).where(eq(webSerialJobs.id, id));
  if (!row) throw new Error(`Job ${id} does not exist`);
  return row.status;
}

/** The runner wakes every three seconds on its own; this nudges it so a test does not sit idle between ticks. */
export async function waitForJob(
  ctx: WebSerialsContext,
  id: number,
  statuses: WebSerialJobStatus[] = TERMINAL_STATUSES,
  timeoutMs = 30_000,
): Promise<WebSerialJob> {
  let last: WebSerialJobStatus | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ctx.runner.tick();
    last = await jobStatus(ctx, id);
    if (statuses.includes(last)) return (await getJob(ctx, ctx.admin.token, id)).job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Job ${id} did not reach ${statuses.join('/')} in ${timeoutMs}ms (last status: ${last})`);
}

export async function waitFor(check: () => Promise<boolean> | boolean, description: string, timeoutMs = 20_000): Promise<void> {
  await waitForCondition(
    async () => {
      if (!(await check())) throw new Error(description);
    },
    timeoutMs,
    40,
  );
}

export interface FiledBook {
  id: number;
  title: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  authors: string[];
  pencillers: string[];
  files: Array<{ path: string; format: string | null }>;
}

export async function listBooks(ctx: WebSerialsContext, libraryId: number): Promise<FiledBook[]> {
  const rows = await ctx.db
    .select({
      id: schema.books.id,
      title: schema.bookMetadata.title,
      seriesName: schema.bookMetadata.seriesName,
      seriesIndex: schema.bookMetadata.seriesIndex,
    })
    .from(schema.books)
    .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
    .where(eq(schema.books.libraryId, libraryId))
    .orderBy(asc(schema.books.id));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [authorRows, comicRows, fileRows] = await Promise.all([
    ctx.db
      .select({ bookId: schema.bookAuthors.bookId, name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(inArray(schema.bookAuthors.bookId, ids))
      .orderBy(asc(schema.bookAuthors.displayOrder)),
    ctx.db
      .select({ bookId: schema.comicMetadata.bookId, pencillers: schema.comicMetadata.pencillers })
      .from(schema.comicMetadata)
      .where(inArray(schema.comicMetadata.bookId, ids)),
    ctx.db
      .select({ bookId: schema.bookFiles.bookId, path: schema.bookFiles.absolutePath, format: schema.bookFiles.format })
      .from(schema.bookFiles)
      .where(inArray(schema.bookFiles.bookId, ids)),
  ]);
  return rows.map((row) => ({
    ...row,
    authors: authorRows.filter((entry) => entry.bookId === row.id).map((entry) => entry.name),
    pencillers: comicRows.find((entry) => entry.bookId === row.id)?.pencillers ?? [],
    files: fileRows.filter((entry) => entry.bookId === row.id).map((entry) => ({ path: entry.path, format: entry.format })),
  }));
}

export async function countBooks(ctx: WebSerialsContext, libraryId: number): Promise<number> {
  const [row] = await ctx.db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.books)
    .where(and(eq(schema.books.libraryId, libraryId)));
  return row?.value ?? 0;
}

export async function webSerialNotifications(ctx: WebSerialsContext, userId: number) {
  return ctx.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), like(schema.notifications.type, 'web_serial%')))
    .orderBy(asc(schema.notifications.id));
}

export async function itemRows(ctx: WebSerialsContext, jobId: number) {
  return ctx.db.select().from(webSerialJobItems).where(eq(webSerialJobItems.jobId, jobId)).orderBy(asc(webSerialJobItems.id));
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Page labels of a CBZ in reading order (`c<chapterId>p<page>` for the fakes' pages) and its entry names. */
export async function readCbzPages(path: string): Promise<{ names: string[]; labels: string[] }> {
  const index = await readCbzZipIndex(path);
  if (!index) throw new Error(`${path} is not a readable CBZ`);
  const entries = index.entries
    .filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))
    .sort((left, right) => COLLATOR.compare(left.name, right.name));
  const labels: string[] = [];
  for (const entry of entries) {
    const body = await extractCbzZipEntry(path, entry);
    labels.push(body ? (readPngLabel(body) ?? '') : '');
  }
  return { names: entries.map((entry) => entry.name), labels };
}

export async function readCbzComicInfo(path: string): Promise<string | null> {
  const index = await readCbzZipIndex(path);
  const entry = index?.entries.find((candidate) => candidate.name === 'ComicInfo.xml');
  if (!entry) return null;
  return (await extractCbzZipEntry(path, entry))?.toString('utf8') ?? null;
}

export async function zipEntryNames(path: string): Promise<string[]> {
  return (await readCbzZipIndex(path))?.entries.map((entry) => entry.name) ?? [];
}
