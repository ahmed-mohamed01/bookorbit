import { BadRequestException } from '@nestjs/common';

import type { WebSerialKind, WebSerialSeriesKey } from '@bookorbit/types';
import type { EngineSeriesRef } from './engines/web-serial-engine';

const SERIES_KEY_PATTERN = /^([mn]):([A-Za-z0-9._-]{1,200})$/;
const NOVEL_SOURCES_KEY_PATTERN = /^nl:([A-Za-z0-9._-]{1,100}):([A-Za-z0-9_-]{1,500})$/;
const FILE_INDEX_KEY_PATTERN = /^nf:(\d{1,9})-(\d{1,12})$/;
const FILE_INDEX_REMOTE_ID_PATTERN = /^fi-(\d{1,9})-(\d{1,12})$/;
/** Every key the API accepts: engine series keys, LNReader novel keys and file index series. Used to validate request bodies. */
export const SERIES_KEY_FORMAT = /^(?:[mn]:[A-Za-z0-9._-]{1,200}|nl:[A-Za-z0-9._-]{1,100}:[A-Za-z0-9_-]{1,500}|nf:\d{1,9}-\d{1,12})$/;
const KIND_PREFIX: Record<WebSerialKind, string> = { manga: 'm', novel: 'n' };

/** A file index series: `fi-<indexId>-<seriesId>`. It never holds a colon, so it is never taken for an LNReader id. */
export function fileIndexRemoteId(indexId: number, seriesId: number): string {
  return `fi-${indexId}-${seriesId}`;
}

export function parseFileIndexRemoteId(remoteId: string): { indexId: number; seriesId: number } | null {
  const match = FILE_INDEX_REMOTE_ID_PATTERN.exec(remoteId);
  return match ? { indexId: Number(match[1]), seriesId: Number(match[2]) } : null;
}

export function isFileIndexRemoteId(remoteId: string | undefined): boolean {
  return remoteId !== undefined && FILE_INDEX_REMOTE_ID_PATTERN.test(remoteId);
}

export function makeSeriesKey(kind: WebSerialKind, remoteId: string): WebSerialSeriesKey {
  const fileIndex = kind === 'novel' ? parseFileIndexRemoteId(remoteId) : null;
  if (fileIndex) return `nf:${fileIndex.indexId}-${fileIndex.seriesId}`;
  if (kind === 'novel' && remoteId.includes(':')) {
    const split = remoteId.indexOf(':');
    const sourceId = remoteId.slice(0, split);
    const encodedPath = remoteId.slice(split + 1);
    if (!NOVEL_SOURCES_KEY_PATTERN.test(`nl:${sourceId}:${encodedPath}`)) throw new BadRequestException('Invalid series key');
    return `nl:${sourceId}:${encodedPath}`;
  }
  return `${KIND_PREFIX[kind]}:${remoteId}`;
}

/** Null for a remote id no series key can carry (an over-long LNReader path), for lists that skip such entries. */
export function tryMakeSeriesKey(kind: WebSerialKind, remoteId: string): WebSerialSeriesKey | null {
  try {
    return makeSeriesKey(kind, remoteId);
  } catch {
    return null;
  }
}

export function parseSeriesKey(key: string): EngineSeriesRef {
  const fileIndex = FILE_INDEX_KEY_PATTERN.exec(key);
  if (fileIndex) return { kind: 'novel', remoteId: fileIndexRemoteId(Number(fileIndex[1]), Number(fileIndex[2])) };
  const novelSources = NOVEL_SOURCES_KEY_PATTERN.exec(key);
  if (novelSources) return { kind: 'novel', remoteId: `${novelSources[1]}:${novelSources[2]}` };
  const match = SERIES_KEY_PATTERN.exec(key);
  if (!match) throw new BadRequestException('Invalid series key');
  return { kind: match[1] === 'm' ? 'manga' : 'novel', remoteId: match[2]! };
}

export function seriesCoverPath(seriesKey: WebSerialSeriesKey): string {
  return `/api/v1/web-serials/series/${seriesKey}/cover`;
}
