import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import type {
  MetadataCandidate,
  MonitoredFormat,
  MonitoredReleaseDateCandidate,
  MonitoredReleaseDateLookup,
  MonitoredReleaseLookupSource,
  ProviderConfigurations,
} from '@bookorbit/types';
import { MetadataProviderKey } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { amazonOrigin } from '../../common/utils/metadata-provider-hosts.utils';
import { parsePublishedDateKey } from '../../common/utils/published-date.utils';
import { ProviderRegistry } from '../metadata-fetch/provider-registry';
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import type { MetadataProvider } from '../metadata-fetch/providers/metadata-provider';
import { HardcoverClient } from '../metadata-fetch/providers/hardcover/hardcover.client';
import { normalizeAudibleDomain } from '../metadata-fetch/providers/audible/normalize-audible-domain';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import { isAudibleConfigured } from './providers/audible-bibliography.provider';
import { isHardcoverConfigured } from './providers/hardcover-bibliography.provider';
import { fetchAmazonPage, findAmazonFamily, pageBudget } from './release-probe/amazon-family';
import { AmazonProductPageClient } from './release-probe/amazon-product-page.client';
import { AppleBooksClient, appleCountryForAmazonDomain } from './release-probe/apple-books.client';
import { AudibleCatalogClient, type AudibleCatalogProduct } from './release-probe/audible-catalog.client';
import { dominantLanguage, editionsForFormat, isStrongEdition, mapHardcoverProbeBook } from './release-probe/hardcover-edition-evidence';
import { authorMatches, titleTokensMatch } from './release-probe/title-match';

export const LOOKUP_AMAZON_PAGES = 3;
export const LOOKUP_DEADLINE_MS = 25_000;
export const LOOKUP_CACHE_TTL_MS = 60_000;

const LOOKUP_CACHE_MAX_ENTRIES = 200;

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReleaseDateLookupTarget {
  workId: string;
  title: string;
  authorName: string;
  hardcoverSlug: string | null;
  audibleAsin: string | null;
  format: MonitoredFormat;
  userId: number;
}

type LookupResult = Pick<MonitoredReleaseDateLookup, 'candidates' | 'unavailable' | 'empty'>;

interface CachedLookup {
  promise: Promise<MonitoredReleaseDateLookup>;
  expiresAt: number;
}

function unavailable(source: MonitoredReleaseLookupSource, reason: MonitoredReleaseDateLookup['unavailable'][number]['reason']): LookupResult {
  return { candidates: [], unavailable: [{ source, reason }], empty: [] };
}

function publishedDatePrecision(publishedDate: string): MonitoredReleaseDateCandidate['precision'] | null {
  if (publishedDate.length === 10) return 'day';
  if (publishedDate.length === 7) return 'month';
  if (publishedDate.length === 4) return 'year';
  return null;
}

function metadataCandidateMatches(target: ReleaseDateLookupTarget, candidate: MetadataCandidate): boolean {
  const title = candidate.title?.trim();
  if (!title) return false;
  const titles = candidate.subtitle?.trim() ? [title, `${title}: ${candidate.subtitle.trim()}`] : [title];
  return (
    titles.some((candidateTitle) => titleTokensMatch(target.title, candidateTitle)) &&
    (candidate.authors ?? []).some((author) => authorMatches(target.authorName, author))
  );
}

/** Provider payloads supply some of these urls and the owner's browser follows them, so only https passes. */
function candidateUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function audibleProductUrl(domain: string, id: string | null | undefined): string | null {
  const normalizedId = id?.trim();
  return normalizedId ? candidateUrl(`https://www.audible.${normalizeAudibleDomain(domain)}/pd/${encodeURIComponent(normalizedId)}`) : null;
}

/** Two listings of the same thing differ only in how they were reached, so the owner sees one row. */
function deduplicate(candidates: MonitoredReleaseDateCandidate[]): MonitoredReleaseDateCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}|${candidate.releaseDate}|${candidate.label ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * On-demand release date candidates for one format of one work. Every provider that can answer for
 * the format is asked at once and answers for itself: one that fails is reported as unasked rather
 * than left to read as "nothing lists this book", which is the one conclusion an empty list must
 * never carry.
 */
@Injectable()
export class MonitoredReleaseDateLookupService {
  private readonly logger = new Logger(MonitoredReleaseDateLookupService.name);
  private readonly cache = new Map<string, CachedLookup>();

  constructor(
    private readonly hardcover: HardcoverClient,
    private readonly apple: AppleBooksClient,
    private readonly audible: AudibleCatalogClient,
    private readonly amazon: AmazonProductPageClient,
    private readonly providerConfigs: MonitoredProviderConfigService,
    private readonly registry: ProviderRegistry,
  ) {}

  lookup(target: ReleaseDateLookupTarget): Promise<MonitoredReleaseDateLookup> {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    const key = this.cacheKey(target.userId, target.workId, target.format);
    const cached = this.cache.get(key);
    if (cached) return cached.promise;

    while (this.cache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    const promise = this.performLookup(target);
    this.cache.set(key, { promise, expiresAt: now + LOOKUP_CACHE_TTL_MS });
    void promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
    });
    return promise;
  }

  private async performLookup(target: ReleaseDateLookupTarget): Promise<MonitoredReleaseDateLookup> {
    const startedAt = Date.now();
    this.logger.log(
      `[monitored.release_dates.lookup] [start] workId="${sanitizeLogValue(target.workId)}" userId=${target.userId} format=${target.format} - release date lookup started`,
    );
    try {
      const signal = AbortSignal.timeout(LOOKUP_DEADLINE_MS);
      const config = await this.providerConfigs.forUser(target.userId);
      const hardcoverResult = target.hardcoverSlug
        ? isHardcoverConfigured(config)
          ? [this.ask('hardcover_edition', target, () => this.hardcoverCandidates(target, config, signal))]
          : [unavailable('hardcover_edition', 'not_configured')]
        : [];
      const results = await Promise.all([
        ...hardcoverResult,
        ...(target.format === 'ebook'
          ? [this.ask('apple', target, () => this.appleCandidates(target, config, signal))]
          : this.audiobookAsks(target, config, signal)),
        config.amazon.enabled
          ? this.ask('amazon', target, () => this.amazonCandidates(target, config, signal))
          : unavailable('amazon', 'not_configured'),
      ]);
      // A weak record is a placeholder somebody typed into a catalog, so it sits under every listing
      // that can actually be bought, and the earliest date leads within each of those groups.
      const candidates = deduplicate(results.flatMap((result) => result.candidates)).sort(
        (left, right) => Number(left.weak) - Number(right.weak) || left.releaseDate.localeCompare(right.releaseDate),
      );
      const missing = results.flatMap((result) => result.unavailable);
      const empty = results.flatMap((result) => result.empty);
      const throttled = missing.filter((entry) => entry.reason === 'throttled').map((entry) => entry.source);
      this.logger.log(
        `[monitored.release_dates.lookup] [end] workId="${sanitizeLogValue(target.workId)}" userId=${target.userId} format=${target.format} durationMs=${Date.now() - startedAt} candidates=${candidates.length} unavailable=${missing.length} empty=${empty.length} throttled=${throttled.length > 0 ? throttled.join(',') : 'none'} - release date lookup completed`,
      );
      return { format: target.format, candidates, unavailable: missing, empty };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[monitored.release_dates.lookup] [fail] workId="${sanitizeLogValue(target.workId)}" userId=${target.userId} format=${target.format} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - release date lookup failed`,
      );
      throw error;
    }
  }

  /** Audnexus is addressed by Audible ASIN, so it shares the one Audible search rather than running a second. */
  private audiobookAsks(
    target: ReleaseDateLookupTarget,
    config: ProviderConfigurations,
    signal: AbortSignal,
  ): Array<LookupResult | Promise<LookupResult>> {
    const audibleEnabled = isAudibleConfigured(config);
    const products =
      audibleEnabled || config.audnexus.enabled
        ? this.audible.searchProducts(`${target.title} ${target.authorName}`, config.audible.domain, signal)
        : undefined;
    if (products) void products.catch(() => undefined);
    const audnexus = config.audnexus.enabled ? this.registry.find(MetadataProviderKey.AUDNEXUS) : undefined;
    const librofm = config.librofm.enabled ? this.registry.find(MetadataProviderKey.LIBROFM) : undefined;
    return [
      audibleEnabled && products
        ? this.ask('audible', target, () => this.audibleCandidates(target, products, config.audible.domain))
        : unavailable('audible', 'not_configured'),
      audnexus && products
        ? this.ask('audnexus', target, () => this.audnexusCandidates(target, audnexus, products, config.audible.domain, signal))
        : unavailable('audnexus', 'not_configured'),
      librofm ? this.ask('librofm', target, () => this.libroFmCandidates(target, librofm, signal)) : unavailable('librofm', 'not_configured'),
    ];
  }

  private async ask(
    source: MonitoredReleaseLookupSource,
    target: ReleaseDateLookupTarget,
    produce: () => Promise<MonitoredReleaseDateCandidate[]>,
  ): Promise<LookupResult> {
    const startedAt = Date.now();
    try {
      const candidates = await produce();
      return candidates.length > 0 ? { candidates, unavailable: [], empty: [] } : { candidates: [], unavailable: [], empty: [source] };
    } catch (error) {
      // A client that is already paused throws before it can log a line of its own, so hours of
      // silence from one provider would otherwise name nothing anywhere.
      const throttled = error instanceof ProviderThrottleError;
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[monitored.release_dates.lookup] [fail] workId="${sanitizeLogValue(target.workId)}" userId=${target.userId} format=${target.format} source=${source} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - release date lookup provider ${throttled ? 'throttled' : 'failed'}`,
      );
      return unavailable(source, throttled ? 'throttled' : 'failed');
    }
  }

  private async hardcoverCandidates(
    target: ReleaseDateLookupTarget,
    config: ProviderConfigurations,
    signal: AbortSignal,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    if (!target.hardcoverSlug) return [];
    const [raw] = await this.hardcover.fetchEditionsBySlugs([target.hardcoverSlug], config.hardcover.apiKey, signal, { surfaceFailures: true });
    // The slug was asked for by name, so a batch that answers without it is a provider failure, not
    // Hardcover saying it has no such book.
    if (!raw) throw new BadGatewayException('Hardcover returned no book for this work');
    const book = mapHardcoverProbeBook(raw);
    const today = new Date().toISOString().slice(0, 10);
    const url = candidateUrl(`https://hardcover.app/books/${encodeURIComponent(target.hardcoverSlug)}`);
    return editionsForFormat(target.format, book, dominantLanguage(book)).flatMap((edition) => {
      if (!edition.releaseDate || !FULL_DATE.test(edition.releaseDate)) return [];
      return [
        {
          source: 'hardcover_edition' as const,
          releaseDate: edition.releaseDate,
          precision: 'day' as const,
          // The probe slice carries no edition name, so the identifier is the only thing that tells
          // two editions of the same book apart.
          label: edition.asin ?? edition.isbn13 ?? edition.isbn10,
          weak: !isStrongEdition(edition, today),
          url,
        },
      ];
    });
  }

  private async appleCandidates(
    target: ReleaseDateLookupTarget,
    config: ProviderConfigurations,
    signal: AbortSignal,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    const country = appleCountryForAmazonDomain(config.amazon.domain);
    const results = await this.apple.searchEbookCandidates(target.title, target.authorName, country, signal);
    return results.map((result) => ({
      source: 'apple' as const,
      releaseDate: result.releaseDate,
      precision: 'day' as const,
      label: result.trackName,
      weak: false,
      url: candidateUrl(result.trackViewUrl),
    }));
  }

  private async audibleCandidates(
    target: ReleaseDateLookupTarget,
    productsPromise: Promise<AudibleCatalogProduct[]>,
    domain: string,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    const products = await productsPromise;
    return this.matchingAudibleProducts(target, products).flatMap((product) => {
      const title = product.title?.trim();
      const releaseDate = parsePublishedDateKey(product.release_date || product.issue_date);
      if (!title || !releaseDate) return [];
      return [
        {
          source: 'audible' as const,
          releaseDate,
          precision: 'day' as const,
          label: title,
          weak: false,
          url: audibleProductUrl(domain, product.asin),
        },
      ];
    });
  }

  private matchingAudibleProducts(target: ReleaseDateLookupTarget, products: AudibleCatalogProduct[]): AudibleCatalogProduct[] {
    return products.filter((product) => {
      const title = product.title?.trim();
      if (product.format_type?.trim().toLowerCase() === 'abridged' || !product.asin || !title || !titleTokensMatch(target.title, title)) return false;
      return (product.authors ?? []).some((author) => authorMatches(target.authorName, author.name));
    });
  }

  private async libroFmCandidates(
    target: ReleaseDateLookupTarget,
    provider: MetadataProvider,
    signal: AbortSignal,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    const candidates = await provider.search({ title: target.title, author: target.authorName, isAudiobook: true, signal });
    return this.mapMetadataCandidates(target, candidates, 'librofm', '');
  }

  private async audnexusCandidates(
    target: ReleaseDateLookupTarget,
    provider: MetadataProvider,
    audibleProductsPromise: Promise<AudibleCatalogProduct[]>,
    domain: string,
    signal: AbortSignal,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    const catalogAsin = target.audibleAsin?.trim();
    let products: AudibleCatalogProduct[];
    try {
      products = await audibleProductsPromise;
    } catch (error) {
      if (!catalogAsin) throw error;
      products = [];
    }
    const asins = [catalogAsin, ...this.matchingAudibleProducts(target, products).map((product) => product.asin.trim())]
      .filter((asin): asin is string => Boolean(asin))
      .filter((asin, index, values) => values.indexOf(asin) === index)
      .slice(0, 2);
    if (asins.length === 0) return [];
    const candidates: MetadataCandidate[] = [];
    for (const asin of asins) {
      candidates.push(
        ...(await provider.search({
          title: target.title,
          author: target.authorName,
          isAudiobook: true,
          existingProviderIds: { [MetadataProviderKey.AUDIBLE]: asin },
          signal,
        })),
      );
    }
    return this.mapMetadataCandidates(target, candidates, 'audnexus', domain, new Set(asins));
  }

  private mapMetadataCandidates(
    target: ReleaseDateLookupTarget,
    candidates: MetadataCandidate[],
    source: 'audnexus' | 'librofm',
    audibleDomain: string,
    requestedAsins?: ReadonlySet<string>,
  ): MonitoredReleaseDateCandidate[] {
    return candidates.flatMap((candidate) => {
      const title = candidate.title;
      const releaseDate = candidate.publishedDate;
      const precision = releaseDate ? publishedDatePrecision(releaseDate) : null;
      const authors = candidate.authors ?? [];
      const asinIdentifiedWithoutAuthors =
        source === 'audnexus' && authors.length === 0 && candidate.providerId != null && requestedAsins?.has(candidate.providerId) === true;
      if (
        candidate.abridged === true ||
        !title?.trim() ||
        !releaseDate ||
        !precision ||
        (!asinIdentifiedWithoutAuthors && !metadataCandidateMatches(target, candidate)) ||
        (asinIdentifiedWithoutAuthors && !titleTokensMatch(target.title, title))
      )
        return [];
      return [
        {
          source,
          releaseDate,
          precision,
          label: title,
          weak: false,
          url: source === 'librofm' ? candidateUrl(candidate.sourceUrl) : audibleProductUrl(audibleDomain, candidate.providerId),
        },
      ];
    });
  }

  private async amazonCandidates(
    target: ReleaseDateLookupTarget,
    config: ProviderConfigurations,
    signal: AbortSignal,
  ): Promise<MonitoredReleaseDateCandidate[]> {
    const budget = pageBudget(LOOKUP_AMAZON_PAGES);
    const found = await findAmazonFamily(
      this.amazon,
      {
        title: target.title,
        authorName: target.authorName,
        seeds: target.audibleAsin ? [target.audibleAsin] : [],
        amazon: config.amazon,
      },
      budget,
      signal,
    );
    if (found.outcome === 'unknown') throw new BadGatewayException('Amazon could not verify the work family');
    if (found.outcome === 'missing') return [];
    const swatch = found.page.formats.find((entry) => entry.format === target.format);
    if (!swatch) return [];
    let releaseDate = swatch.selected ? found.page.releaseDate : null;
    if (!swatch.selected && !releaseDate && swatch.asin && !budget.available()) {
      throw new BadGatewayException('Amazon page budget was spent before the format page could be checked');
    }
    if (!swatch.selected && !releaseDate && swatch.asin) {
      const linked = await fetchAmazonPage(this.amazon, swatch.asin, config.amazon, budget, signal);
      releaseDate = linked?.releaseDate ?? null;
    }
    if (!releaseDate) return [];
    const asin = swatch.asin ?? found.page.pageAsin;
    return [
      {
        source: 'amazon' as const,
        releaseDate,
        precision: 'day' as const,
        label: swatch.label || null,
        weak: false,
        url: asin ? candidateUrl(`${amazonOrigin(config.amazon.domain)}/dp/${encodeURIComponent(asin)}`) : null,
      },
    ];
  }

  private cacheKey(userId: number, workId: string, format: MonitoredFormat): string {
    return `${userId}|${workId}|${format}`;
  }
}
