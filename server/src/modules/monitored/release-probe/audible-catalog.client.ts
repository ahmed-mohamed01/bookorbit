import { BadGatewayException, Injectable } from '@nestjs/common';

import { audibleApiOrigin } from '../../../common/utils/metadata-provider-hosts.utils';
import { fetchWithThrottle } from '../../metadata-fetch/fetch-with-throttle';
import type { AudibleProduct, AudibleSearchResponse } from '../../metadata-fetch/providers/audible/audible.types';
import { normalizeAudibleDomain } from '../../metadata-fetch/providers/audible/normalize-audible-domain';
import { PROVIDER_TIMEOUT_MS } from '../../metadata-fetch/providers/provider-constants';
import { buildRequestSignal } from '../../metadata-fetch/providers/provider-utils';

const KEYWORD_RESULTS = 10;

/** Audible dates a pre-order under issue_date and a released title under release_date. */
export type AudibleCatalogProduct = AudibleProduct & { issue_date?: string };

@Injectable()
export class AudibleCatalogClient {
  /** A keyword search of the public catalog, which is one page and never paginates. */
  async searchProducts(keywords: string, domain: string, signal?: AbortSignal): Promise<AudibleCatalogProduct[]> {
    const url = new URL('/1.0/catalog/products', audibleApiOrigin(normalizeAudibleDomain(domain)));
    url.searchParams.set('keywords', keywords);
    url.searchParams.set('num_results', String(KEYWORD_RESULTS));
    // Audible only returns a product's title with product_desc; without it every result fails the title match.
    url.searchParams.set('response_groups', 'product_attrs,product_desc,contributors');
    const response = await fetchWithThrottle(url.toString(), { signal: buildRequestSignal(PROVIDER_TIMEOUT_MS.SCRAPE, signal) });
    if (!response.ok) throw new BadGatewayException(`Audible catalog returned HTTP ${response.status}`);
    return ((await response.json()) as AudibleSearchResponse).products ?? [];
  }
}
