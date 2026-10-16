import { BadRequestException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { DownloadClientTestResult, GrabFailureCode } from '@bookorbit/types';

import { readBoundedText } from '../../../../common/utils/bounded-response';
import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { ensureSafeUrl } from '../../../../common/utils/ssrf.utils';
import { parseShelfmarkSize, redactShelfmarkText, shelfmarkClientKey } from '../../shelfmark/shelfmark-release';
import type {
  DownloadClientAdapter,
  DownloadState,
  DownloadStatus,
  GrabPayload,
  OwnedDownloadClientInventory,
  ResolvedClientConfig,
} from '../download-client-adapter';
import { endpointUrl, fetchClient, readClientJson, throwForClientServerError } from './client-http.utils';

const LABEL = 'Shelfmark';
const MAX_MESSAGE_CHARS = 500;
const MAX_REFUSAL_CHARS = 300;
const KEPT_NO_FILE_MESSAGE = 'Shelfmark finished but kept no file for BookOrbit to import. Set its output mode to Folder.';
/** Shelfmark's refusal when the release was queued between BookOrbit reading the queue and asking. */
const ALREADY_QUEUED = /already in the download queue/i;
/** Shelfmark's wording for an exception while queueing, which a later attempt may not hit. */
const QUEUEING_ERROR_PREFIX = 'Error queueing release';
/** Shelfmark's route answers its own storage and filesystem faults as a 500 with the bare exception text. */
const TRANSIENT_ERROR = /database is locked|sqlite|disk i\/o|\[Errno \d+\]|temporarily unavailable/i;
/** Enough for Shelfmark's `{"error": ...}`; a page in front of it is not worth reading further. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
/** "Complete (3 files)" or "Complete (2 books, 5 files)": the only place Shelfmark says it wrote more than the file it names. */
const COMPLETE_FILE_COUNT = /^Complete \((?:\d+ books?, )?(\d+) files?\)/i;

interface ShelfmarkTask {
  id?: unknown;
  title?: unknown;
  progress?: unknown;
  status?: unknown;
  status_message?: unknown;
  download_path?: unknown;
  size?: unknown;
  added_time?: unknown;
}

interface LocatedTask {
  taskId: string;
  status: string;
  task: ShelfmarkTask;
}

const STATE_BY_SHELFMARK_STATUS: Record<string, DownloadState> = {
  queued: 'queued',
  resolving: 'queued',
  locating: 'queued',
  downloading: 'downloading',
  complete: 'completed',
  error: 'failed',
  cancelled: 'failed',
};

/**
 * Hands a release back to the Shelfmark instance that found it. Shelfmark downloads into its own
 * folder, which BookOrbit reads through this client's path mappings, the same as any other client.
 */
@Injectable()
export class ShelfmarkDownloadClientAdapter implements DownloadClientAdapter {
  readonly type = 'shelfmark' as const;
  readonly label = LABEL;
  readonly delivers = 'shelfmark' as const;

  private readonly logger = new Logger(ShelfmarkDownloadClientAdapter.name);

  async add(release: GrabPayload, config: ResolvedClientConfig): Promise<{ clientKey: string }> {
    const payload = release.shelfmarkRelease;
    if (!payload?.source || !payload.source_id) throw new BadRequestException('A Shelfmark grab needs a release found by a Shelfmark indexer');
    const clientKey = shelfmarkClientKey(payload.source_id);

    // Shelfmark keys its queue by source_id, so a second grab of a release it is already working on
    // would only be refused. Anything that would report as failed is queued again instead, including
    // a finished task whose file has since gone: retrying it is the point of the grab.
    const existing = (await this.tasks(config)).get(clientKey);
    if (existing && toStatus(clientKey, existing).state !== 'failed') return { clientKey };

    const body = await this.call(
      config,
      '/api/releases/download',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      { onRefusal: queueRefusal },
    );
    const status = body && typeof body === 'object' ? (body as Record<string, unknown>).status : undefined;
    if (status !== 'queued')
      throw new BadRequestException(
        `Shelfmark did not queue that release${typeof status === 'string' ? `: ${redactShelfmarkText(status).slice(0, MAX_REFUSAL_CHARS)}` : ''}`,
      );
    return { clientKey };
  }

  async status(keys: string[], config: ResolvedClientConfig): Promise<DownloadStatus[]> {
    if (keys.length === 0) return [];
    const found = await this.tasks(config);
    return [...new Set(keys)].flatMap((key) => {
      const located = found.get(key);
      return located ? [toStatus(key, located)] : [];
    });
  }

  /** Shelfmark's queue carries no mark of who queued a task, so BookOrbit cannot tell its own apart. */
  listOwned(): Promise<OwnedDownloadClientInventory> {
    return Promise.resolve({ supported: false, truncated: false, items: [] });
  }

  async remove(key: string, config: ResolvedClientConfig): Promise<void> {
    const located = (await this.tasks(config)).get(key);
    if (!located) return;
    // A finished or failed task has nothing left to stop, and its files are BookOrbit's import to handle.
    const state = STATE_BY_SHELFMARK_STATUS[located.status];
    if (state !== 'queued' && state !== 'downloading') return;
    await this.call(config, `/api/download/${encodeURIComponent(located.taskId)}/cancel`, { method: 'DELETE' });
  }

  async test(config: ResolvedClientConfig): Promise<DownloadClientTestResult> {
    const startedAt = Date.now();
    try {
      await this.tasks(config);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[download_client.test] [fail] clientId=${config.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(message)}" - Shelfmark connection test failed`,
      );
      return { success: false, error: message };
    }
  }

  /** Every task Shelfmark knows about, keyed by the digest BookOrbit stores for it. */
  private async tasks(config: ResolvedClientConfig): Promise<Map<string, LocatedTask>> {
    const body = await this.call(config, '/api/status', { method: 'GET' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Shelfmark returned an invalid status response');

    const found = new Map<string, LocatedTask>();
    for (const [status, bucket] of Object.entries(body as Record<string, unknown>)) {
      if (!(status in STATE_BY_SHELFMARK_STATUS) || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      for (const [taskId, task] of Object.entries(bucket as Record<string, unknown>)) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
        found.set(shelfmarkClientKey(taskId), { taskId, status, task: task as ShelfmarkTask });
      }
    }
    return found;
  }

  /**
   * `onRefusal` reads a 500 that carries a reason, which is how Shelfmark answers every queue it
   * declines; anything else at 500 is the server failing.
   */
  private async call(
    config: ResolvedClientConfig,
    path: string,
    init: RequestInit,
    options: { onRefusal?: (refusal: ShelfmarkRefusal) => unknown } = {},
  ): Promise<unknown> {
    if (!config.password) throw new BadRequestException('Shelfmark needs an API key');
    const base = await ensureSafeUrl(config.baseUrl, { allowPrivate: config.allowPrivateAddress });
    const headers = { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined), 'X-Api-Key': config.password };

    const response = await fetchClient(endpointUrl(base, path), { ...init, headers }, LABEL, {
      allowPrivate: config.allowPrivateAddress,
      pinResolvedAddress: true,
    });
    if (!response.ok) {
      // Only a declined queue carries a reason worth reading; every other failure is a status code.
      const refusal = options.onRefusal && (response.status === 500 || response.status === 403) ? await readRefusal(response) : null;
      if (refusal && (response.status === 500 || refusal.code?.startsWith('policy_'))) return options.onRefusal!(refusal);
      await response.body?.cancel().catch(() => undefined);
      throwForClientServerError(response, LABEL, path);
      if (response.status === 401 || response.status === 403) throw new BadRequestException('Shelfmark rejected the API key');
      throw new BadRequestException(`Shelfmark answered ${response.status} for ${path.split('?')[0]}`);
    }
    return readClientJson<unknown>(response, LABEL);
  }
}

function toStatus(clientKey: string, located: LocatedTask): DownloadStatus {
  const { task } = located;
  const downloadPath = stringField(task.download_path);
  // Shelfmark clears the path of a finished task whose file is gone, as it is after an email
  // delivery or once another app took it from the folder, so there is nothing left to import.
  const keptNoFile = located.status === 'complete' && !downloadPath;
  const state = keptNoFile ? 'failed' : (STATE_BY_SHELFMARK_STATUS[located.status] ?? 'unknown');
  const totalBytes = byteCount(task.size) ?? parseShelfmarkSize(task.size);
  const started = startedAt(task);
  const progressPercent = state === 'completed' || keptNoFile ? 100 : clampPercent(numberField(task.progress) ?? 0);
  return {
    clientKey,
    state,
    progressPercent,
    downloadedBytes: totalBytes ? Math.round((totalBytes * progressPercent) / 100) : 0,
    totalBytes,
    contentPath: state === 'completed' ? downloadPath : null,
    ...(state === 'completed' ? fileCount(task) : {}),
    ...(started ? { startedAt: started } : {}),
    ...(state === 'failed' ? { errorMessage: failureMessage(located, keptNoFile) } : {}),
  };
}

/** Shelfmark names only the first file of a release it wrote as several, so the import is told how many to look for. */
function fileCount(task: ShelfmarkTask): { contentFileCount?: number } {
  const match = COMPLETE_FILE_COUNT.exec(stringField(task.status_message) ?? '');
  const count = match ? Number(match[1]) : 1;
  return count > 1 ? { contentFileCount: count } : {};
}

/** Seconds since the epoch, on Shelfmark's clock. */
function startedAt(task: ShelfmarkTask): Date | undefined {
  const seconds = numberField(task.added_time);
  return seconds ? new Date(seconds * 1000) : undefined;
}

function failureMessage(located: LocatedTask, keptNoFile: boolean): string {
  // Checked before the message, which a cancel leaves at whatever the task was last doing.
  if (located.status === 'cancelled') return 'Cancelled in Shelfmark';
  if (keptNoFile) return KEPT_NO_FILE_MESSAGE;
  const message = stringField(located.task.status_message);
  return message ? `Shelfmark: ${redactShelfmarkText(message).slice(0, MAX_MESSAGE_CHARS)}` : 'Shelfmark could not download it';
}

interface ShelfmarkRefusal {
  reason: string;
  code?: string;
}

function queueRefusal({ reason, code }: ShelfmarkRefusal): { status: 'queued' } {
  // Someone else queued it in the meantime, another grab or Shelfmark's own UI: the task is there either way.
  if (ALREADY_QUEUED.test(reason)) return { status: 'queued' };
  if (code?.startsWith('policy_')) throw releaseRefused(`Shelfmark's request policy does not allow that release: ${reason}`);
  if (reason.startsWith(QUEUEING_ERROR_PREFIX) || TRANSIENT_ERROR.test(reason)) {
    throw new ServiceUnavailableException(`Shelfmark could not queue that release: ${reason}`);
  }
  throw releaseRefused(`Shelfmark did not queue that release: ${reason}`);
}

/** Tagged so the automation failover moves on to the next release instead of writing off every Shelfmark one. */
function releaseRefused(message: string): BadRequestException {
  return new BadRequestException({ message, errorCode: 'GRAB_RELEASE_REFUSED' satisfies GrabFailureCode, statusCode: HttpStatus.BAD_REQUEST });
}

/** Shelfmark explains a refusal as `{"error": "...", "code"?: "..."}`; anything else in front of it, such as a proxy page, carries no reason. */
async function readRefusal(response: Response): Promise<ShelfmarkRefusal | null> {
  try {
    const body = JSON.parse(await readBoundedText(response, MAX_ERROR_BODY_BYTES)) as unknown;
    if (!body || typeof body !== 'object') return null;
    const { error, code } = body as { error?: unknown; code?: unknown };
    if (typeof error !== 'string' || !error.trim()) return null;
    return { reason: redactShelfmarkText(error.trim()).slice(0, MAX_REFUSAL_CHARS), ...(typeof code === 'string' ? { code } : {}) };
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function byteCount(value: unknown): number | null {
  const parsed = numberField(value);
  return parsed === null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
