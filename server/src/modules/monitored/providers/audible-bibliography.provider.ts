import { Injectable, Logger } from '@nestjs/common';
import type { ProviderConfigurations } from '@bookorbit/types';

import { audibleApiOrigin } from '../../../common/utils/metadata-provider-hosts.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { fetchWithThrottle } from '../../metadata-fetch/fetch-with-throttle';
import type { AudibleProduct, AudibleSearchResponse } from '../../metadata-fetch/providers/audible/audible.types';
import { normalizeAudibleDomain } from '../../metadata-fetch/providers/audible/normalize-audible-domain';
import { PROVIDER_TIMEOUT_MS } from '../../metadata-fetch/providers/provider-constants';
import { buildRequestSignal, sleep, stripHtml } from '../../metadata-fetch/providers/provider-utils';
import { normalizeText } from '../reconcile/observation-matcher';
import type { Observation } from '../reconcile/observation.types';
import type { AuthorBibliographyProvider, BibliographyAuthorRef } from './author-bibliography-provider';

// Audible reports how many products an author has (total_results), and prolific authors report far
// more than three pages held: a 201-product author lost 51 audiobooks to the old fixed cap, and every
// one of them was a work the catalog then had no Audible edition for. Pagination follows the reported
// total, with a hard page cap so a runaway or mis-reported total cannot walk a live catalog forever.
const MAX_PAGES = 10;
const PAGE_SIZE = 50;
const PAGE_DELAY_MS = 400;

type BibliographyAudibleProduct = AudibleProduct & { issue_date?: string };

function authorKey(name: string): string {
  return normalizeText(name).replace(/ /g, '');
}

function nameVariants(name: string): string[] {
  return [...new Set([name, name.replace(/([a-z])([A-Z])/g, '$1 $2')])];
}

export function filterAudibleProductsByAuthor(products: AudibleProduct[], authorName: string): AudibleProduct[] {
  const target = authorKey(authorName);
  return products.filter((product) => product.authors?.some((author) => authorKey(author.name) === target));
}

export function mapAudibleObservations(rawRows: unknown[]): Observation[] {
  return (rawRows as BibliographyAudibleProduct[]).flatMap((product) => {
    if (!product.asin || !product.title?.trim()) return [];
    const releaseDate = (product.release_date || product.issue_date || '').slice(0, 10) || null;
    const seriesName = product.series?.[0]?.title?.trim() || null;
    const seriesIndex = product.series?.[0]?.sequence == null ? null : String(product.series[0].sequence);
    return [
      {
        source: 'audible' as const,
        id: `aud:${product.asin}`,
        canonicalId: null,
        title: product.title.trim(),
        subtitle: product.subtitle?.trim() || null,
        hasDesc: Boolean(product.merchandising_summary || product.publisher_summary),
        description: stripHtml(product.merchandising_summary || product.publisher_summary || '').trim() || null,
        cover: product.product_images?.['500'] ?? product.product_images?.['1024'] ?? null,
        releaseDate,
        releaseYear: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
        precision: releaseDate ? ('day' as const) : null,
        seriesName,
        seriesIndex,
        seriesMemberships: seriesName ? [{ name: seriesName, index: seriesIndex }] : [],
        popularity: product.rating?.overall_distribution?.num_ratings ?? 0,
        popularityKind: 'ratings' as const,
        format: 'audiobook' as const,
        language: product.language?.toLowerCase() || null,
        role: null,
        isbn10: null,
        isbn13: null,
        asin: product.asin,
        raw: product,
      },
    ];
  });
}

@Injectable()
export class AudibleBibliographyProvider implements AuthorBibliographyProvider {
  readonly source = 'audible' as const;
  readonly curated = true;
  private readonly logger = new Logger(AudibleBibliographyProvider.name);
  private readonly resolvedProducts = new Map<string, AudibleProduct[]>();

  isEnabled(config: ProviderConfigurations): boolean {
    return config.audible.enabled;
  }

  async resolveAuthor(
    name: string,
    config: ProviderConfigurations,
    existingId?: string,
    signal?: AbortSignal,
  ): Promise<BibliographyAuthorRef | null> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.provider.audible] [start] op=resolve authorName="${sanitizeLogValue(name)}" - author resolution started`);
    try {
      if (!this.isEnabled(config)) return null;
      for (const variant of nameVariants(existingId || name)) {
        const products = await this.fetchProducts(variant, config.audible.domain, signal);
        const confirmed = filterAudibleProductsByAuthor(products, name);
        if (confirmed.length === 0) continue;
        this.resolvedProducts.set(authorKey(name), confirmed);
        this.logger.log(
          `[monitored.provider.audible] [end] op=resolve durationMs=${Date.now() - startedAt} found=true products=${confirmed.length} - author resolution completed`,
        );
        return { id: variant, name, bookCount: confirmed.length, imageUrl: null };
      }
      this.logger.log(
        `[monitored.provider.audible] [end] op=resolve durationMs=${Date.now() - startedAt} found=false products=0 - author resolution completed`,
      );
      return null;
    } catch (error) {
      this.logFailure('resolve', name, startedAt, error);
      throw error;
    }
  }

  async fetchObservations(authorRef: BibliographyAuthorRef, config: ProviderConfigurations, signal?: AbortSignal): Promise<Observation[]> {
    const startedAt = Date.now();
    this.logger.log(`[monitored.provider.audible] [start] op=fetch authorName="${sanitizeLogValue(authorRef.name)}" - bibliography fetch started`);
    try {
      if (!this.isEnabled(config)) return [];
      const cached = this.resolvedProducts.get(authorKey(authorRef.name));
      const fetched = cached ?? (await this.fetchProducts(authorRef.id, config.audible.domain, signal));
      const products = filterAudibleProductsByAuthor(fetched, authorRef.name);
      this.resolvedProducts.delete(authorKey(authorRef.name));
      const observations = this.toObservations(products);
      this.logger.log(
        `[monitored.provider.audible] [end] op=fetch durationMs=${Date.now() - startedAt} observations=${observations.length} - bibliography fetch completed`,
      );
      return observations;
    } catch (error) {
      this.logFailure('fetch', authorRef.name, startedAt, error);
      throw error;
    }
  }

  toObservations(rawRows: unknown[]): Observation[] {
    return mapAudibleObservations(rawRows);
  }

  private async fetchProducts(authorName: string, domain: string, signal?: AbortSignal): Promise<AudibleProduct[]> {
    const startedAt = Date.now();
    const products: AudibleProduct[] = [];
    let totalResults: number | null = null;
    let complete = false;
    let pages = 0;
    while (pages < MAX_PAGES && !complete) {
      if (pages > 0) await sleep(PAGE_DELAY_MS, signal);
      const url = new URL('/1.0/catalog/products', audibleApiOrigin(normalizeAudibleDomain(domain)));
      url.searchParams.set('author', authorName);
      url.searchParams.set('num_results', String(PAGE_SIZE));
      url.searchParams.set('page', String(pages));
      url.searchParams.set('response_groups', 'product_attrs,product_desc,series,rating,media,contributors');
      url.searchParams.set('products_sort_by', '-ReleaseDate');
      const response = await fetchWithThrottle(url.toString(), { signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal) });
      if (!response.ok) throw new Error(`Audible catalog returned HTTP ${response.status}`);
      const body = (await response.json()) as AudibleSearchResponse;
      if (totalResults == null && typeof body.total_results === 'number') totalResults = body.total_results;
      const batch = body.products ?? [];
      products.push(...batch);
      pages++;
      // total_results is a hint, not a contract: Audible ships stale and understated counts, and
      // trusting one truncated a catalog that had more pages waiting. A FULL page is the only
      // evidence that more may follow, and a short or empty page is the only evidence that none do.
      complete = batch.length < PAGE_SIZE;
    }
    if (!complete) {
      this.logger.warn(
        `[monitored.provider.audible] [end] op=fetch_products authorName="${sanitizeLogValue(authorName)}" durationMs=${Date.now() - startedAt} pages=${pages} fetched=${products.length} total=${totalResults ?? 'unknown'} capped=true - audible pagination stopped at the page cap`,
      );
    }
    return products;
  }

  private logFailure(op: string, authorName: string, startedAt: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[monitored.provider.audible] [fail] op=${op} authorName="${sanitizeLogValue(authorName)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${message}" - bibliography provider failed`,
    );
  }
}
