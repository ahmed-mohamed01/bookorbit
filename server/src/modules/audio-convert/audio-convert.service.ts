import {
  AUDIO_CONVERT_ACTIVE_STATUSES,
  type AudioConvertEnabledResponse,
  type AudioConvertEncoderOptions,
  type AudioConvertJob,
  type AudioConvertPlan,
  type AudioConvertRunResponse,
  type AudioConvertSettings,
  type AudioConvertStatus,
} from '@bookorbit/types';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { AudioConvertConverterService } from './audio-convert-converter.service';
import { AudioConvertQueueService } from './audio-convert-queue.service';
import { AudioConvertRepository, toJob } from './audio-convert.repository';
import type { AudioConvertEncoderDto, AudioConvertPreviewQueryDto, AudioConvertRunDto, UpdateAudioConvertSettingsDto } from './dto/audio-convert.dto';
import type { AudioConvertJobRow, AudioConvertSettingsRow } from './schema/audio-convert.schema';

@Injectable()
export class AudioConvertService {
  constructor(
    private readonly repo: AudioConvertRepository,
    private readonly converter: AudioConvertConverterService,
    private readonly queue: AudioConvertQueueService,
    private readonly books: BookService,
  ) {}

  // ── Settings ──────────────────────────────────────────────────────────────

  /** Any signed-in user: the flag plus the saved encoder defaults, which the convert dialog starts from. */
  async enabled(): Promise<AudioConvertEnabledResponse> {
    const settings = await this.repo.getSettings();
    return { enabled: settings.enabled, encoder: savedEncoder(settings) };
  }

  async getSettings(): Promise<AudioConvertSettings> {
    return toSettings(await this.repo.getSettings());
  }

  async updateSettings(dto: UpdateAudioConvertSettingsDto, user: RequestUser): Promise<AudioConvertSettings> {
    const patch = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    const row = await this.repo.updateSettings({ ...patch, updatedAt: new Date(), updatedByUserId: user.id });
    return toSettings(row);
  }

  // ── Library ───────────────────────────────────────────────────────────────

  async preview(libraryId: number, query: AudioConvertPreviewQueryDto, user: RequestUser) {
    return this.repo.preview(libraryId, {
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      search: query.search,
      contentFilters: contentFiltersFor(user),
    });
  }

  /** Queues the books the preview lists as convertible for the same search and viewer, narrowed by the id lists. */
  async run(libraryId: number, dto: AudioConvertRunDto, user: RequestUser): Promise<AudioConvertRunResponse> {
    const settings = await this.requireEnabled();
    if (dto.excludeBookIds?.length && dto.includeBookIds?.length) throw new BadRequestException('Send excludeBookIds or includeBookIds, not both');
    let ids = await this.repo.convertibleBookIds(libraryId, { search: dto.search, contentFilters: contentFiltersFor(user) });
    if (dto.includeBookIds) {
      const include = new Set(dto.includeBookIds);
      ids = ids.filter((id) => include.has(id));
    } else if (dto.excludeBookIds) {
      const exclude = new Set(dto.excludeBookIds);
      ids = ids.filter((id) => !exclude.has(id));
    }
    const encoder = encoderFor(dto, settings);
    let queued = 0;
    for (const bookId of ids) {
      const job = await this.repo.createJob({ bookId, libraryId, userId: user.id, trigger: 'manual', status: 'queued', stage: 'ready', ...encoder });
      if (job) queued++;
    }
    return { queued, skipped: ids.length - queued };
  }

  async status(libraryId: number): Promise<AudioConvertStatus> {
    const jobs = await this.repo.statusJobs(libraryId);
    return { jobs, active: jobs.filter((job) => (AUDIO_CONVERT_ACTIVE_STATUSES as readonly string[]).includes(job.status)).length };
  }

  /** Cancels queued jobs; the running one finishes and new books waiting in the pipeline carry on. */
  async stop(libraryId: number): Promise<{ cancelled: number }> {
    return { cancelled: await this.repo.cancelQueuedInLibrary(libraryId) };
  }

  // ── Book ──────────────────────────────────────────────────────────────────

  async plan(bookId: number, user: RequestUser): Promise<AudioConvertPlan> {
    await this.books.verifyBookAccess(bookId, user, 'editor');
    return this.converter.plan(bookId);
  }

  async convertBook(bookId: number, dto: AudioConvertEncoderDto, user: RequestUser): Promise<AudioConvertJob> {
    await this.books.verifyBookAccess(bookId, user, 'editor');
    const settings = await this.requireEnabled();
    const book = await this.repo.findBook(bookId);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    const plan = await this.converter.plan(bookId);
    if (plan.status !== 'can_convert')
      throw new ConflictException({ message: 'This book cannot be converted', errorCode: plan.reason ?? plan.status });
    const job = await this.repo.createJob({
      bookId,
      libraryId: book.libraryId,
      userId: user.id,
      trigger: 'book_page',
      status: 'queued',
      stage: 'ready',
      ...encoderFor(dto, settings),
    });
    if (!job) throw new ConflictException('A conversion is already queued for this book');
    return toJob(job, book.title);
  }

  async stopBook(bookId: number, user: RequestUser): Promise<{ cancelled: boolean }> {
    await this.books.verifyBookAccess(bookId, user, 'editor');
    const latest = await this.repo.latestJob(bookId);
    if (!latest) return { cancelled: false };
    if (latest.status === 'running') return { cancelled: this.queue.cancelRunning(latest.id) };
    if (await this.repo.cancelPendingJob(latest.id)) return { cancelled: true };
    // The worker claimed it between the read and the cancel.
    const now = await this.repo.findJob(latest.id);
    return { cancelled: now?.status === 'running' ? this.queue.cancelRunning(latest.id) : false };
  }

  // ── Waiting jobs ──────────────────────────────────────────────────────────

  async skip(jobId: string, user: RequestUser): Promise<AudioConvertJob> {
    const job = await this.accessibleJob(jobId, user);
    const row = await this.repo.transition(job.id, ['waiting', 'queued'], {
      status: 'skipped',
      stage: null,
      nextStepAt: null,
      finishedAt: new Date(),
    });
    if (!row) throw new ConflictException('This conversion has already started');
    return this.withTitle(row.id);
  }

  async convertNow(jobId: string, user: RequestUser): Promise<AudioConvertJob> {
    const job = await this.accessibleJob(jobId, user);
    const row = await this.repo.convertNow(job.id);
    if (!row) {
      const now = await this.repo.findJob(job.id);
      if (now?.status === 'waiting') throw new ConflictException('Chapters are being looked up for this book; it is queued as soon as that finishes');
      throw new ConflictException('This conversion is not waiting');
    }
    return this.withTitle(row.id);
  }

  private async accessibleJob(jobId: string, user: RequestUser): Promise<AudioConvertJobRow> {
    const job = await this.repo.findJob(jobId);
    if (!job) throw new NotFoundException('Conversion not found');
    await this.books.verifyBookAccess(job.bookId, user, 'editor');
    return job;
  }

  private async withTitle(jobId: string): Promise<AudioConvertJob> {
    const job = await this.repo.jobWithTitle(jobId);
    if (!job) throw new NotFoundException('Conversion not found');
    return job;
  }

  private async requireEnabled(): Promise<AudioConvertSettingsRow> {
    const settings = await this.repo.getSettings();
    if (!settings.enabled) throw new ForbiddenException('Convert to M4B is turned off');
    return settings;
  }
}

/** The request's encoder fields, with any it leaves out taken from the saved settings. */
export function encoderFor(dto: Partial<AudioConvertEncoderOptions>, settings: AudioConvertSettingsRow): AudioConvertEncoderOptions {
  const saved = savedEncoder(settings);
  return {
    codec: dto.codec ?? saved.codec,
    bitrate: dto.bitrate ?? saved.bitrate,
    channels: dto.channels === undefined ? saved.channels : dto.channels,
  };
}

function savedEncoder(settings: AudioConvertSettingsRow): AudioConvertEncoderOptions {
  return {
    codec: settings.codec,
    bitrate: settings.bitrate as AudioConvertEncoderOptions['bitrate'],
    channels: (settings.channels ?? null) as AudioConvertEncoderOptions['channels'],
  };
}

/** Superusers see every book; anyone else sees what their content filters allow, as in other library listings. */
function contentFiltersFor(user: RequestUser) {
  return user.isSuperuser ? undefined : user.contentFilters;
}

export function toSettings(row: AudioConvertSettingsRow): AudioConvertSettings {
  return {
    enabled: row.enabled,
    autoConvert: row.autoConvert,
    ...savedEncoder(row),
    embedChapters: row.embedChapters,
    embedMetadata: row.embedMetadata,
    backupDays: row.backupDays,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}
