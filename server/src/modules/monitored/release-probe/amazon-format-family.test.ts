import { describe, expect, it } from 'vitest';

import { parseAmazonProductPage, parseAmazonSearchResults } from './amazon-format-family';

describe('parseAmazonProductPage', () => {
  it('parses a selected Kindle swatch, print link and publication bullet', () => {
    const html = `<span id="productTitle">The Infinite Extent</span><div id="bylineInfo">Dennis E. Taylor</div>
      <div id="tmmSwatches"><ul>
        <li class="swatchElement selected"><span class="a-button-selected"><span class="a-button-text">Kindle Edition</span></span></li>
        <li class="swatchElement"><a href="/dp/1234567890"><span class="a-button-text">Paperback</span></a></li>
      </ul></div>
      <div id="detailBullets_feature_div"><li><span>Publication date : July 15, 2026</span></li></div>`;
    expect(parseAmazonProductPage(html, 'B0H8T5TBBS')).toMatchObject({
      pageAsin: 'B0H8T5TBBS',
      title: 'The Infinite Extent',
      releaseDate: '2026-07-15',
      releaseDateSource: 'bullet',
      formats: [
        { format: 'ebook', asin: 'B0H8T5TBBS', selected: true },
        { format: 'print', asin: '1234567890', selected: false },
      ],
    });
  });

  it('removes embedded Audible script text from a swatch label', () => {
    const html = `<div id="tmmSwatches"><li class="swatchElement selected"><span class="a-button-text">Audible Audiobook<script>bad label</script></span></li></div>`;
    expect(parseAmazonProductPage(html, 'B012345678').formats[0]).toMatchObject({
      format: 'audiobook',
      label: 'Audible Audiobook',
    });
  });

  it.each(['April 10, 2027', '10 April 2027'])('prefers a %s pre-order buybox release date to the bullet', (date) => {
    const html = `<div id="availability">This title will be released on ${date}. Pre-order now</div>
      <div id="detailBullets_feature_div"><li>Publication date : May 11, 2027</li></div>`;
    expect(parseAmazonProductPage(html, 'B012345678')).toMatchObject({ releaseDate: '2027-04-10', releaseDateSource: 'buybox' });
  });

  it('parses a detail bullet whose label and value are separated by bidi marks', () => {
    const html = `<div id="detailBullets_feature_div"><li><span class="a-text-bold">Publication date\u200f:\u200e</span><span>August 4, 2026</span></li></div>`;
    expect(parseAmazonProductPage(html, 'B012345678')).toMatchObject({ releaseDate: '2026-08-04', releaseDateSource: 'bullet' });
  });

  it('returns no formats when the swatch family is absent', () => {
    expect(parseAmazonProductPage('<span id="productTitle">Book</span>', 'B012345678').formats).toEqual([]);
  });

  it('recognizes a currently unavailable listing', () => {
    expect(parseAmazonProductPage('<div id="availability">Currently unavailable.</div>', 'B012345678').unavailable).toBe(true);
  });
});

describe('parseAmazonSearchResults', () => {
  it('parses sponsored and organic cards with format links', () => {
    const html = `<div data-component-type="s-search-result" data-asin="B012345678">
        <h2>Sponsored The Wrong Book</h2><span class="a-color-secondary">Some Author</span>
        <a href="/dp/B012345678">Kindle</a>
      </div>
      <div data-component-type="s-search-result" data-asin="B087654321">
        <div data-cy="title-recipe">The Right Book</div><span class="a-color-secondary">Right Author</span>
        <a href="/dp/B087654321">Audible Audiobook</a><a href="/dp/1234567890">Hardcover</a>
      </div>`;
    expect(parseAmazonSearchResults(html, 8)).toEqual([
      {
        asin: 'B012345678',
        title: 'Sponsored The Wrong Book',
        byline: 'Some Author',
        sponsored: true,
        formatLinks: [{ format: 'ebook', asin: 'B012345678' }],
      },
      {
        asin: 'B087654321',
        title: 'The Right Book',
        byline: 'Right Author',
        sponsored: false,
        formatLinks: [
          { format: 'audiobook', asin: 'B087654321' },
          { format: 'print', asin: '1234567890' },
        ],
      },
    ]);
  });
});
