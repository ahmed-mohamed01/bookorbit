import { describe, expect, it } from 'vitest';
import type { ProviderConfigurations } from '@bookorbit/types';

import { isHardcoverConfigured } from './hardcover-bibliography.provider';

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
