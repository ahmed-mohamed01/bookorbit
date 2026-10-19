import { BadRequestException, type Logger } from '@nestjs/common';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { GrabPayload } from './download-client-adapter';

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .normalize('NFC')
    .replace(/^(?:\.\/|\/)+/, '');
}

export function matchWantedFiles(
  clientPaths: readonly string[],
  wantedPaths: readonly string[],
): { wantedIndexes: number[]; skippedIndexes: number[]; missing: string[] } {
  const normalizedWanted = wantedPaths.map(normalizePath);
  const wanted = new Set(normalizedWanted);
  const matched = new Set<string>();
  const wantedIndexes: number[] = [];
  const skippedIndexes: number[] = [];

  clientPaths.forEach((path, index) => {
    const normalized = normalizePath(path);
    const separator = normalized.indexOf('/');
    const relative = separator === -1 ? undefined : normalized.slice(separator + 1);
    const exactMatch = wanted.has(normalized);
    const relativeMatch = relative !== undefined && wanted.has(relative);

    if (exactMatch || relativeMatch) {
      wantedIndexes.push(index);
      if (exactMatch) matched.add(normalized);
      if (relativeMatch) matched.add(relative);
    } else {
      skippedIndexes.push(index);
    }
  });

  return {
    wantedIndexes,
    skippedIndexes,
    missing: wantedPaths.filter((_, index) => !matched.has(normalizedWanted[index])),
  };
}

export function validateFileSelection(release: GrabPayload): void {
  if (release.wantedPaths !== undefined && !release.torrentFile) {
    throw new BadRequestException('The download client did not accept the file selection: a .torrent file is required');
  }
}

export async function applyFileSelection(options: {
  clientId: number;
  clientKey: string;
  wantedPaths: string[];
  logger: Pick<Logger, 'log' | 'warn'>;
  listFiles(): Promise<string[]>;
  skip(indexes: number[]): Promise<void>;
  start(): Promise<void>;
  remove(): Promise<void>;
}): Promise<void> {
  const { clientId, clientKey, wantedPaths, logger } = options;
  const started = Date.now();
  logger.log(
    `[download_client.select_files] [start] clientId=${clientId} clientKey=${clientKey} wanted=${wantedPaths.length} - applying file selection`,
  );
  try {
    const files = await options.listFiles();
    if (!files.length) throw new BadRequestException('the client returned no files');
    const selection = matchWantedFiles(files, wantedPaths);
    if (selection.missing.length) throw new BadRequestException('wanted files are missing');
    await options.skip(selection.skippedIndexes);
    await options.start();
    logger.log(
      `[download_client.select_files] [end] clientId=${clientId} clientKey=${clientKey} wanted=${selection.wantedIndexes.length} skipped=${selection.skippedIndexes.length} durationMs=${Date.now() - started} - file selection applied`,
    );
  } catch (error) {
    await options.remove().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[download_client.select_files] [fail] clientId=${clientId} clientKey=${clientKey} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.constructor.name : 'UnknownError'} error="${sanitizeLogValue(detail)}" - file selection failed`,
    );
    throw new BadRequestException(`The download client did not accept the file selection: ${detail}`);
  }
}

export async function extendFileSelection(options: {
  clientId: number;
  clientKey: string;
  wantedPaths: string[];
  logger: Pick<Logger, 'log' | 'warn'>;
  listFiles(): Promise<string[]>;
  enable(indexes: number[]): Promise<void>;
  start(): Promise<void>;
}): Promise<void> {
  const { clientId, clientKey, wantedPaths, logger } = options;
  const started = Date.now();
  logger.log(
    `[download_client.extend_selection] [start] clientId=${clientId} clientKey=${clientKey} wanted=${wantedPaths.length} - adding files to a torrent the client already holds`,
  );
  try {
    const files = await options.listFiles();
    if (!files.length) throw new BadRequestException('the client returned no files');
    const selection = matchWantedFiles(files, wantedPaths);
    if (selection.missing.length) throw new BadRequestException('wanted files are missing');
    await options.enable(selection.wantedIndexes);
    await options.start();
    logger.log(
      `[download_client.extend_selection] [end] clientId=${clientId} clientKey=${clientKey} wanted=${selection.wantedIndexes.length} durationMs=${Date.now() - started} - file selection extended`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[download_client.extend_selection] [fail] clientId=${clientId} clientKey=${clientKey} wanted=${wantedPaths.length} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.constructor.name : 'UnknownError'} error="${sanitizeLogValue(detail)}" - extending the file selection failed`,
    );
    throw new BadRequestException(`The download client did not accept the file selection: ${detail}`);
  }
}
