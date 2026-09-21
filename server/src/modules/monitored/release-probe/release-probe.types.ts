import type { MonitoredDatePrecision, MonitoredFormat, MonitoredReleaseDateSource, MonitoredReleaseProbeStatus } from '@bookorbit/types';

export interface HardcoverProbeEdition {
  readingFormatId: number | null;
  releaseDate: string | null;
  asin: string | null;
  isbn13: string | null;
  isbn10: string | null;
  usersCount: number;
  languageCode: string | null;
}

export interface HardcoverProbeBook {
  slug: string;
  releaseDate: string | null;
  editions: HardcoverProbeEdition[];
}

export interface EditionEvidence {
  count: number;
  date: string | null;
  precision: MonitoredDatePrecision | null;
  strength: 'strong' | 'weak' | null;
  seeds: string[];
}

/**
 * A physical edition never earns a decision of its own - a hardback cannot be downloaded - but it
 * still gates the ebook audio-first rule and carries the identifiers the Amazon walk starts from.
 */
export interface PhysicalEditionEvidence {
  count: number;
  seeds: string[];
}

export interface HardcoverEvidence {
  ebook: EditionEvidence;
  audiobook: EditionEvidence;
  physical: PhysicalEditionEvidence;
}

export type AmazonEvidence =
  | { listing: 'none' }
  | {
      listing: 'found';
      formats: Partial<Record<MonitoredFormat, { asin: string | null; date: string | null }>>;
    };

export interface ProbeDecisionInput {
  format: MonitoredFormat;
  owned: boolean;
  inherited: { date: string | null; precision: MonitoredDatePrecision | null };
  audible: { date: string; precision: MonitoredDatePrecision | null } | null;
  hardcover: HardcoverEvidence | null;
  apple: { releaseDate: string } | null | undefined;
  amazon: AmazonEvidence | undefined;
}

export interface ProbeDecision {
  status: MonitoredReleaseProbeStatus;
  releaseDate: string | null;
  precision: MonitoredDatePrecision | null;
  source: MonitoredReleaseDateSource | null;
  asin: string | null;
  overlay: 'set' | 'clear' | 'none';
}

/** What the automatic check would have dated a format, kept aside while the owner's own date stands. */
export interface ProbeSuggestion {
  releaseDate: string;
  precision: MonitoredDatePrecision | null;
  source: MonitoredReleaseDateSource | null;
}

export interface ProbeRowSnapshot {
  status: MonitoredReleaseProbeStatus;
  releaseDate: string | null;
  source: MonitoredReleaseDateSource | null;
  autoReleaseDate: string | null;
}

export type ProbeSnapshot = Record<MonitoredFormat, ProbeRowSnapshot | null>;
