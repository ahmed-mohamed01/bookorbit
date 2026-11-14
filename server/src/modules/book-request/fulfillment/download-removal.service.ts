import { rm } from 'node:fs/promises';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DELIVERY_BY_DOWNLOAD_SOURCE, IN_FLIGHT_BOOK_REQUEST_DOWNLOAD_STATUSES, UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES } from '@bookorbit/types';
import type { BookRequestDownloadStatus } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { BookRequestDownloadRow } from '../../../db/schema';
import { DownloadClientConfigService } from '../download-clients/download-client-config.service';
import { DownloadClientRegistry } from '../download-clients/download-client-registry';
import { legacyStagedClientDir, stagedClientDir } from '../download-clients/download-client-adapter';
import { BookRequestDownloadRepository } from './book-request-download.repository';
import { DirectDownloadService } from './direct-download.service';

export const EXTENDED_TORRENT_LEFT_MESSAGE = 'This torrent was already in the download client, so BookOrbit left it there.';
export const SHARED_TORRENT_LEFT_MESSAGE = 'Another request still uses this torrent, so BookOrbit left it in the download client.';

type LeftReason = 'extended_torrent' | 'shared_torrent';

function leftMessage(reason: LeftReason): string {
  return reason === 'extended_torrent' ? EXTENDED_TORRENT_LEFT_MESSAGE : SHARED_TORRENT_LEFT_MESSAGE;
}

/** Statuses an attempt only reaches once the client holds every byte of it. */
const FINISHED_DOWNLOAD_STATUSES: readonly BookRequestDownloadStatus[] = ['completed', 'importing', 'needs_review', 'imported'];

export interface DownloadRemovalOutcome {
  /** True when a download was actually handed to the client. False when there was nothing to remove, or a finished torrent was left seeding. */
  removed: boolean;
  /** The client's refusal, when it had one. Best-effort callers report it; strict callers throw. */
  error: string | null;
}

/**
 * The one action BookOrbit takes against a download it grabbed. It lives on its own because both
 * ends of the request lifecycle need it: an operator removing a seed, a request being cancelled
 * under a live transfer, and direct-download staging being cleaned after it reaches the Book Dock.
 */
@Injectable()
export class DownloadRemovalService {
  private readonly logger = new Logger(DownloadRemovalService.name);
  private readonly appDataPath: string;

  constructor(
    private readonly downloads: BookRequestDownloadRepository,
    private readonly clients: DownloadClientConfigService,
    private readonly registry: DownloadClientRegistry,
    private readonly direct: DirectDownloadService,
    config: ConfigService,
  ) {
    this.appDataPath = config.getOrThrow<string>('storage.appDataPath');
  }

  /**
   * Strict: an operator who pressed Remove wants the client's own refusal, not a shrug. Resolves
   * to whether the attempt was still working, which is what decides the request's own fate.
   */
  async removeAttempt(
    requestId: number,
    downloadId: number,
    deleteFiles: boolean,
    actor: string,
  ): Promise<{ wasInFlight: boolean; leftInClient: boolean; leftMessage: string | null }> {
    const download = await this.downloads.findById(downloadId);
    if (!download || download.requestId !== requestId) throw new NotFoundException('That download attempt does not belong to this request');
    if (download.source !== 'direct_url' && download.downloadClientId === null) {
      throw new BadRequestException('That attempt is no longer attached to a download client');
    }

    const left = await this.sharedLeft(download, deleteFiles);
    if (!left) await this.detach(download, deleteFiles);
    const message = left ? leftMessage(left) : null;
    const wasInFlight = await this.failIfInFlight(download, message ?? `Removed from the download client by ${actor}`);
    return { wasInFlight, leftInClient: left !== null, leftMessage: message };
  }

  /**
   * Best-effort: the caller is stopping or deleting the request itself, and a download client that
   * is down must not be what keeps a stuck request stuck. The outcome carries the failure so the
   * caller can record that a transfer may still be sitting in the client.
   */
  async removeLatestForRequest(requestId: number, deleteFiles: boolean, actor: string): Promise<DownloadRemovalOutcome> {
    const latest = (await this.downloads.findLatestForRequests([requestId])).get(requestId);
    const download = latest?.download;
    if (!download || (download.source !== 'direct_url' && download.downloadClientId === null)) return { removed: false, error: null };

    let error: string | null = null;
    let left: LeftReason | null = null;
    let kept = false;
    try {
      left = await this.sharedLeft(download, deleteFiles);
      kept = left === null && (await this.keepsSeed(download, deleteFiles));
      if (!left && !kept) await this.detach(download, deleteFiles);
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(
        `[book_request.remove_download] [fail] requestId=${requestId} downloadId=${download.id} clientId=${download.downloadClientId ?? 'direct'} source=${download.source} errorClass=${(caught as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue(error)}" - download could not be detached from the client`,
      );
    }

    // The attempt leaves the in-flight set either way. A client that refused the detach is worth
    // telling the caller about, but it is not a reason to leave a live attempt behind a request
    // somebody is settling: the next poll would write its progress straight back onto the settled
    // row, and the monitor would go on asking the client about it forever.
    await this.failIfInFlight(
      download,
      error
        ? `Removed by ${actor}, but the download client refused: ${error}`
        : left
          ? leftMessage(left)
          : kept
            ? `Stopped by ${actor}; the finished torrent was left seeding in the download client`
            : `Removed from the download client by ${actor}`,
    );
    return { removed: error === null && !left && !kept, error };
  }

  /**
   * Best-effort detach of one attempt, for a caller that is about to lose the row it belongs to.
   *
   * Unlike the two above it leaves the attempt's status alone: the row is on its way out with the
   * request it hangs off, and writing a status onto something that is about to be deleted only
   * risks failing before the detach that actually mattered. Resolves to the client's refusal, or
   * null when there was nothing to detach or the detach worked.
   */
  async detachAttempt(download: BookRequestDownloadRow, deleteFiles: boolean): Promise<string | null> {
    try {
      if (!(await this.sharedLeft(download, deleteFiles)) && !(await this.keepsSeed(download, deleteFiles))) await this.detach(download, deleteFiles);
      return null;
    } catch (caught: unknown) {
      const error = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(
        `[book_request.remove_download] [fail] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId ?? 'direct'} source=${download.source} errorClass=${(caught as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue(error)}" - download could not be detached from the client`,
      );
      return error;
    }
  }

  /** A direct file has no seed to preserve once its Book Dock copy exists. Cleanup is best-effort. */
  async cleanupStagedDirectDownload(download: BookRequestDownloadRow): Promise<void> {
    if (download.source !== 'direct_url') return;

    try {
      await this.detach(download, true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[book_request.staging_cleanup] [fail] requestId=${download.requestId} downloadId=${download.id} errorClass=${(error as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue(message)}" - direct-download staging was left on disk`,
      );
    }
  }

  /**
   * A staged cloud download is a copy BookOrbit fetched for the import, not a seed: once the Book
   * Dock owns the bytes there is nothing left to keep, so this is best-effort like the direct
   * staging cleanup.
   *
   * The staged directory is keyed by client key, and a cloud client hands back its existing item
   * when the same infohash is grabbed again, so another request's attempt can be reading the same
   * directory. Only an attempt that has not settled still needs it: one already imported or failed
   * would otherwise keep the last attempt from ever cleaning up. A grab that merely extended an item
   * the client already had is not a reason to keep the copy, since the remote item is never touched
   * here and any BookOrbit attempt that owned it is caught by the shared check.
   */
  async cleanupStagedClientDownload(download: BookRequestDownloadRow): Promise<void> {
    if (download.source === 'direct_url' || download.downloadClientId === null || download.clientKey === null) return;

    try {
      const config = await this.clients.resolveConfig(download.downloadClientId);
      const adapter = this.registry.require(config.adapterType);
      if (typeof adapter.stage !== 'function') return;
      const shared = await this.downloads.existsOtherForClientKey(
        download.id,
        download.requestId,
        download.downloadClientId,
        download.clientKey,
        UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES,
      );
      if (shared) {
        this.logger.log(
          `[book_request.staging_cleanup] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId} reason=shared_torrent - staged client download kept for another attempt`,
        );
        return;
      }
      await rm(stagedClientDir(this.appDataPath, config.adapterType, config.id, download.clientKey), { recursive: true, force: true });
      await rm(legacyStagedClientDir(this.appDataPath, config.adapterType, download.clientKey), { recursive: true, force: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[book_request.staging_cleanup] [fail] requestId=${download.requestId} downloadId=${download.id} errorClass=${(error as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue(message)}" - staged client download files were left on disk`,
      );
    }
  }

  /**
   * A finished torrent is a seed, and settling the request it was grabbed for is no reason to stop
   * it: the files stay either way, and pulling the torrent from under them turns a private-tracker
   * grab into a hit-and-run. The client already holds the seed goals it was added with, so it
   * decides when seeding is done. Only an explicit removal, or consent to delete the files, takes
   * a finished torrent out. A cloud client that stages locally is left to `detach`, which already
   * keeps its remote copy and is what clears the local staging.
   */
  private async keepsSeed(download: BookRequestDownloadRow, deleteFiles: boolean): Promise<boolean> {
    if (deleteFiles || download.clientKey === null || download.downloadClientId === null) return false;
    if (DELIVERY_BY_DOWNLOAD_SOURCE[download.source] !== 'torrent') return false;
    if (download.completedAt === null && !FINISHED_DOWNLOAD_STATUSES.includes(download.status as BookRequestDownloadStatus)) return false;
    if (await this.clients.stagesLocally(download.downloadClientId)) return false;

    this.logger.log(
      `[book_request.remove_download] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId} source=${download.source} kept=true - finished torrent left seeding`,
    );
    return true;
  }

  /**
   * A Usenet job has nothing left to do once the Book Dock holds its import, so a client set to
   * remove completed downloads drops the job and its folder. Best-effort: the book is already
   * imported, and a client or filesystem that refuses leaves the job where it was, in the log.
   */
  async removeCompletedDownload(download: BookRequestDownloadRow): Promise<void> {
    if (DELIVERY_BY_DOWNLOAD_SOURCE[download.source] !== 'usenet' || download.downloadClientId === null || download.clientKey === null) return;

    const started = Date.now();
    try {
      if (!(await this.clients.removesCompletedDownloads(download.downloadClientId))) return;
      this.logger.log(
        `[book_request.remove_completed] [start] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId} - removing the imported download from its client`,
      );
      const config = await this.clients.resolveConfig(download.downloadClientId);
      await this.registry.require(config.adapterType).remove(download.clientKey, config, { deleteFiles: true });
      this.logger.log(
        `[book_request.remove_completed] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId} durationMs=${Date.now() - started} - imported download removed from its client`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[book_request.remove_completed] [fail] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId} durationMs=${Date.now() - started} errorClass=${(error as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue(message)}" - the imported download was left in its client`,
      );
    }
  }

  /**
   * The torrent is not this attempt's to remove when the grab extended one the client already had,
   * or another attempt shares it. Checked before the seed rule because it is the reason that explains
   * why the torrent stays.
   */
  private async sharedLeft(download: BookRequestDownloadRow, deleteFiles: boolean): Promise<LeftReason | null> {
    if (download.source === 'direct_url' || download.clientKey === null) return null;
    const shared = await this.sharedReason(download, deleteFiles);
    if (shared) {
      this.logger.log(
        `[book_request.remove] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId ?? 'none'} reason=${shared} - torrent left in the client`,
      );
    }
    return shared;
  }

  /** A direct file is ours to drop; a torrent is detached from the client that holds it. */
  private async detach(download: BookRequestDownloadRow, deleteFiles: boolean): Promise<void> {
    // An attempt a source refused was never handed to anything, so there is nothing holding it.
    if (download.clientKey === null) return;

    const isDirect = download.source === 'direct_url';
    const stagesLocally = !isDirect && download.downloadClientId !== null && (await this.clients.stagesLocally(download.downloadClientId));

    if (isDirect) {
      await this.direct.remove(download.clientKey, { deleteFiles: true });
    } else {
      const config = await this.clients.resolveConfig(download.downloadClientId as number);
      const adapter = this.registry.require(config.adapterType);
      if (stagesLocally && !deleteFiles) {
        await adapter.cancelStaging?.(download.clientKey, config);
        await rm(stagedClientDir(this.appDataPath, config.adapterType, config.id, download.clientKey), { recursive: true, force: true });
        await rm(legacyStagedClientDir(this.appDataPath, config.adapterType, download.clientKey), { recursive: true, force: true });
      } else {
        await adapter.remove(download.clientKey, config, { deleteFiles: deleteFiles });
      }
    }

    this.logger.log(
      `[book_request.remove_download] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${download.downloadClientId ?? 'direct'} source=${download.source} deleteFiles=${isDirect || deleteFiles} - download removed`,
    );
  }

  /** The torrent is not this attempt's to remove when it extended one that was already there, or another attempt also uses it. */
  private async sharedReason(download: BookRequestDownloadRow, deleteFiles: boolean): Promise<LeftReason | null> {
    const stagesLocally = download.downloadClientId !== null && (await this.clients.stagesLocally(download.downloadClientId));
    if (stagesLocally && !deleteFiles) return null;
    if ((await this.downloads.findExtension(download.id)).extendsExisting) return 'extended_torrent';
    if (download.downloadClientId === null || download.clientKey === null) return null;
    const shared = stagesLocally
      ? await this.downloads.existsOtherForClientKey(
          download.id,
          download.requestId,
          download.downloadClientId,
          download.clientKey,
          UNSETTLED_BOOK_REQUEST_DOWNLOAD_STATUSES,
        )
      : await this.downloads.existsOtherForClientKey(download.id, download.requestId, download.downloadClientId, download.clientKey);
    return shared ? 'shared_torrent' : null;
  }

  /**
   * Removing a transfer that is still working takes the attempt with it, because nothing else is
   * going to finish it. The row is failed here directly rather than through the retry path, so
   * automation does not immediately undo a removal a person asked for.
   *
   * Conditional on the row as it stands rather than as it was read: an attempt the poll loop
   * finished or failed in the meantime keeps the outcome it reached.
   */
  private async failIfInFlight(download: BookRequestDownloadRow, reason: string): Promise<boolean> {
    const failed = await this.downloads.updateIf(download.id, IN_FLIGHT_BOOK_REQUEST_DOWNLOAD_STATUSES, {
      status: 'failed',
      errorMessage: reason,
    });
    return failed !== undefined;
  }
}
