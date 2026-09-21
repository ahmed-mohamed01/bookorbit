import { describe, expect, it, vi } from 'vitest';

import { fetchAmazonPage, findAmazonFamily, pageBudget, type AmazonFamilyQuery } from './amazon-family';

const AMAZON = { domain: 'amazon.com', cookie: 'cookie' };

function query(patch: Partial<AmazonFamilyQuery> = {}): AmazonFamilyQuery {
  return { title: 'The Infinite Extent', authorName: 'James S. A. Corey', seeds: ['B012345678'], amazon: AMAZON, ...patch };
}

function productPage(asin: string, title = 'The Infinite Extent', byline = 'James S. A. Corey') {
  const bylineMarkup = byline === '' ? '' : `<div id="bylineInfo">${byline}</div>`;
  return {
    html: `<input id="ASIN" value="${asin}"><span id="productTitle">${title}</span>${bylineMarkup}<div id="availability">Released on October 1, 2026.</div><ul id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Kindle</span></li></ul>`,
  };
}

function client(overrides: { fetchProductPage?: ReturnType<typeof vi.fn>; fetchSearchPage?: ReturnType<typeof vi.fn> } = {}) {
  return {
    fetchProductPage: overrides.fetchProductPage ?? vi.fn().mockResolvedValue({ notFound: true }),
    fetchSearchPage: overrides.fetchSearchPage ?? vi.fn().mockResolvedValue({ html: '<main>No matching books</main>' }),
  };
}

describe('findAmazonFamily', () => {
  it('stops at the first seed whose page matches the work', async () => {
    const amazon = client({ fetchProductPage: vi.fn().mockResolvedValue(productPage('B012345678')) });

    const result = await findAmazonFamily(amazon as never, query({ seeds: ['B012345678', 'B0SECOND01'] }), pageBudget(4));

    expect(result).toMatchObject({ outcome: 'found' });
    expect(amazon.fetchProductPage).toHaveBeenCalledOnce();
    expect(amazon.fetchSearchPage).not.toHaveBeenCalled();
  });

  it('walks past a missing seed and a seed page for a different book', async () => {
    const fetchProductPage = vi
      .fn()
      .mockResolvedValueOnce({ notFound: true })
      .mockResolvedValueOnce(productPage('B0SECOND01', 'A Different Book'))
      .mockResolvedValueOnce(productPage('B0THIRD001'));
    const amazon = client({ fetchProductPage });

    const result = await findAmazonFamily(amazon as never, query({ seeds: ['B0FIRST001', 'B0SECOND01', 'B0THIRD001'] }), pageBudget(4));

    expect(result).toMatchObject({ outcome: 'found', page: expect.objectContaining({ pageAsin: 'B0THIRD001' }) });
  });

  it('walks past a seed page with no byline instead of accepting it on the title alone', async () => {
    const fetchProductPage = vi
      .fn()
      .mockResolvedValueOnce(productPage('B0NOBYLINE', 'The Infinite Extent', ''))
      .mockResolvedValueOnce(productPage('B0SECOND01'));
    const amazon = client({ fetchProductPage });

    const result = await findAmazonFamily(amazon as never, query({ seeds: ['B0NOBYLINE', 'B0SECOND01'] }), pageBudget(4));

    expect(result).toMatchObject({ outcome: 'found', page: expect.objectContaining({ pageAsin: 'B0SECOND01' }) });
  });

  it('reports a search hit whose product page has no byline as unknown', async () => {
    const fetchSearchPage = vi.fn().mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });
    const fetchProductPage = vi.fn().mockResolvedValue(productPage('B0SEARCH01', 'The Infinite Extent', ''));
    const amazon = client({ fetchSearchPage, fetchProductPage });

    await expect(findAmazonFamily(amazon as never, query({ seeds: [] }), pageBudget(4))).resolves.toEqual({ outcome: 'unknown' });
  });

  it('reports a search that matched nothing as a missing listing', async () => {
    const amazon = client();

    await expect(findAmazonFamily(amazon as never, query({ seeds: [] }), pageBudget(4))).resolves.toEqual({ outcome: 'missing' });
    expect(amazon.fetchSearchPage).toHaveBeenCalledOnce();
  });

  it('reports a spent budget as unknown rather than as a missing listing', async () => {
    const amazon = client();

    await expect(findAmazonFamily(amazon as never, query(), pageBudget(0))).resolves.toEqual({ outcome: 'unknown' });
    expect(amazon.fetchProductPage).not.toHaveBeenCalled();
    expect(amazon.fetchSearchPage).not.toHaveBeenCalled();
  });

  it('verifies a search hit against its own product page', async () => {
    const fetchSearchPage = vi.fn().mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });
    const fetchProductPage = vi.fn().mockResolvedValue(productPage('B0SEARCH01'));
    const amazon = client({ fetchSearchPage, fetchProductPage });

    const result = await findAmazonFamily(amazon as never, query({ seeds: [] }), pageBudget(4));

    expect(result).toMatchObject({ outcome: 'found', page: expect.objectContaining({ pageAsin: 'B0SEARCH01' }) });
    expect(fetchProductPage).toHaveBeenCalledWith('B0SEARCH01', AMAZON, undefined);
  });

  it('reports a search hit that fails verification as unknown', async () => {
    const fetchSearchPage = vi.fn().mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });
    const fetchProductPage = vi.fn().mockResolvedValue(productPage('B0SEARCH01', 'A Different Book'));
    const amazon = client({ fetchSearchPage, fetchProductPage });

    await expect(findAmazonFamily(amazon as never, query({ seeds: [] }), pageBudget(4))).resolves.toEqual({ outcome: 'unknown' });
  });

  it('passes one signal through search and product page requests', async () => {
    const signal = AbortSignal.timeout(1_000);
    const fetchSearchPage = vi.fn().mockResolvedValue({
      html: `<div data-component-type="s-search-result" data-asin="B0SEARCH01"><div data-cy="title-recipe">The Infinite Extent | by James S. A. Corey</div><a href="/dp/B0SEARCH01">Kindle</a></div>`,
    });
    const fetchProductPage = vi.fn().mockResolvedValue(productPage('B0SEARCH01'));
    const amazon = client({ fetchSearchPage, fetchProductPage });

    await findAmazonFamily(amazon as never, query({ seeds: [] }), pageBudget(4), signal);

    expect(fetchSearchPage).toHaveBeenCalledWith('The Infinite Extent James S. A. Corey', AMAZON, signal);
    expect(fetchProductPage).toHaveBeenCalledWith('B0SEARCH01', AMAZON, signal);
  });
});

describe('pageBudget', () => {
  it('spends down to nothing and reports a missing page as no page', async () => {
    const budget = pageBudget(1);
    const amazon = client();

    await expect(fetchAmazonPage(amazon as never, 'B012345678', AMAZON, budget)).resolves.toBeNull();

    expect(budget.available()).toBe(false);
  });

  it('passes a caller signal to a product page request', async () => {
    const budget = pageBudget(1);
    const amazon = client();
    const signal = AbortSignal.timeout(1_000);

    await fetchAmazonPage(amazon as never, 'B012345678', AMAZON, budget, signal);

    expect(amazon.fetchProductPage).toHaveBeenCalledWith('B012345678', AMAZON, signal);
  });
});
