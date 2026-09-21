import * as cheerio from 'cheerio';

import { parsePublishedDateKey } from '../../../common/utils/published-date.utils';
import { parseBookPage } from '../../metadata-fetch/providers/amazon/amazon.scraper';

export type AmazonPageFormat = 'ebook' | 'audiobook' | 'print' | 'other';

export interface AmazonProductPage {
  pageAsin: string | null;
  title: string;
  byline: string;
  formats: Array<{ format: AmazonPageFormat; label: string; asin: string | null; selected: boolean }>;
  releaseDate: string | null;
  releaseDateSource: 'buybox' | 'bullet' | null;
  unavailable: boolean;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatFromLabel(label: string): AmazonPageFormat {
  if (/kindle/i.test(label)) return 'ebook';
  if (/audible|audiobook/i.test(label)) return 'audiobook';
  if (/audio cd/i.test(label)) return 'other';
  if (/paperback|mass market|hardcover/i.test(label)) return 'print';
  return 'other';
}

function asinFromHref(href: string | undefined): string | null {
  return /\/dp\/([A-Z0-9]{10})/i.exec(href ?? '')?.[1]?.toUpperCase() ?? null;
}

function directPublicationDate(html: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $('#detailBullets_feature_div li, #productDetails_detailBullets_sections1 tr').each((_, element) => {
    const text = collapseWhitespace($(element).text());
    if (!/publication date/i.test(text)) return;
    // Amazon separates the bullet label from its value with bidi marks, which \s does not match.
    const raw = text.replace(/^.*?publication date[‎‏\s]*:?[‎‏\s]*/i, '');
    found = parsePublishedDateKey(raw) ?? null;
    return false;
  });
  return found;
}

export function parseAmazonProductPage(html: string, requestedAsin: string): AmazonProductPage {
  const $ = cheerio.load(html);
  const domAsin = ($('#ASIN').attr('value') ?? requestedAsin).toUpperCase();
  const pageAsin = /^[A-Z0-9]{10}$/.test(domAsin) ? domAsin : null;
  const availability = collapseWhitespace($('#availability').text());
  const releasedOn = /released on\s+(.+?)(?:\.|$)/i.exec(availability)?.[1] ?? null;
  const buyboxDate = releasedOn ? (parsePublishedDateKey(releasedOn) ?? null) : null;

  $('#tmmSwatches script, #tmmSwatches style').remove();
  const formats: AmazonProductPage['formats'] = [];
  $('#tmmSwatches li.swatchElement').each((_, element) => {
    const item = $(element);
    const label = collapseWhitespace(item.find('.a-button-text').first().text() || item.text());
    const selected = item.hasClass('selected') || item.find('.a-button-selected').length > 0;
    const linkedAsin = asinFromHref(item.find('a[href*="/dp/"]').first().attr('href'));
    formats.push({ format: formatFromLabel(label), label, asin: selected ? pageAsin : linkedAsin, selected });
  });

  const bulletDate = parseBookPage(html).publishedDate ?? directPublicationDate(html);
  return {
    pageAsin,
    title: collapseWhitespace($('#productTitle').text()),
    byline: collapseWhitespace($('#bylineInfo').text()),
    formats,
    releaseDate: buyboxDate ?? bulletDate ?? null,
    releaseDateSource: buyboxDate ? 'buybox' : bulletDate ? 'bullet' : null,
    unavailable: /currently unavailable/i.test(availability),
  };
}

export function parseAmazonSearchResults(
  html: string,
  limit: number,
): Array<{
  asin: string;
  title: string;
  byline: string;
  sponsored: boolean;
  formatLinks: Array<{ format: AmazonPageFormat; asin: string }>;
}> {
  const $ = cheerio.load(html);
  const results: ReturnType<typeof parseAmazonSearchResults> = [];
  $('div[data-component-type="s-search-result"]').each((_, element) => {
    if (results.length >= limit) return false;
    const card = $(element);
    const asin = (card.attr('data-asin') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return;
    const title = collapseWhitespace(card.find('[data-cy="title-recipe"]').first().text() || card.find('h2').first().text());
    const byline = collapseWhitespace(
      card.find('.a-row.a-size-base.a-color-secondary').first().text() || card.find('.a-color-secondary').first().text(),
    );
    const formatLinks: Array<{ format: AmazonPageFormat; asin: string }> = [];
    card.find('a[href*="/dp/"]').each((__, link) => {
      const linkAsin = asinFromHref($(link).attr('href'));
      if (!linkAsin) return;
      const format = formatFromLabel(collapseWhitespace($(link).text()));
      if (formatLinks.some((candidate) => candidate.asin === linkAsin && candidate.format === format)) return;
      formatLinks.push({ format, asin: linkAsin });
    });
    results.push({ asin, title, byline, sponsored: title.toLowerCase().startsWith('sponsored'), formatLinks });
  });
  return results;
}
