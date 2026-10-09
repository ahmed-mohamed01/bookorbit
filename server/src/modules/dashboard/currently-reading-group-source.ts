export const CURRENTLY_READING_GROUP_SOURCE = Symbol('CURRENTLY_READING_GROUP_SOURCE');

export interface CurrentlyReadingGroupMembership {
  groupId: number;
  // The end of the reader's latest recorded session on this book, or null when none was recorded.
  lastActivityAt: Date | null;
}

export interface CurrentlyReadingGroupSource {
  // The books among these that belong to a group of linked editions, keyed by book id. Books that stand alone are absent.
  findGroupsForBooks(userId: number, bookIds: number[]): Promise<Map<number, CurrentlyReadingGroupMembership>>;
}
