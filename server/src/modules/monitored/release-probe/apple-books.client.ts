import { BadGatewayException, HttpException, Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import { buildRequestSignal, sleep } from '../../metadata-fetch/providers/provider-utils';
import { authorMatches, titleTokensMatch } from './title-match';

const APPLE_GAP_MS = 3_200;

/** iTunes throttles the address, not the caller, so the sweep and an on-demand lookup share one pause. */
export const APPLE_CLIENT_PAUSE_MS = 3 * 60 * 60 * 1000;

interface AppleSearchResponse {
  results?: Array<{
    trackName?: string;
    artistName?: string;
    releaseDate?: string;
    trackId?: number;
    trackViewUrl?: string;
  }>;
}

export interface AppleEbookCandidate {
  trackId: number;
  trackName: string;
  releaseDate: string;
  trackViewUrl: string | null;
}

export function appleCountryForAmazonDomain(domain: string): string {
  return (
    {
      'amazon.com': 'us',
      'amazon.co.uk': 'gb',
      'amazon.de': 'de',
      'amazon.fr': 'fr',
      'amazon.it': 'it',
      'amazon.es': 'es',
      'amazon.ca': 'ca',
      'amazon.com.au': 'au',
      'amazon.co.jp': 'jp',
      'amazon.in': 'in',
      'amazon.com.br': 'br',
      'amazon.com.mx': 'mx',
      'amazon.nl': 'nl',
      'amazon.se': 'se',
      'amazon.pl': 'pl',
      'amazon.sg': 'sg',
      'amazon.ae': 'ae',
      'amazon.sa': 'sa',
      'amazon.tr': 'tr',
    }[domain.trim().toLowerCase()] ?? 'us'
  );
}

@Injectable()
export class AppleBooksClient {
  private readonly logger = new Logger(AppleBooksClient.name);
  private nextAllowedTime = 0;
  private pausedUntilMs = 0;

  pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** The single best listing, which is all the probe stores for one format. */
  async searchEbook(title: string, author: string, country: string, signal?: AbortSignal): Promise<{ releaseDate: string; trackId: number } | null> {
    const [match] = await this.searchEbookCandidates(title, author, country, signal);
    return match ? { releaseDate: match.releaseDate, trackId: match.trackId } : null;
  }

  /** Every dated listing that matches, for the owner to choose from. */
  async searchEbookCandidates(title: string, author: string, country: string, signal?: AbortSignal): Promise<AppleEbookCandidate[]> {
    const body = await this.search(title, author, country, signal);
    return (body.results ?? []).flatMap((candidate) => {
      if (typeof candidate.trackName !== 'string' || typeof candidate.artistName !== 'string' || typeof candidate.trackId !== 'number') return [];
      if (!titleTokensMatch(title, candidate.trackName) || !authorMatches(author, candidate.artistName)) return [];
      const releaseDate = typeof candidate.releaseDate === 'string' ? candidate.releaseDate.slice(0, 10) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return [];
      return [
        {
          trackId: candidate.trackId,
          trackName: candidate.trackName,
          releaseDate,
          trackViewUrl: typeof candidate.trackViewUrl === 'string' ? candidate.trackViewUrl : null,
        },
      ];
    });
  }

  // iTunes answers an unauthenticated endpoint that throttles per address, so every caller queues
  // behind the same spacing rather than each search path keeping a clock of its own.
  private async search(title: string, author: string, country: string, signal?: AbortSignal): Promise<AppleSearchResponse> {
    const now = Date.now();
    if (now < this.pausedUntilMs) {
      throw new ProviderThrottleError(Math.ceil((this.pausedUntilMs - now) / 1000), 'Apple Books requests paused');
    }
    const scheduled = Math.max(now, this.nextAllowedTime);
    this.nextAllowedTime = scheduled + APPLE_GAP_MS;
    if (scheduled > now) {
      try {
        await sleep(scheduled - now, signal);
      } catch (error) {
        if (this.nextAllowedTime === scheduled + APPLE_GAP_MS) this.nextAllowedTime = scheduled;
        throw error;
      }
    }

    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', `${title} ${author}`);
    url.searchParams.set('media', 'ebook');
    url.searchParams.set('entity', 'ebook');
    url.searchParams.set('country', country.toLowerCase());
    url.searchParams.set('limit', '8');
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { signal: buildRequestSignal(15_000, signal) });
      if (response.status === 429 || response.status === 403) {
        throw new ProviderThrottleError(undefined, `HTTP ${response.status}`);
      }
      if (!response.ok) throw new BadGatewayException(`Apple Books returned HTTP ${response.status}`);
      return (await response.json()) as AppleSearchResponse;
    } catch (error) {
      if (error instanceof ProviderThrottleError) this.pauseRequests(Date.now() - startedAt, error.message);
      if (error instanceof HttpException || error instanceof ProviderThrottleError) throw error;
      throw new BadGatewayException('Apple Books request failed', { cause: error });
    }
  }

  private pauseRequests(durationMs: number, message: string): void {
    const now = Date.now();
    if (now < this.pausedUntilMs) return;
    this.pausedUntilMs = now + APPLE_CLIENT_PAUSE_MS;
    this.logger.warn(
      `[monitored.release_probe.apple] [fail] durationMs=${durationMs} pausedUntil=${new Date(this.pausedUntilMs).toISOString()} errorClass=ProviderThrottleError error="${sanitizeLogValue(message)}" - requests paused`,
    );
  }
}
