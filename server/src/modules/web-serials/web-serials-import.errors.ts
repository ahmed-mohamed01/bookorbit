/** The Book Dock already holds this book; the unit counts as imported under the existing book. */
export class DuplicateBookError extends Error {
  constructor(readonly bookId: number) {
    super('This book is already in the library');
  }
}

/** A failure while filing the downloaded file locally, as opposed to fetching it from the engine. */
export class ImportStageError extends Error {
  constructor(
    message: string,
    readonly original: unknown,
  ) {
    super(message);
  }
}
