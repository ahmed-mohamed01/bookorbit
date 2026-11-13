import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export const BOOK_DOCK_FILE_INGESTED = 'book-dock.file.ingested';
/**
 * Fork: a dock unit was filed into a library, with every one of its files in place. Carries the
 * ids of the books the unit created and gave audio to, never a book it only joined, so work that
 * waits for a new book's files to stop arriving can start.
 */
export const BOOK_DOCK_BOOKS_FILED = 'book-dock.books.filed';

@Injectable()
export class BookDockEventsService extends EventEmitter {}
