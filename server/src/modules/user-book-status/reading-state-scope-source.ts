export const READING_STATE_SCOPE_SOURCE = Symbol('READING_STATE_SCOPE_SOURCE');

export interface ReadingStateScope {
  /** The book whose reading attempts and status stand for the whole group. */
  canonicalBookId: number;
  /** The other books of the group, whose status rows mirror the canonical book's. */
  mirrorBookIds: number[];
}

export interface ReadingStateScopeSource {
  // Null when the book keeps its own reading state.
  resolveScope(userId: number, bookId: number): Promise<ReadingStateScope | null>;
}
