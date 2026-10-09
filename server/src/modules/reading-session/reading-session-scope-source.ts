export const READING_SESSION_SCOPE_SOURCE = Symbol('READING_SESSION_SCOPE_SOURCE');

export type ReadingSessionScopeRole = 'text' | 'audio' | 'readAlong';

export interface ReadingSessionScopeMember {
  bookId: number;
  role: ReadingSessionScopeRole;
}

export interface ReadingSessionScopeSource {
  // Every book whose sessions belong in this book's reading log, the book itself included, or null when the book stands alone.
  resolveScope(bookId: number): Promise<ReadingSessionScopeMember[] | null>;
}
