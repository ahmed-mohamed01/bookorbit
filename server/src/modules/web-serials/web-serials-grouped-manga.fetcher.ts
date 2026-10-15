import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { EngineUnitHandle, EngineUnitSpec } from './engines/web-serial-engine';
import type { WebSerialJobItemRow } from './schema/web-serials.schema';
import { mergeCbzChapters, type MergedCbzResult } from './web-serials-cbz-merge.utils';
import { classifyFailure } from './web-serials-failure.utils';
import { memberSequence, memberUnitKey, parseGroupedChapters, seriesRangeNumber } from './web-serials-grouped-chapters.utils';
import { WEB_SERIAL_SIZE_CAPS, WebSerialsImportService } from './web-serials-import.service';
import { describeError } from './web-serials-log.utils';
import { buildDockMetadata, growingVolumeRange } from './web-serials-metadata.utils';
import {
  ItemFailure,
  JobStopped,
  type CurrentUnitMapper,
  importingUnit,
  type ItemRemoteRef,
  type JobContext,
  type RunnerOps,
} from './web-serials-runner.shared';
import { WebSerialsRepository } from './web-serials.repository';

/** Downloads the member chapters of a grouped manga unit, merges them into one CBZ and imports it. Plain class, built by the job runner. */
export class GroupedMangaFetcher {
  private readonly logger = new Logger(GroupedMangaFetcher.name);

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly importer: WebSerialsImportService,
    private readonly ops: RunnerOps,
  ) {}

  /** Null when the job was cancelled before the unit finished. */
  async fetchAndImport(context: JobContext, item: WebSerialJobItemRow, ref: ItemRemoteRef & { unit: EngineUnitSpec }): Promise<number | null> {
    const { job, client, connection, remoteId, series } = context;
    const chapters = parseGroupedChapters(ref.unit);
    const workDir = await this.importer.prepareUnitWorkDir(job.id, item.id);
    const chapterPaths: string[] = [];
    let totalBytes = 0;
    await this.repo.updateItem(item.id, { status: 'fetching' });

    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index]!;
      const chapterPath = join(workDir, `chapter-${String(index + 1).padStart(4, '0')}.cbz`);
      chapterPaths.push(chapterPath);
      const savedBytes = await fileSize(chapterPath);
      if (savedBytes > 0) {
        totalBytes += savedBytes;
        assertWithinBookCap(totalBytes);
        continue;
      }
      const label = chapter.label ?? `Chapter ${chapter.sequence ?? index + 1}`;
      const member: EngineUnitSpec = {
        unitKey: memberUnitKey(chapter, item.unitKey, index),
        label,
        sequence: memberSequence(chapter, index),
        chapterCount: 1,
        publishedAt: chapter.publishedAt,
        packaging: 'chapter',
        remote: chapter.raw,
      };
      let downloadedBytes: number;
      try {
        let handle: EngineUnitHandle;
        if (ref.member?.index === index) {
          handle = { unitKey: member.unitKey, remote: ref.member.handle };
        } else {
          handle = await client.startUnit(connection, remoteId, member);
          ref.member = { index, handle: handle.remote };
          await this.repo.setItemMember(item.id, ref.member);
        }
        const grouped: CurrentUnitMapper = (progress) => ({
          label: item.label,
          stage: 'fetching',
          chaptersDone: index,
          chaptersTotal: chapters.length,
          progress: Math.min(1, (index + (progress.progress ?? 0)) / chapters.length),
        });
        if (!(await this.ops.waitForUnit(context, handle, grouped))) {
          await client.cancelUnit?.(connection, handle).catch(() => undefined);
          await this.repo.releaseItem(item.id);
          return null;
        }
        const download = await client.download(connection, handle, context.signal);
        if (download.format !== 'cbz') throw new ItemFailure(`${label} was not returned as a CBZ file.`);
        downloadedBytes = await this.importer.saveWorkDownload(download, chapterPath);
        ref.member = null;
        await this.repo.setItemMember(item.id, null);
      } catch (error) {
        if (error instanceof JobStopped) throw error;
        throw new ItemFailure(`${label} could not be downloaded.`, error instanceof ItemFailure ? error.reason : classifyFailure(error));
      }
      totalBytes += downloadedBytes;
      assertWithinBookCap(totalBytes);
    }

    const metadata = buildDockMetadata(
      series,
      { label: item.label, sequence: item.sequence, publishedAt: ref.unit.publishedAt, chapterRange: growingVolumeRange(item.unitKey) },
      ref.unit.packaging,
      job.metadata,
    );
    if (await this.ops.shouldStop(job.id)) return null;
    await this.ops.writeCurrentUnit(job.id, {
      label: item.label,
      stage: 'building',
      chaptersDone: chapters.length,
      chaptersTotal: chapters.length,
      progress: 1,
    });
    const mergeStartedAt = Date.now();
    this.logger.log(`[web_serials.merge] [start] jobId=${job.id} unitKey=${item.unitKey} chapters=${chapters.length} - CBZ merge started`);
    let merged: MergedCbzResult;
    try {
      merged = await mergeCbzChapters(
        chapterPaths,
        join(workDir, 'merged.cbz'),
        {
          series: job.metadata.match?.title || series.title,
          title: metadata.title ?? series.title,
          volume: ref.unit.packaging === 'volume' ? ref.unit.sequence : null,
          number: ref.unit.packaging === 'volume' ? ref.unit.sequence : seriesRangeNumber(ref.unit),
          writers: metadata.authors ?? [],
          pencillers: metadata.comicMetadata?.pencillers ?? [],
          summary: metadata.description ?? null,
          genres: metadata.genres ?? [],
          language: metadata.language ?? null,
          web: series.sourceUrl,
        },
        WEB_SERIAL_SIZE_CAPS.manga,
      );
      this.logger.log(
        `[web_serials.merge] [end] jobId=${job.id} unitKey=${item.unitKey} chapters=${chapters.length} pages=${merged.pages} sizeBytes=${merged.sizeBytes} durationMs=${Date.now() - mergeStartedAt} - CBZ merge completed`,
      );
    } catch (error) {
      const { errorClass, message } = describeError(error);
      this.logger.warn(
        `[web_serials.merge] [fail] jobId=${job.id} unitKey=${item.unitKey} chapters=${chapters.length} pages=0 sizeBytes=0 durationMs=${Date.now() - mergeStartedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - CBZ merge failed`,
      );
      throw error;
    }
    if (await this.ops.shouldStop(job.id)) return null;
    if (!(await this.repo.transitionJob(job.id, ['running', 'importing'], { status: 'importing', heartbeatAt: new Date() }))) {
      await this.repo.releaseItem(item.id);
      return null;
    }
    await this.repo.updateItem(item.id, { status: 'importing' });
    await this.ops.writeCurrentUnit(job.id, importingUnit(item.label));
    const bookId = await this.importer.importUnit({
      jobId: job.id,
      itemId: item.id,
      userId: job.userId,
      kind: job.kind,
      download: { stream: createReadStream(merged.path), fileName: 'merged.cbz', format: 'cbz', size: merged.sizeBytes },
      metadata,
      targetLibraryId: job.targetLibraryId,
      targetFolderId: await this.ops.resolveTargetFolder(job),
    });
    await this.importer.cleanupUnitWorkDir(job.id, item.id);
    await this.repo.transitionJob(job.id, ['importing'], { status: 'running', heartbeatAt: new Date() });
    return bookId;
  }
}

function assertWithinBookCap(totalBytes: number): void {
  if (totalBytes > WEB_SERIAL_SIZE_CAPS.manga) throw new ItemFailure('The book would be larger than the allowed size', 'unknown');
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
