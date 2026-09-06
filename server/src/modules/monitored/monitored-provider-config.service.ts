import { Injectable } from '@nestjs/common';
import type { ProviderConfigurations } from '@bookorbit/types';

import { HardcoverSettingsService } from '../hardcover/hardcover-settings.service';
import { ProviderConfigService } from '../metadata-preferences/provider-config.service';

@Injectable()
export class MonitoredProviderConfigService {
  constructor(
    private readonly providerConfig: ProviderConfigService,
    private readonly hardcoverSettings: HardcoverSettingsService,
  ) {}

  // The user's own Hardcover token outranks the instance key: each user's catalog traffic then
  // counts against their own Hardcover rate limit, and no administrator setup is needed.
  async forUser(userId: number): Promise<ProviderConfigurations> {
    const [config, userToken] = await Promise.all([this.providerConfig.getConfig(), this.hardcoverSettings.getTokenForUser(userId)]);
    return userToken ? { ...config, hardcover: { enabled: true, apiKey: userToken } } : config;
  }
}
