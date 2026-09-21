import { BadGatewayException, HttpException, Injectable, Logger } from '@nestjs/common';

import { amazonRequestHeaders, isAmazonBotChallenge } from '../../../common/utils/amazon-http.utils';
import { readBoundedText } from '../../../common/utils/bounded-response';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { amazonOrigin } from '../../../common/utils/metadata-provider-hosts.utils';
import { fetchWithThrottle } from '../../metadata-fetch/fetch-with-throttle';
import { ProviderThrottleError } from '../../metadata-fetch/provider-throttle.error';
import { PROVIDER_DELAYS_MS, PROVIDER_TIMEOUT_MS } from '../../metadata-fetch/providers/provider-constants';
import { buildRequestSignal, sleep } from '../../metadata-fetch/providers/provider-utils';

/** A product page is under 1 MB today; the cap only stops a runaway body from filling memory. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** Amazon throttles the address, not the caller, so the sweep and an on-demand lookup share one pause. */
export const AMAZON_CLIENT_PAUSE_MS = 6 * 60 * 60 * 1000;

interface AmazonConnection {
  domain: string;
  cookie: string;
}

@Injectable()
export class AmazonProductPageClient {
  private readonly logger = new Logger(AmazonProductPageClient.name);
  private nextAllowedTime = 0;
  private pausedUntilMs = 0;

  pausedUntil(): number {
    return this.pausedUntilMs;
  }

  async fetchProductPage(asin: string, amazon: AmazonConnection, signal?: AbortSignal): Promise<{ html: string } | { notFound: true }> {
    const url = `${amazonOrigin(amazon.domain)}/dp/${encodeURIComponent(asin)}`;
    const result = await this.request(url, asin, amazon, signal, true);
    return result.notFound ? { notFound: true } : { html: result.html };
  }

  async fetchSearchPage(query: string, amazon: AmazonConnection, signal?: AbortSignal): Promise<{ html: string }> {
    const url = `${amazonOrigin(amazon.domain)}/s?k=${encodeURIComponent(query)}&i=stripbooks`;
    const result = await this.request(url, '', amazon, signal, false);
    return { html: result.html };
  }

  private async request(
    url: string,
    asin: string,
    amazon: AmazonConnection,
    signal: AbortSignal | undefined,
    allowNotFound: boolean,
  ): Promise<{ html: string; notFound: boolean }> {
    const now = Date.now();
    if (now < this.pausedUntilMs) {
      throw new ProviderThrottleError(Math.ceil((this.pausedUntilMs - now) / 1000), 'Amazon requests paused');
    }
    const scheduled = Math.max(now, this.nextAllowedTime);
    this.nextAllowedTime = scheduled + PROVIDER_DELAYS_MS.AMAZON_BETWEEN_REQUESTS;
    if (scheduled > now) {
      try {
        await sleep(scheduled - now, signal);
      } catch (error) {
        if (this.nextAllowedTime === scheduled + PROVIDER_DELAYS_MS.AMAZON_BETWEEN_REQUESTS) this.nextAllowedTime = scheduled;
        throw error;
      }
    }

    const startedAt = Date.now();
    try {
      const response = await fetchWithThrottle(url, {
        headers: amazonRequestHeaders(url, amazon.cookie),
        signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal),
      });
      if (allowNotFound && response.status === 404) return { html: '', notFound: true };
      const html = await readBoundedText(response, MAX_PAGE_BYTES);
      if (response.status === 503 || isAmazonBotChallenge(html)) {
        throw new ProviderThrottleError(undefined, response.status === 503 ? 'HTTP 503' : 'Amazon bot challenge');
      }
      if (!response.ok) throw new BadGatewayException(`Amazon returned HTTP ${response.status}`);
      return { html, notFound: false };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[monitored.release_probe.amazon] [fail] asin="${sanitizeLogValue(asin)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Amazon request failed`,
      );
      if (error instanceof ProviderThrottleError) this.pauseRequests(Date.now() - startedAt, message);
      if (error instanceof HttpException || error instanceof ProviderThrottleError) throw error;
      throw new BadGatewayException('Amazon request failed', { cause: error });
    }
  }

  private pauseRequests(durationMs: number, message: string): void {
    const now = Date.now();
    if (now < this.pausedUntilMs) return;
    this.pausedUntilMs = now + AMAZON_CLIENT_PAUSE_MS;
    this.logger.warn(
      `[monitored.release_probe.amazon] [fail] durationMs=${durationMs} pausedUntil=${new Date(this.pausedUntilMs).toISOString()} errorClass=ProviderThrottleError error="${sanitizeLogValue(message)}" - requests paused`,
    );
  }
}
