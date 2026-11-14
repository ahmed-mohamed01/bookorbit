import type { HardcoverImage, HardcoverCachedContributor, HardcoverSearchResults } from '../../metadata-fetch/providers/hardcover/hardcover.types';

export interface HardcoverAuthorSearchResponse {
  data?: {
    search?: {
      results?: HardcoverAuthorSearchResults;
    };
  };
}

export interface HardcoverAuthorSearchResults {
  hits?: HardcoverAuthorSearchHit[];
  found?: number;
}

export interface HardcoverAuthorSearchHit {
  document?: HardcoverAuthorSearchDocument;
}

export interface HardcoverAuthorSearchDocument {
  id: string | number;
  name: string;
  books_count?: number;
  image?: HardcoverImage;
  genres?: string[];
}

export interface HardcoverAuthorContributionsResponse {
  data?: {
    authors?: HardcoverAuthorWithContributions[];
  };
}

export interface HardcoverAuthorWithContributions {
  id: number;
  name: string;
  books_count?: number;
  contributions?: HardcoverAuthorContribution[];
}

export interface HardcoverAuthorContribution {
  contribution?: string | null;
  contributor_role_id?: number | null;
  book?: HardcoverContributionBook | null;
}

export interface HardcoverProbeEditionRow {
  reading_format_id: number | null;
  release_date: string | null;
  asin: string | null;
  isbn_13: string | null;
  isbn_10: string | null;
  users_count: number | null;
  language: { code2: string | null } | null;
}

export interface HardcoverEditionsProbeBook {
  slug: string;
  release_date: string | null;
  editions: HardcoverProbeEditionRow[];
}

/** One window per format, because a single users_count window drops brand-new editions of a heavily editioned book. */
export interface HardcoverEditionsProbeBookSlices {
  slug: string;
  release_date: string | null;
  ebook_editions?: HardcoverProbeEditionRow[] | null;
  audio_editions?: HardcoverProbeEditionRow[] | null;
  print_editions?: HardcoverProbeEditionRow[] | null;
}

export interface HardcoverEditionsBySlugsResponse {
  data?: { books?: HardcoverEditionsProbeBookSlices[] };
}

export interface HardcoverContributionBook {
  id: number;
  slug: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  canonical_id?: number | null;
  compilation?: boolean | null;
  release_date?: string | null;
  release_year?: number | null;
  pages?: number | null;
  users_count?: number | null;
  rating?: number | null;
  ratings_count?: number | null;
  book_status?: { id: number; name: string } | null;
  book_category_id?: number | null;
  users_read_count?: number | null;
  editions_count?: number | null;
  image?: HardcoverImage | null;
  featured_book_series?: {
    position?: number | string | null;
    series?: {
      id?: number;
      name?: string | null;
      books_count?: number | null;
    } | null;
  } | null;
  book_series?: Array<{
    position: number | null;
    series: {
      id?: number;
      name: string;
      books_count?: number | null;
    } | null;
  }> | null;
  cached_contributors?: HardcoverCachedContributor[];
  lang_editions?: Array<{
    language?: { code2?: string | null } | null;
  }> | null;
}

export interface HardcoverBookAndAuthorSearchResponse {
  data?: {
    books?: { results?: HardcoverSearchResults };
    authors?: { results?: HardcoverAuthorSearchResults };
  };
}
