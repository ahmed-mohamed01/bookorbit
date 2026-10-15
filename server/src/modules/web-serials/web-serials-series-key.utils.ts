import { BadRequestException } from '@nestjs/common';

import type { WebSerialKind, WebSerialSeriesKey } from '@bookorbit/types';
import type { EngineSeriesRef } from './engines/web-serial-engine';

const SERIES_KEY_PATTERN = /^([mn]):([A-Za-z0-9._-]{1,200})$/;
const NOVEL_SOURCES_KEY_PATTERN = /^nl:([A-Za-z0-9._-]{1,100}):([A-Za-z0-9_-]{1,500})$/;
/** Every key the API accepts: engine series keys and LNReader novel keys. Used to validate request bodies. */
export const SERIES_KEY_FORMAT = /^(?:[mn]:[A-Za-z0-9._-]{1,200}|nl:[A-Za-z0-9._-]{1,100}:[A-Za-z0-9_-]{1,500})$/;
const KIND_PREFIX: Record<WebSerialKind, string> = { manga: 'm', novel: 'n' };

export function makeSeriesKey(kind: WebSerialKind, remoteId: string): WebSerialSeriesKey {
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
  const novelSources = NOVEL_SOURCES_KEY_PATTERN.exec(key);
  if (novelSources) return { kind: 'novel', remoteId: `${novelSources[1]}:${novelSources[2]}` };
  const match = SERIES_KEY_PATTERN.exec(key);
  if (!match) throw new BadRequestException('Invalid series key');
  return { kind: match[1] === 'm' ? 'manga' : 'novel', remoteId: match[2]! };
}

export function seriesCoverPath(seriesKey: WebSerialSeriesKey): string {
  return `/api/v1/web-serials/series/${seriesKey}/cover`;
}
