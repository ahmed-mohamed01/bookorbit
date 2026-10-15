import { BadGatewayException, Injectable } from '@nestjs/common';

import { readBoundedText } from '../../../common/utils/bounded-response';
import { safeFetch } from '../../../common/utils/safe-fetch';
import type { EngineUnitSpec } from '../engines/web-serial-engine';
import type { MangaBakaSeries } from './mangabaka.client';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from '../web-serials-error.utils';

const BASE_URL = 'https://api.mangadex.org';
const USER_AGENT = 'bookorbit/1.0 (+https://github.com/bookorbit/bookorbit)';
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_SEARCHES = 3;

interface MangaDexSearchEntry {
  id: string;
  attributes?: {
    links?: { al?: string | null } | null;
  } | null;
}

interface MangaDexSearchResponse {
  data?: MangaDexSearchEntry[];
}

interface MangaDexAggregateChapter {
  chapter?: string | null;
}

interface MangaDexAggregateVolume {
  volume?: string | null;
  chapters?: Record<string, MangaDexAggregateChapter> | null;
}

interface MangaDexAggregateResponse {
  volumes?: Record<string, MangaDexAggregateVolume>;
}

@Injectable()
export class MangaDexClient {
  async chapterVolumes(series: MangaBakaSeries, units: EngineUnitSpec[], signal?: AbortSignal): Promise<Record<string, string> | null> {
    const anilistId = series.source?.anilist?.id;
    if ((typeof anilistId !== 'number' && typeof anilistId !== 'string') || !String(anilistId).trim()) return null;

    const mangaId = await this.findByAniListId(series, String(anilistId), signal);
    if (!mangaId) return null;
    const aggregate = await this.get<MangaDexAggregateResponse>(`/manga/${encodeURIComponent(mangaId)}/aggregate`, signal);
    const byChapter = new Map<number, string>();
    for (const [volumeKey, volume] of Object.entries(aggregate.volumes ?? {})) {
      if (volumeKey === 'none') continue;
      const volumeNumber = cleanNumber(volume.volume ?? volumeKey);
      if (!volumeNumber) continue;
      for (const chapter of Object.values(volume.chapters ?? {})) {
        const chapterNumber = Number(chapter.chapter);
        if (Number.isFinite(chapterNumber)) byChapter.set(chapterNumber, volumeNumber);
      }
    }

    const result: Record<string, string> = {};
    for (const unit of units) {
      const volume = byChapter.get(Number(unit.sequence));
      if (volume) result[unit.unitKey] = volume;
    }
    return result;
  }

  private async findByAniListId(series: MangaBakaSeries, anilistId: string, signal?: AbortSignal): Promise<string | null> {
    for (const title of searchTitles(series).slice(0, MAX_TITLE_SEARCHES)) {
      const params = new URLSearchParams({ title, limit: '10' });
      const response = await this.get<MangaDexSearchResponse>(`/manga?${params.toString()}`, signal);
      const matched = response.data?.find((entry) => entry.attributes?.links?.al === anilistId);
      if (matched?.id) return matched.id;
    }
    return null;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const response = await safeFetch(
      `${BASE_URL}${path}`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: requestSignal },
      { signal: requestSignal },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException(codedError('MangaDex did not accept the request', WebSerialErrorCode.LookupFailed, { service: 'MangaDex' }));
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadGatewayException(codedError('MangaDex returned invalid JSON', WebSerialErrorCode.LookupFailed, { service: 'MangaDex' }));
    }
  }
}

function searchTitles(series: MangaBakaSeries): string[] {
  const secondary = Object.values(series.secondary_titles ?? {}).flatMap((entries) => entries.map((entry) => entry.title));
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const value of [series.title, series.romanized_title, ...secondary]) {
    const title = value?.trim();
    const key = title?.toLocaleLowerCase();
    if (!title || !key || seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

function cleanNumber(value: string): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Number.isInteger(parsed) ? String(parsed) : String(parsed).replace(/0+$/, '').replace(/\.$/, '');
}
