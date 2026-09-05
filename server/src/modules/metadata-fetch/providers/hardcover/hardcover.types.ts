export interface HardcoverSearchResponse {
  data?: {
    search?: {
      results?: HardcoverSearchResults;
    };
  };
}

export interface HardcoverSearchResults {
  hits?: HardcoverSearchHit[];
  found?: number;
}

export interface HardcoverSearchHit {
  document?: HardcoverSearchDocument;
}

export interface HardcoverSearchDocument {
  id: string;
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  author_names?: string[];
  contributions?: HardcoverCachedContributor[];
  isbns?: string[];
  pages?: number;
  release_date?: string;
  release_year?: number;
  genres?: string[];
  rating?: number;
  ratings_count?: number;
  featured_series?: {
    series?: {
      name?: string;
    };
    position?: number | null;
  };
  image?: HardcoverImage;
}

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
  book?: HardcoverContributionBook | null;
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
  image?: HardcoverImage | null;
  featured_book_series?: {
    position?: number | string | null;
    series?: {
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

export interface HardcoverBooksResponse {
  data?: {
    books?: HardcoverBookWithEditions[];
  };
}

export interface HardcoverBookWithEditions {
  id: number;
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  cached_contributors?: HardcoverCachedContributor[];
  featured_book_series?: {
    series?: {
      name?: string;
      books_count?: number;
    };
    position?: number | null;
  };
  rating?: number;
  ratings_count?: number;
  pages?: number;
  release_date?: string;
  release_year?: number;
  image?: HardcoverImage;
  editions?: HardcoverEdition[];
}

export interface HardcoverEdition {
  id: number;
  title?: string;
  subtitle?: string;
  cached_contributors?: HardcoverCachedContributor[];
  pages?: number;
  release_date?: string;
  release_year?: number;
  image?: HardcoverImage;
  publisher?: { name: string };
  isbn_10?: string;
  isbn_13?: string;
  language?: { code2: string };
  reading_format_id?: number;
  audio_seconds?: number;
}

export interface HardcoverCachedContributor {
  author?: {
    id?: number;
    name?: string;
  };
  contribution?: string | null;
}

export interface HardcoverImage {
  url?: string;
}
