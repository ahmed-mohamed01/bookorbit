import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { EditionLinkSettings } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { editionLinkUserSettings } from './schema/work.schema';

type Db = NodePgDatabase<typeof schema>;

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 1000;

export const DEFAULT_EDITION_LINK_SETTINGS: EditionLinkSettings = Object.freeze({
  enabled: true,
  shareReadingState: true,
  sameTypeAsOneWork: true,
  positionSync: 'rough',
  autoLinkStrong: false,
});

/** Shared reading state applies only while the master switch and the sharing switch are both on. */
export function sharesReadingState(settings: EditionLinkSettings): boolean {
  return settings.enabled && settings.shareReadingState;
}

// Read on every progress and status write, so a short in-process cache sits in front of the row.
@Injectable()
export class EditionLinkSettingsService {
  private readonly cache = new Map<number, { value: EditionLinkSettings; at: number }>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async get(userId: number): Promise<EditionLinkSettings> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const [row] = await this.db.select().from(editionLinkUserSettings).where(eq(editionLinkUserSettings.userId, userId)).limit(1);
    const value: EditionLinkSettings = row
      ? {
          enabled: row.enabled,
          shareReadingState: row.shareReadingState,
          sameTypeAsOneWork: row.sameTypeAsOneWork,
          positionSync: row.positionSync,
          autoLinkStrong: row.autoLinkStrong,
        }
      : { ...DEFAULT_EDITION_LINK_SETTINGS };
    this.remember(userId, value);
    return value;
  }

  async update(userId: number, patch: Partial<EditionLinkSettings>): Promise<EditionLinkSettings> {
    const next = { ...(await this.get(userId)), ...patch };
    const now = new Date();
    await this.db
      .insert(editionLinkUserSettings)
      .values({ userId, ...next, updatedAt: now })
      .onConflictDoUpdate({ target: editionLinkUserSettings.userId, set: { ...next, updatedAt: now } });
    this.remember(userId, next);
    return next;
  }

  private remember(userId: number, value: EditionLinkSettings): void {
    this.cache.delete(userId);
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(userId, { value, at: Date.now() });
  }
}
