import { describe, expect, it } from 'vitest';
import { rankByRelevance, relevanceScore, spinOffPenalty } from './web-serials-ranking.utils';

describe('spinOffPenalty', () => {
  it.each([
    ['One Piece', 'one piece', 1],
    ['One Piece Party', 'one piece', 0.5],
    ['One Piece - Digital Colored Comics', 'one piece', 0.5],
    ['One Piece dj - Something', 'one piece', 0.5],
    ['What The ... - One Piece Dj', 'one piece', 0.5],
    ['One Piece [Doujinshi]', 'one piece', 0.5],
    ['One Piece Spin-off', 'one piece', 0.5],
    ['One Piece Spinoff', 'one piece', 0.5],
    ['One Piece One-Shot', 'one piece', 0.5],
    ['One Piece Side Story', 'one piece', 0.5],
    ['One Piece Party', 'one piece party', 1],
    ['One Piece Colored', 'one piece colored', 1],
    ['Partygoers', 'partygoers', 1],
    ['Adjacent', 'adjacent', 1],
  ])('%s for query %s is %s', (title, query, expected) => {
    expect(spinOffPenalty(title, query)).toBe(expected);
  });
});

describe('rankByRelevance', () => {
  const hit = (title: string, source = 's', kind: 'manga' | 'novel' = 'manga') => ({ title, source, kind });

  it('gives a relevance that ranks MangaBaka matches above every text-only hit when kinds are merged later', () => {
    const manga = rankByRelevance([hit('One Piece'), hit('One Piece Party')], 'one piece');
    const novels = rankByRelevance([hit('One Piece Novel: Ace', 's', 'novel')], 'one piece', {
      novel: [{ rank: 2, titles: ['One Piece Novel: Ace'] }],
    });
    const merged = [...manga, ...novels].sort((left, right) => right.relevance - left.relevance);
    expect(merged.map((h) => h.title)).toEqual(['One Piece Novel: Ace', 'One Piece', 'One Piece Party']);
    expect(manga[0]?.relevance).toBe(1);
  });

  it('orders exact over prefix over contains over fuzzy', () => {
    const ranked = rankByRelevance([hit('Totally Different'), hit('The One Piece Story'), hit('One Piece Story'), hit('One Piece')], 'one piece');
    expect(ranked.map((h) => h.title)).toEqual(['One Piece', 'One Piece Story', 'The One Piece Story', 'Totally Different']);
  });

  it('demotes spin-offs below the real series', () => {
    const ranked = rankByRelevance([hit('One Piece Party'), hit('One Piece - Digital Colored Comics'), hit('One Piece')], 'one piece');
    expect(ranked[0]?.title).toBe('One Piece');
    expect(relevanceScore('One Piece Party', 'one piece')).toBeCloseTo(0.425);
  });

  it('ranks MTL copies below non-MTL ones, flags them, and matches titles through edition tags', () => {
    const ranked = rankByRelevance(
      [hit('MTL-Omniscient Reader’s Viewpoint'), hit('Omniscient Reader’s Viewpoint (Web Novel KR)'), hit('Unrelated')],
      "omniscient reader's viewpoint",
    );
    expect(ranked.map((h) => h.title)).toEqual(['Omniscient Reader’s Viewpoint (Web Novel KR)', 'MTL-Omniscient Reader’s Viewpoint', 'Unrelated']);
    expect(ranked.map((h) => h.mtl)).toEqual([undefined, true, undefined]);
    expect(ranked[0]?.relevance).toBe(1);
  });

  it('ranks an MTL copy below its non-MTL twin inside the MangaBaka tier', () => {
    const ranked = rankByRelevance(
      [hit('Omniscient Reader (MTL)', 's', 'novel'), hit('Omniscient Reader (Web Novel)', 's', 'novel')],
      'omniscient reader',
      {
        novel: [{ rank: 1, titles: ['Omniscient Reader'] }],
      },
    );
    expect(ranked.map((h) => h.title)).toEqual(['Omniscient Reader (Web Novel)', 'Omniscient Reader (MTL)']);
    expect(ranked[0]?.relevance).toBeGreaterThan(99);
  });

  it('keeps original order for ties across sources and kinds', () => {
    const ranked = rankByRelevance([hit('Berserk', 'a'), hit('Berserk', 'b'), hit('Berserk', 'c')], 'berserk');
    expect(ranked.map((h) => h.source)).toEqual(['a', 'b', 'c']);
  });

  describe('MangaBaka tier', () => {
    const canonical = {
      manga: [
        { rank: 1, titles: ['One Piece', 'Wan Pisu'] },
        { rank: 2, titles: ['One Piece Magazine'] },
        { rank: 3, titles: ['One Piece Party'] },
      ],
    };

    it('lists matched hits first in MangaBaka order, even a demoted spin-off above a fuzzy hit', () => {
      const ranked = rankByRelevance([hit('One Pice'), hit('One Piece Party'), hit('wan pisu'), hit('One Piece')], 'one piece', canonical);
      expect(ranked.map((h) => h.title)).toEqual(['One Piece', 'wan pisu', 'One Piece Party', 'One Pice']);
    });

    it('keeps text score then source order among hits of the same entry', () => {
      const ranked = rankByRelevance([hit('Wan Pisu', 'b'), hit('One Piece', 'a'), hit('One Piece', 'c')], 'one piece', canonical);
      expect(ranked.map((h) => h.source)).toEqual(['a', 'c', 'b']);
    });

    it('only matches within the same kind', () => {
      const ranked = rankByRelevance(
        [hit('One Piece Magazine', 'n', 'novel'), hit('One Piece Magazine', 'm', 'manga')],
        'one piece magazine',
        canonical,
      );
      expect(ranked.map((h) => h.source)).toEqual(['m', 'n']);
    });

    it('ranks an unmatched exact title by text score when MangaBaka has no entry', () => {
      const ranked = rankByRelevance([hit('Other One Piece'), hit('One Piece Story'), hit('One Piece')], 'one piece', {});
      expect(ranked.map((h) => h.title)).toEqual(['One Piece', 'One Piece Story', 'Other One Piece']);
    });
  });
});
