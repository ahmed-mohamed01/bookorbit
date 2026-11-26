import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BookKnowledgeScope, BookKnowledgeScopeInfo, BookKnowledgeStatus } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { storageConfig } from '../../config/config';
import { bookKnowledgeConfig } from './book-knowledge.config';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { BookReadService } from '../book/book-read.service';
import { storyGuideFiles } from '../story-guides/story-guides.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BookKnowledgeModelService } from './book-knowledge-model.service';
import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import { ArtifactCache, ArtifactTooLargeError, artifactPath, readArtifact } from './core/artifact';
import { buildArtifact } from './core/build-pipeline';
import { fractionToOrdinal, progressToOrdinal } from './core/cutoff';
import { ARTIFACT_VERSION, TEXT_VERSION, TERMS_VERSION } from './core/versions';
import type { Artifact } from './core/model';
import { resolveGlinerModelPath } from './gliner/stage';
export const BOOK_TOO_LONG_ERROR = 'Book is too long for Book Knowledge';
const errorClass = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');
const errorText = (error: unknown) => sanitizeLogValue(error instanceof Error ? error.message : String(error));
@Injectable()
export class BookKnowledgeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly cache = new ArtifactCache();
  private readonly pendingLoads = new Map<string, Promise<Artifact>>();
  private readonly logger = new Logger(BookKnowledgeService.name);
  private pumping = false;
  private activeBookId: number | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly repo: BookKnowledgeRepository,
    private readonly books: BookService,
    private readonly read: BookReadService,
    private readonly model: BookKnowledgeModelService,
    private readonly settings: BookKnowledgeSettingsService,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(bookKnowledgeConfig.KEY) private readonly config: ConfigType<typeof bookKnowledgeConfig>,
  ) {}
  async onApplicationBootstrap() {
    await this.repo.resume();
    await this.cleanup();
    this.kick();
    this.timer = setInterval(() => {
      this.kick();
      void this.cleanup();
    }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  private async knowledgeFile(bookId: number) {
    const files = await this.repo.knowledgeFileCandidates(bookId);
    const { formatPriority, primaryFileId } = files[0] ?? {};
    const selected = storyGuideFiles(files, formatPriority ?? null, primaryFileId ?? null)[0];
    const file = files.find(({ id }) => id === selected?.id);
    if (!file?.format) return null;
    return { id: file.id, format: file.format.toLowerCase(), absolutePath: file.absolutePath, fileHash: file.fileHash };
  }
  private async source(bookId: number) {
    const file = await this.knowledgeFile(bookId);
    if (!file) throw new BadRequestException('Book Knowledge requires an EPUB, KEPUB, MOBI, AZW3 or AZW file');
    const info = await stat(file.absolutePath).catch(() => {
      throw new BadRequestException('Book Knowledge cannot read the source file');
    });
    // The size catches a rewritten file whose stored hash went stale; never stream the source per request.
    const identity = file.fileHash ? `${file.fileHash}:${info.size}` : `nohash:${info.size}:${info.mtimeMs}`;
    return { file, fingerprint: createHash('sha256').update(identity).digest('hex') };
  }
  enabled(): Promise<boolean> {
    return this.settings.enabled();
  }
  async sourceFileId(bookId: number): Promise<number | null> {
    return (await this.knowledgeFile(bookId))?.id ?? null;
  }
  private path(bookId: number, fingerprint: string) {
    return artifactPath(this.storage.appDataPath, bookId, fingerprint);
  }
  /** The X-Ray build's stored model answers, beside the artifact so they go when the book's text changes. */
  xrayUnitsPath(bookId: number, fingerprint: string): string {
    return join(dirname(this.path(bookId, fingerprint)), 'xray-units.jsonl.gz');
  }
  private glinerOptions() {
    return { directory: join(this.storage.appDataPath, 'models', 'gliner_medium-v2.1'), threads: this.config.glinerThreads };
  }
  /** The ready, current artifact and its fingerprint, or null. Never queues a build, and checks no access: callers have. */
  async peek(bookId: number): Promise<{ artifact: Artifact; fingerprint: string } | null> {
    const source = await this.source(bookId).catch(() => null);
    const row = source ? await this.repo.state(bookId) : null;
    if (
      !source ||
      row?.status !== 'ready' ||
      row.fingerprint !== source.fingerprint ||
      row.textVersion !== TEXT_VERSION ||
      row.termsVersion !== TERMS_VERSION
    )
      return null;
    const artifact = await this.load(bookId, this.path(bookId, source.fingerprint));
    return artifact ? { artifact, fingerprint: source.fingerprint } : null;
  }
  async context(bookId: number, user: RequestUser, scope: BookKnowledgeScope = 'position', required = true) {
    await this.books.verifyBookAccess(bookId, user);
    const { file, fingerprint } = await this.source(bookId);
    const row = await this.repo.state(bookId);
    const enabled = await this.settings.enabled();
    let stale = !!row && (row.fingerprint !== fingerprint || row.textVersion !== TEXT_VERSION || row.termsVersion !== TERMS_VERSION);
    let artifact: Artifact | undefined;
    if (row?.status === 'ready' && !stale) {
      artifact = await this.load(bookId, this.path(bookId, fingerprint));
      stale = !artifact;
    }
    let queued = false;
    if (stale && enabled && row?.status !== 'running') {
      await this.repo.queue(bookId, fingerprint, TEXT_VERSION, TERMS_VERSION);
      this.kick();
      queued = true;
    }
    if (required && !artifact) throw new ConflictException('Book Knowledge is not ready');
    const rows = await this.read.findProgressByBook(user.id, bookId);
    const progress = rows.find((row) => row.fileId === file.id);
    const cutoff = artifact
      ? progressToOrdinal(artifact.sentences, { percentage: progress?.percentage ?? null, cfi: progress?.cfi }, artifact.spineBytes)
      : 0;
    const info: BookKnowledgeScopeInfo = {
      scope,
      cutoffOrdinal: scope === 'full' && artifact ? fractionToOrdinal(artifact.sentences, 1) : cutoff,
      noProgress: scope === 'position' && !!artifact && cutoff === 0,
    };
    return { artifact: artifact!, info, row, stale, queued, enabled, fingerprint, file };
  }
  /** A ready row whose artifact cannot be read, or is from an older format, counts as stale so it is rebuilt. */
  private async load(bookId: number, path: string): Promise<Artifact | undefined> {
    const cached = this.cache.get(path);
    if (cached?.formatVersion === ARTIFACT_VERSION) return cached;
    const started = Date.now();
    try {
      let pending = this.pendingLoads.get(path);
      if (!pending) {
        pending = readArtifact(path)
          .then((loaded) => {
            this.cache.set(path, loaded);
            return loaded;
          })
          .finally(() => this.pendingLoads.delete(path));
        this.pendingLoads.set(path, pending);
      }
      return await pending;
    } catch (error) {
      this.cache.delete(path);
      this.logger.warn(
        `[book_knowledge.artifact_read] [fail] bookId=${bookId} durationMs=${Date.now() - started} errorClass=${errorClass(error)} error="${errorText(error)}" - artifact unreadable, rebuild needed`,
      );
      return undefined;
    }
  }
  async status(bookId: number, user: RequestUser, scope: BookKnowledgeScope = 'position'): Promise<BookKnowledgeStatus> {
    return this.statusOf(await this.context(bookId, user, scope, false));
  }
  private async statusOf(context: Awaited<ReturnType<BookKnowledgeService['context']>>): Promise<BookKnowledgeStatus> {
    return {
      ...context.info,
      status: context.queued ? 'queued' : context.stale ? 'stale' : (context.row?.status ?? 'none'),
      progress: context.queued ? 0 : (context.row?.progress ?? 0),
      error: context.queued ? null : (context.row?.error ?? null),
      modelConfigured: await this.model.configured(),
      enabled: context.enabled,
    };
  }
  async build(bookId: number, user: RequestUser, scope: BookKnowledgeScope = 'position'): Promise<BookKnowledgeStatus> {
    const context = await this.context(bookId, user, scope, false);
    if (!context.enabled) throw new ServiceUnavailableException('Book Knowledge is turned off');
    if (context.queued) return this.statusOf(context);
    const row = context.row;
    const needsModelVotes =
      row?.status === 'ready' &&
      !!context.artifact &&
      context.artifact.modelVotes === undefined &&
      !!(await resolveGlinerModelPath(this.glinerOptions(), bookId));
    // A book too long to store fails the same way until a new text or terms version changes the artifact.
    const retry = row?.status === 'failed' && row.error !== BOOK_TOO_LONG_ERROR;
    if (!row || retry || needsModelVotes) await this.repo.queue(bookId, context.fingerprint, TEXT_VERSION, TERMS_VERSION);
    this.kick();
    return this.status(bookId, user, scope);
  }
  async writeDerived(bookId: number, fingerprint: string, write: () => Promise<void>): Promise<void> {
    const current = await this.repo.state(bookId);
    if (current?.status !== 'ready' || current.fingerprint !== fingerprint) return;
    try {
      await write();
    } finally {
      const after = await this.repo.state(bookId);
      if (after?.status !== 'ready' || after.fingerprint !== fingerprint) await this.repo.enqueueCleanup(bookId);
    }
  }
  private kick() {
    if (this.pumping || this.stopped) return;
    const started = Date.now();
    void this.drain().catch((error: unknown) =>
      this.logger.error(
        `[book_knowledge.queue] [fail] durationMs=${Date.now() - started} errorClass=${errorClass(error)} error="${errorText(error)}" - queue deferred`,
      ),
    );
  }
  private async drain() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        if (!(await this.settings.enabled())) break;
        const row = await this.repo.next();
        if (!row) break;
        this.activeBookId = row.bookId;
        const started = Date.now();
        this.logger.log(`[book_knowledge.build] [start] bookId=${row.bookId} - build started`);
        try {
          await this.repo.update(row.bookId, { status: 'running', progress: 5, error: null });
          const source = await this.source(row.bookId);
          const path = this.path(row.bookId, source.fingerprint);
          const result = await buildArtifact(source.file.absolutePath, {
            format: source.file.format,
            fingerprint: source.fingerprint,
            outputPath: path,
            cacheDirectory: join(this.storage.appDataPath, 'book-knowledge', String(row.bookId), 'stages'),
            bookId: row.bookId,
            gliner: this.glinerOptions(),
          });
          const current = await this.repo.state(row.bookId);
          if (!current) {
            await rm(join(this.storage.appDataPath, 'book-knowledge', String(row.bookId)), { recursive: true, force: true });
            continue;
          }
          const after = await this.source(row.bookId);
          if (after.fingerprint !== source.fingerprint) {
            await this.repo.update(row.bookId, { status: 'queued', fingerprint: after.fingerprint });
            continue;
          }
          this.cache.set(path, result.artifact, result.jsonBytes);
          await this.repo.update(row.bookId, {
            fingerprint: source.fingerprint,
            textVersion: TEXT_VERSION,
            termsVersion: TERMS_VERSION,
            status: 'ready',
            progress: 100,
            stageMs: result.stageMs,
            sentenceCount: result.artifact.sentences.length,
            termCount: result.artifact.terms.length,
            artifactBytes: result.artifactBytes,
          });
          await this.repo.enqueueCleanup(row.bookId);
          this.logger.log(`[book_knowledge.build] [end] bookId=${row.bookId} durationMs=${Date.now() - started} - build completed`);
        } catch (error) {
          const message = error instanceof ArtifactTooLargeError ? BOOK_TOO_LONG_ERROR : 'Knowledge build failed; retry the build';
          await this.repo.update(row.bookId, { status: 'failed', error: message, progress: 0 });
          this.logger.error(
            `[book_knowledge.build] [fail] bookId=${row.bookId} durationMs=${Date.now() - started} errorClass=${errorClass(error)} error="${errorText(error)}" - build failed`,
          );
        } finally {
          this.activeBookId = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private cleaning = false;
  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    const started = Date.now();
    try {
      const ids = await this.repo.cleanupIds();
      if (ids.length) this.logger.log(`[book_knowledge.cleanup] [start] count=${ids.length} - cleanup started`);
      let cleaned = 0;
      let failed = 0;
      for (const bookId of ids) {
        if (this.activeBookId === bookId) continue;
        const bookStarted = Date.now();
        try {
          await this.cleanBook(bookId);
          cleaned++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `[book_knowledge.cleanup] [fail] bookId=${bookId} durationMs=${Date.now() - bookStarted} errorClass=${errorClass(error)} error="${errorText(error)}" - book cleanup deferred`,
          );
        }
      }
      if (ids.length)
        this.logger.log(`[book_knowledge.cleanup] [end] durationMs=${Date.now() - started} cleaned=${cleaned} failed=${failed} - cleanup completed`);
    } catch (error) {
      this.logger.warn(
        `[book_knowledge.cleanup] [fail] durationMs=${Date.now() - started} errorClass=${errorClass(error)} error="${errorText(error)}" - cleanup deferred`,
      );
    } finally {
      this.cleaning = false;
    }
  }
  private async cleanBook(bookId: number) {
    const root = join(this.storage.appDataPath, 'book-knowledge', String(bookId));
    const current = await this.repo.state(bookId);
    if (!current) await rm(root, { recursive: true, force: true });
    else {
      const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const stageRoot = join(root, 'stages');
      const stages = await readdir(stageRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const stage of stages) if (stage !== current.fingerprint) await rm(join(stageRoot, stage), { recursive: true, force: true });
      for (const entry of entries) {
        if (entry !== current.fingerprint && entry !== 'stages') {
          await rm(join(root, entry), { recursive: true, force: true });
          if (/^[a-f0-9]{64}$/.test(entry)) this.cache.delete(this.path(bookId, entry));
        }
      }
    }
    await this.repo.cleanupDone(bookId);
  }
}
