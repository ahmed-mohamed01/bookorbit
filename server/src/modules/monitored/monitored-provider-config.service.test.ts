import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfigurations } from '@bookorbit/types';

import { MonitoredProviderConfigService } from './monitored-provider-config.service';

function instanceConfig(hardcover: ProviderConfigurations['hardcover']): ProviderConfigurations {
  return { hardcover } as ProviderConfigurations;
}

describe('MonitoredProviderConfigService', () => {
  it('prefers the user token over an enabled instance key', async () => {
    const config = instanceConfig({ enabled: true, apiKey: 'instance-key' });
    const providerConfig = { getConfig: vi.fn().mockResolvedValue(config) };
    const hardcoverSettings = { getTokenForUser: vi.fn().mockResolvedValue('user-token') };
    const service = new MonitoredProviderConfigService(providerConfig as never, hardcoverSettings as never);

    await expect(service.forUser(42)).resolves.toEqual({ ...config, hardcover: { enabled: true, apiKey: 'user-token' } });
    expect(hardcoverSettings.getTokenForUser).toHaveBeenCalledWith(42);
  });

  it('returns the instance config untouched when the user token is null', async () => {
    const config = instanceConfig({ enabled: true, apiKey: 'instance-key' });
    const service = new MonitoredProviderConfigService(
      { getConfig: vi.fn().mockResolvedValue(config) } as never,
      { getTokenForUser: vi.fn().mockResolvedValue(null) } as never,
    );

    await expect(service.forUser(42)).resolves.toBe(config);
  });

  it('returns the disabled instance config untouched when the user token is null', async () => {
    const config = instanceConfig({ enabled: false, apiKey: '' });
    const service = new MonitoredProviderConfigService(
      { getConfig: vi.fn().mockResolvedValue(config) } as never,
      { getTokenForUser: vi.fn().mockResolvedValue(null) } as never,
    );

    await expect(service.forUser(42)).resolves.toBe(config);
  });
});
