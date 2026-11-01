import { Injectable } from '@nestjs/common';

import { resolveEditionSyncDecision, resolveEditionSyncSettings } from './edition-sync-policy';
import { EditionSyncRepository } from './edition-sync.repository';

/**
 * Whisper only serves a book whose worker run failed, and only for a user whose edition sync
 * (permission, enabled, book scope) covers that book. Removed together with reading-alignment.
 */
@Injectable()
export class EditionSyncFallbackService {
  constructor(private readonly repo: EditionSyncRepository) {}

  async allowsWhisperFallback(userId: number, bookId: number): Promise<boolean> {
    const row = await this.repo.findIndexRow(bookId);
    if (row?.status !== 'failed') return false;

    if (!(await this.repo.userHasEditionSyncPermission(userId))) return false;
    const inputs = await this.repo.findResolverInputs(userId, bookId);
    const settings = resolveEditionSyncSettings({
      hasPermission: true,
      enabled: inputs.settings?.enabled ?? false,
      bookSyncMode: inputs.settings?.bookSyncMode ?? 'all_eligible',
    });
    if (!settings.effectiveEnabled) return false;

    const eligibility = await this.repo.findEligibility(bookId);
    if (eligibility?.eligible !== true) return false;
    return resolveEditionSyncDecision({ settings, eligible: true, override: inputs.override }).syncEnabled;
  }
}
