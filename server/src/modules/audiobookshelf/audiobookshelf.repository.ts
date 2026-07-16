import { Inject, Injectable } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { AudiobookshelfUserSetting, NewAudiobookshelfUserSetting } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class AudiobookshelfRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findSettings(userId: number): Promise<AudiobookshelfUserSetting | undefined> {
    return this.db.query.audiobookshelfUserSettings.findFirst({
      where: eq(schema.audiobookshelfUserSettings.userId, userId),
    });
  }

  async upsertSettings(
    userId: number,
    data: Partial<Omit<AudiobookshelfUserSetting, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AudiobookshelfUserSetting> {
    const [row] = await this.db
      .insert(schema.audiobookshelfUserSettings)
      .values({ userId, ...data } as NewAudiobookshelfUserSetting)
      .onConflictDoUpdate({
        target: schema.audiobookshelfUserSettings.userId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async deleteSettings(userId: number): Promise<void> {
    await this.db.delete(schema.audiobookshelfUserSettings).where(eq(schema.audiobookshelfUserSettings.userId, userId));
  }

  async userHasAudiobookshelfSyncPermission(userId: number): Promise<boolean> {
    const [row] = await this.db
      .select({
        isSuperuser: schema.users.isSuperuser,
        permissionName: schema.userPermissions.permissionName,
      })
      .from(schema.users)
      .leftJoin(
        schema.userPermissions,
        and(eq(schema.userPermissions.userId, schema.users.id), eq(schema.userPermissions.permissionName, Permission.AudiobookshelfSync)),
      )
      .where(and(eq(schema.users.id, userId), eq(schema.users.active, true)))
      .limit(1);

    return row?.isSuperuser === true || row?.permissionName === Permission.AudiobookshelfSync;
  }
}
