import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

import type { WebSerialKind } from '@bookorbit/types';
import { readBoundedText } from '../../../common/utils/bounded-response';
import { safeFetch } from '../../../common/utils/safe-fetch';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from '../web-serials-error.utils';

const BASE_URL = 'https://api.mangabaka.org';
const USER_AGENT = 'bookorbit/1.0 (+https://github.com/bookorbit/bookorbit)';
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type MangaBakaType = 'manga' | 'novel' | 'manhwa' | 'manhua' | 'oel' | 'other';

/** MangaBaka files Korean and Chinese comics and English-original comics under their own types; all of them download as manga. */
const SEARCH_TYPES: Record<WebSerialKind, MangaBakaType[]> = {
  manga: ['manga', 'manhwa', 'manhua', 'oel'],
  novel: ['novel'],
};

export interface MangaBakaSeries {
  id: number;
  state: string;
  merged_with: number | null;
  title: string;
  native_title: string | null;
  romanized_title: string | null;
  secondary_titles: Record<string, Array<{ title?: string | null }>> | null;
  authors: string[] | null;
  artists: string[] | null;
  status: string;
  year: number | null;
  genres: string[] | null;
  type: MangaBakaType;
  content_rating: string | null;
  description?: string | null;
  cover?: {
    raw?: { url?: string | null } | null;
    x150?: MangaBakaCoverSizes | null;
    x250?: MangaBakaCoverSizes | null;
    x350?: MangaBakaCoverSizes | null;
  } | null;
  source?: {
    anilist?: { id?: number | string | null } | null;
  } | null;
  is_licensed?: boolean | null;
  /** A number as text, such as "7", when the print run is known. */
  final_volume?: string | null;
  publishers?: MangaBakaPublisher[] | null;
}

export interface MangaBakaPublisher {
  name?: string | null;
  type?: string | null;
  language?: string | null;
}

interface MangaBakaCoverSizes {
  x1?: string | null;
  x2?: string | null;
}

const NOT_FOUND = Symbol('not found');

interface MangaBakaEnvelope {
  status?: number;
  data?: unknown;
}

@Injectable()
export class MangaBakaClient {
  async search(query: string, kind: WebSerialKind, signal?: AbortSignal, limit = 5): Promise<MangaBakaSeries[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    for (const type of SEARCH_TYPES[kind]) params.append('type', type);
    const data = await this.get(`/v1/series/search?${params.toString()}`, signal);
    return Array.isArray(data) ? data.filter(isMangaBakaSeries) : [];
  }

  async match(query: string, signal?: AbortSignal): Promise<MangaBakaSeries[]> {
    const params = new URLSearchParams({ q: query });
    const data = await this.get(`/v1/series/match?${params.toString()}`, signal);
    const entries = Array.isArray(data) ? data : data ? [data] : [];
    return entries.filter(isMangaBakaSeries);
  }

  /** Null when MangaBaka does not know the id: an answer, not a failure. */
  async getSeries(id: string, signal?: AbortSignal): Promise<MangaBakaSeries | null> {
    if (!/^\d+$/.test(id)) throw new BadRequestException('The MangaBaka series identifier is invalid');
    const series = await this.getSeriesOnce(id, signal);
    if (!series || series.merged_with === null) return series;
    return this.getSeriesOnce(String(series.merged_with), signal);
  }

  private async getSeriesOnce(id: string, signal?: AbortSignal): Promise<MangaBakaSeries | null> {
    const data = await this.get(`/v1/series/${id}`, signal, true);
    if (data === NOT_FOUND) return null;
    if (!isMangaBakaSeries(data))
      throw new BadGatewayException(codedError('MangaBaka returned an invalid series', WebSerialErrorCode.LookupFailed, { service: 'MangaBaka' }));
    return data;
  }

  private async get(path: string, signal?: AbortSignal, notFoundIsAnswer = false): Promise<unknown> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const response = await safeFetch(
      `${BASE_URL}${path}`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: requestSignal },
      { signal: requestSignal },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (notFoundIsAnswer && response.status === 404) return NOT_FOUND;
      throw new BadGatewayException(codedError('MangaBaka did not accept the request', WebSerialErrorCode.LookupFailed, { service: 'MangaBaka' }));
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    const envelope = parseEnvelope(text);
    if (notFoundIsAnswer && envelope.status === 404) return NOT_FOUND;
    if (typeof envelope.status === 'number' && (envelope.status < 200 || envelope.status >= 300)) {
      throw new BadGatewayException(
        codedError('MangaBaka returned an unsuccessful response', WebSerialErrorCode.LookupFailed, { service: 'MangaBaka' }),
      );
    }
    if (!('data' in envelope))
      throw new BadGatewayException(codedError('MangaBaka returned an invalid response', WebSerialErrorCode.LookupFailed, { service: 'MangaBaka' }));
    return envelope.data;
  }
}

function parseEnvelope(text: string): MangaBakaEnvelope {
  try {
    return JSON.parse(text) as MangaBakaEnvelope;
  } catch {
    try {
      return JSON.parse(escapeControlCharactersInStrings(text)) as MangaBakaEnvelope;
    } catch {
      throw new BadGatewayException(codedError('MangaBaka returned invalid JSON', WebSerialErrorCode.LookupFailed, { service: 'MangaBaka' }));
    }
  }
}

function escapeControlCharactersInStrings(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      result += character;
      continue;
    }
    const code = character.charCodeAt(0);
    result += inString && code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }
  return result;
}

function isMangaBakaSeries(value: unknown): value is MangaBakaSeries {
  if (!value || typeof value !== 'object') return false;
  const series = value as Record<string, unknown>;
  return (
    typeof series['id'] === 'number' &&
    Number.isSafeInteger(series['id']) &&
    typeof series['title'] === 'string' &&
    typeof series['state'] === 'string' &&
    typeof series['type'] === 'string' &&
    (series['merged_with'] === null || series['merged_with'] === undefined || Number.isSafeInteger(series['merged_with'])) &&
    isOptionalTextList(series['authors']) &&
    isOptionalTextList(series['artists']) &&
    isOptionalTextList(series['genres']) &&
    isOptionalText(series['native_title']) &&
    isOptionalText(series['romanized_title']) &&
    isSecondaryTitles(series['secondary_titles'])
  );
}

function isOptionalText(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string';
}

function isOptionalTextList(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isSecondaryTitles(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (titles) =>
      Array.isArray(titles) &&
      titles.every((entry) => !!entry && typeof entry === 'object' && isOptionalText((entry as Record<string, unknown>)['title'])),
  );
}
