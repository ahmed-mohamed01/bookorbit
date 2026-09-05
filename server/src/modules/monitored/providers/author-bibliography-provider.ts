import type { ProviderConfigurations } from '@bookorbit/types';

import type { Observation, ObservationSource } from '../reconcile/observation.types';

export interface BibliographyAuthorRef {
  id: string;
  name: string;
  bookCount: number | null;
  imageUrl: string | null;
}

/**
 * Failure contract: `resolveAuthor` and `fetchObservations` THROW when a provider run errored, and
 * only ever return an empty result for a genuinely empty answer. A provider that swallowed its own
 * outage into `null`/`[]` reported success to the caller, which then treated a Hardcover outage as a
 * legitimately empty bibliography and overwrote a good catalog with nothing.
 */
export interface AuthorBibliographyProvider {
  readonly source: ObservationSource;
  readonly curated: boolean;
  isEnabled(config: ProviderConfigurations): boolean;
  resolveAuthor(name: string, existingId?: string, signal?: AbortSignal): Promise<BibliographyAuthorRef | null>;
  fetchObservations(authorRef: BibliographyAuthorRef, signal?: AbortSignal): Promise<Observation[]>;
  toObservations(rawRows: unknown[]): Observation[];
}

export function enabledBibliographyProviders(providers: AuthorBibliographyProvider[], config: ProviderConfigurations): AuthorBibliographyProvider[] {
  return providers.filter((provider) => provider.isEnabled(config));
}
