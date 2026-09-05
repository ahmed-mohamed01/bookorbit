import type { MonitoredDatePrecision, MonitoredWorkFlag, MonitoredWorkVerdict } from '@bookorbit/types';

export type ObservationSource = 'hardcover' | 'goodreads' | 'audible';
export type ObservationFormat = 'ebook' | 'audiobook' | 'unknown';
export type PopularityKind = 'users' | 'ratings';

export interface SeriesMembership {
  name: string;
  index: string | null;
}

export interface Observation {
  source: ObservationSource;
  id: string;
  canonicalId: string | null;
  title: string;
  subtitle: string | null;
  hasDesc: boolean;
  description: string | null;
  cover: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  precision: MonitoredDatePrecision | null;
  seriesName: string | null;
  seriesIndex: string | null;
  seriesMemberships: SeriesMembership[];
  popularity: number;
  popularityKind: PopularityKind;
  format: ObservationFormat;
  language: string | null;
  role: string | null;
  isbn10: string | null;
  isbn13: string | null;
  asin: string | null;
  raw: unknown;
}

export interface WorkCluster {
  observations: Observation[];
}

export interface MergedWork {
  title: string;
  subtitle: string | null;
  coreTitle: string;
  ebookReleaseDate: string | null;
  ebookDatePrecision: MonitoredDatePrecision | null;
  ebookDateSource: ObservationSource | 'consensus' | null;
  audioReleaseDate: string | null;
  audioDatePrecision: MonitoredDatePrecision | null;
  audioDateSource: ObservationSource | 'consensus' | null;
  releaseYear: number | null;
  seriesName: string | null;
  seriesIndex: string | null;
  seriesMemberships: SeriesMembership[];
  seriesSource: ObservationSource | null;
  cover: string | null;
  coverSource: ObservationSource | null;
  description: string | null;
  hasDesc: boolean;
  sources: ObservationSource[];
  providerWorkIds: Partial<Record<ObservationSource, string>>;
  popularity: Partial<Record<ObservationSource, number>>;
  unreleased: boolean;
  compilationFlag: boolean;
  allRolesNonAuthor: boolean;
  allForeign: boolean;
  observations: Observation[];
  verdict?: MonitoredWorkVerdict;
  flags?: MonitoredWorkFlag[];
}
