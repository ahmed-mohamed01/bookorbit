import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfigurations } from '@bookorbit/types';

import { HardcoverAuthorGoneError, HardcoverRequestError } from '../../metadata-fetch/providers/hardcover/hardcover.errors';
import { HardcoverBibliographyProvider, isHardcoverConfigured } from './hardcover-bibliography.provider';

describe('isHardcoverConfigured', () => {
  it('returns true when Hardcover is enabled with an API key', () => {
    const config = { hardcover: { enabled: true, apiKey: 'key' } } as ProviderConfigurations;

    expect(isHardcoverConfigured(config)).toBe(true);
  });

  it('returns false when Hardcover is enabled with an empty API key', () => {
    const config = { hardcover: { enabled: true, apiKey: '' } } as ProviderConfigurations;

    expect(isHardcoverConfigured(config)).toBe(false);
  });

  it('returns false when Hardcover is disabled with an API key', () => {
    const config = { hardcover: { enabled: false, apiKey: 'key' } } as ProviderConfigurations;

    expect(isHardcoverConfigured(config)).toBe(false);
  });
});

// The catalog guards decide from this provider's outcome whether to overwrite a stored catalog, so
// they need an outage to be distinguishable from an author who genuinely has no book.
describe('HardcoverBibliographyProvider failure reporting', () => {
  const config = { hardcover: { enabled: true, apiKey: 'key' } } as ProviderConfigurations;
  const authorRef = { id: '685771', name: 'Alexander Olson', bookCount: null, imageUrl: null };

  it('asks the client to surface a failed author search rather than answer it with no hit', async () => {
    const searchAuthors = vi.fn().mockRejectedValue(new HardcoverRequestError('author-search', 503));
    const provider = new HardcoverBibliographyProvider({ searchAuthors } as never);

    await expect(provider.resolveAuthor('Alexander Olson', config)).rejects.toBeInstanceOf(HardcoverRequestError);
    expect(searchAuthors).toHaveBeenCalledWith('Alexander Olson', 'key', undefined, { surfaceFailures: true });
  });

  it('still reports an author nobody matched as no author, not as a failure', async () => {
    const searchAuthors = vi.fn().mockResolvedValue([{ id: 1, name: 'Someone Else', books_count: 4 }]);
    const provider = new HardcoverBibliographyProvider({ searchAuthors } as never);

    await expect(provider.resolveAuthor('Alexander Olson', config)).resolves.toBeNull();
  });

  it('names a removed author record apart from an outage', async () => {
    const fetchAuthorContributions = vi.fn().mockResolvedValue(null);
    const provider = new HardcoverBibliographyProvider({ fetchAuthorContributions } as never);

    await expect(provider.fetchObservations(authorRef, config)).rejects.toBeInstanceOf(HardcoverAuthorGoneError);
    expect(fetchAuthorContributions).toHaveBeenCalledWith(685771, 0, 'key', undefined, { surfaceFailures: true });
  });
});
