import { parseAmazonProductPage, parseAmazonSearchResults, type AmazonProductPage } from './amazon-format-family';
import type { AmazonProductPageClient } from './amazon-product-page.client';
import { authorMatches, titleTokensMatch } from './title-match';

const SEARCH_RESULTS_SCANNED = 12;

/** How many product pages the caller is still willing to pay for. */
export interface AmazonPageBudget {
  available(): boolean;
  spend(): void;
}

export interface AmazonFamilyQuery {
  title: string;
  authorName: string;
  /** ASINs and ISBN-10s tried in order before the search fallback runs. */
  seeds: string[];
  amazon: { domain: string; cookie: string };
}

/**
 * `missing` is the search having run and matched nothing, which is negative evidence; `unknown` is
 * the walk stopping on a spent budget or a page that failed verification, which proves nothing.
 */
export type AmazonFamilyResult = { outcome: 'found'; page: AmazonProductPage } | { outcome: 'missing' } | { outcome: 'unknown' };

export function pageBudget(pages: number): AmazonPageBudget {
  let left = pages;
  return {
    available: () => left > 0,
    spend: () => {
      left--;
    },
  };
}

export async function fetchAmazonPage(
  client: AmazonProductPageClient,
  asin: string,
  amazon: AmazonFamilyQuery['amazon'],
  budget: AmazonPageBudget,
  signal?: AbortSignal,
): Promise<AmazonProductPage | null> {
  budget.spend();
  const response = await client.fetchProductPage(asin, amazon, signal);
  if ('notFound' in response) return null;
  return parseAmazonProductPage(response.html, asin);
}

/**
 * A page with no byline is not verified: a renamed byline element, or a stale identifier pointing at
 * another author's book of the same name, would otherwise become confirmed evidence on the title alone.
 */
export function amazonPageMatches(query: Pick<AmazonFamilyQuery, 'title' | 'authorName'>, page: AmazonProductPage): boolean {
  return titleTokensMatch(query.title, page.title) && authorMatches(query.authorName, page.byline);
}

/**
 * The swatch family a work belongs to: every known identifier is tried first, and only a work no
 * seed reached falls back to a title search, whose hit is still verified against the product page.
 */
export async function findAmazonFamily(
  client: AmazonProductPageClient,
  query: AmazonFamilyQuery,
  budget: AmazonPageBudget,
  signal?: AbortSignal,
): Promise<AmazonFamilyResult> {
  for (const seed of query.seeds) {
    if (!budget.available()) return { outcome: 'unknown' };
    const result = await fetchAmazonPage(client, seed, query.amazon, budget, signal);
    if (!result || !amazonPageMatches(query, result)) continue;
    return { outcome: 'found', page: result };
  }

  if (!budget.available()) return { outcome: 'unknown' };
  budget.spend();
  const search = await client.fetchSearchPage(`${query.title} ${query.authorName}`, query.amazon, signal);
  const match = parseAmazonSearchResults(search.html, SEARCH_RESULTS_SCANNED).find(
    (entry) => !entry.sponsored && titleTokensMatch(query.title, entry.title) && authorMatches(query.authorName, `${entry.title} ${entry.byline}`),
  );
  if (!match) return { outcome: 'missing' };
  if (!budget.available()) return { outcome: 'unknown' };
  const asin = match.formatLinks.find((link) => link.format === 'ebook')?.asin ?? match.asin;
  const page = await fetchAmazonPage(client, asin, query.amazon, budget, signal);
  if (!page || !amazonPageMatches(query, page)) return { outcome: 'unknown' };
  return { outcome: 'found', page };
}
