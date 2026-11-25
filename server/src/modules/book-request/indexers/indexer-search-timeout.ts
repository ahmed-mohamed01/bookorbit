import type { IndexerSettings } from '@bookorbit/types';

export const MIN_INDEXER_SEARCH_TIMEOUT_SECONDS = 5;
export const MAX_INDEXER_SEARCH_TIMEOUT_SECONDS = 180;

export function readIndexerSearchTimeoutSeconds(adapterType: string, settings: IndexerSettings | null): number | null {
  if (adapterType !== 'shelfmark') return null;
  const value = settings?.searchTimeoutSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_INDEXER_SEARCH_TIMEOUT_SECONDS, Math.max(MIN_INDEXER_SEARCH_TIMEOUT_SECONDS, Math.trunc(value)));
}

export function searchTimeoutSettingError(adapterType: string, settings: Record<string, unknown>): string | null {
  if (adapterType !== 'shelfmark') return null;
  const value = settings.searchTimeoutSeconds;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_INDEXER_SEARCH_TIMEOUT_SECONDS ||
    value > MAX_INDEXER_SEARCH_TIMEOUT_SECONDS
  ) {
    return `Search time limit must be ${MIN_INDEXER_SEARCH_TIMEOUT_SECONDS} to ${MAX_INDEXER_SEARCH_TIMEOUT_SECONDS} whole seconds`;
  }
  return null;
}
