/**
 * Everything that reads Storyteller's JSON. The HTTP client speaks to the server; this file decides
 * what its answers mean, so a Storyteller release that renames a field is a change here and nowhere
 * else.
 *
 * Storyteller's book JSON is not a published contract: v1 spelled the alignment job
 * `processing_status`, current v2 carries a `readaloud` relation plus a `processingJob`, and both
 * have changed shape between releases. Every field is probed rather than assumed, and a shape this
 * does not recognize normalizes to `unknown` instead of reading as idle.
 */

import type { StorytellerBookSummary, StorytellerProcessingState, StorytellerProcessingStatus } from './storyteller-client.types';

const ALIGNED_FLAG_KEYS = ['aligned', 'isAligned', 'is_aligned', 'synced', 'hasReadaloud', 'has_readaloud', 'mediaOverlay', 'media_overlay'];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function readNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Comparable form for identifiers both servers spell differently (`978-0-553-29335-7` vs `9780553293357`). */
export function normalizeStorytellerIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

/** 0..1, whether Storyteller reported a fraction or a percentage. */
export function normalizeProgress(value: number | null): number | null {
  if (value === null || value < 0) return null;
  const fraction = value > 1 ? value / 100 : value;
  return fraction > 1 ? 1 : fraction;
}

function normalizeState(raw: string | null): StorytellerProcessingState {
  switch ((raw ?? '').toUpperCase()) {
    case 'COMPLETED':
    case 'COMPLETE':
    case 'DONE':
    case 'ALIGNED':
    case 'SUCCESS':
    case 'FINISHED':
      return 'completed';
    // `STOPPED` is Storyteller's halted-job state, not a job that has yet to start: a restart mid
    // alignment leaves the readaloud row there and drops the job row, and nothing on the server will
    // move it again. Reading it as idle keeps the build's wait polling to its ceiling while it holds
    // the single in-flight build slot, so it has to read as the terminal state it is.
    case 'ERROR':
    case 'IN_ERROR':
    case 'FAILED':
    case 'STOPPED':
    case 'CANCELED':
    case 'CANCELLED':
      return 'failed';
    case 'STARTED':
    case 'RUNNING':
    case 'PROCESSING':
    case 'QUEUED':
    case 'PAUSED':
    case 'PENDING':
    case 'IN_PROGRESS':
      return 'running';
    case 'CREATED':
    case 'IDLE':
    case 'NONE':
      return 'idle';
    default:
      return 'unknown';
  }
}

function normalizeProcessing(book: Record<string, unknown>): StorytellerProcessingStatus {
  const sources = [
    asRecord(book.processingStatus),
    asRecord(book.processing_status),
    asRecord(book.processing),
    asRecord(book.processingJob),
    asRecord(book.processing_job),
    asRecord(book.job),
    asRecord(book.readaloud),
  ].filter((source): source is Record<string, unknown> => source !== null);

  for (const source of sources.length > 0 ? sources : [book]) {
    const status = readProcessingStatus(source);
    if (status) return status;
  }
  return { state: 'unknown', task: null, progress: null, error: null };
}

/**
 * Whether the book already carries a read-along.
 *
 * The read-along relation's own status decides: Storyteller writes the row when it queues the work
 * and only moves it to `ALIGNED` when the file is finished, so a `filepath` on a `PROCESSING` or
 * `ERROR` row is a half-written artefact, not a result. A path is trusted only when there is no
 * status to read at all. A finished processing job is deliberately not enough on its own - the job
 * log says something ran, not that this book has a read-along.
 */
export function readAligned(book: Record<string, unknown>): boolean {
  for (const key of ALIGNED_FLAG_KEYS) {
    if (readBoolean(book, key) === true) return true;
  }

  const readaloud = asRecord(book.readaloud) ?? asRecord(book.readAloud) ?? asRecord(book.read_aloud);
  if (!readaloud) return false;

  const state = normalizeState(readString(readaloud, 'status', 'state'));
  if (state === 'completed') return true;
  if (state !== 'unknown') return false;
  return readString(readaloud, 'filepath', 'file_path', 'path') !== null;
}

/**
 * Whether Storyteller has a usable file behind one of a book's media links. A link exists in the
 * payload as soon as the candidate is scanned, so presence alone is not enough: it needs a filepath
 * and must not be flagged missing.
 */
function readMediaLinked(book: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const link = asRecord(book[key]);
    if (!link) continue;
    const filepath = readString(link, 'filepath', 'file_path', 'path');
    if (!filepath) continue;
    const missing = readBoolean(link, 'missing');
    const missingNumber = typeof link.missing === 'number' ? link.missing !== 0 : false;
    if (missing === true || missingNumber) continue;
    return true;
  }
  return false;
}

function readMediaPath(book: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const link = asRecord(book[key]);
    const filepath = link ? readString(link, 'filepath', 'file_path', 'path') : null;
    if (filepath) return filepath;
  }
  return null;
}

/**
 * Where Storyteller says the finished read-along lives, as Storyteller sees the path. Only a
 * completed read-along has a trustworthy path - a `PROCESSING` row's filepath is a half-written
 * artefact - so this mirrors readAligned's rule rather than reading the field unconditionally.
 */
function readReadaloudPath(book: Record<string, unknown>): string | null {
  const readaloud = asRecord(book.readaloud) ?? asRecord(book.readAloud) ?? asRecord(book.read_aloud);
  if (!readaloud) return null;
  const state = normalizeState(readString(readaloud, 'status', 'state'));
  if (state !== 'completed' && state !== 'unknown') return null;
  return readString(readaloud, 'filepath', 'file_path', 'path');
}

export function normalizeBook(raw: unknown): StorytellerBookSummary | null {
  const outer = asRecord(raw);
  if (!outer) return null;
  const book = asRecord(outer.book) ?? outer;

  const uuid = readString(book, 'uuid', 'bookUuid', 'book_uuid', 'id');
  if (!uuid) return null;

  return {
    uuid,
    title: readString(book, 'title', 'name') ?? '',
    authors: readAuthors(book),
    identifiers: readIdentifiers(book),
    aligned: readAligned(book),
    hasEbook: readMediaLinked(book, 'ebook'),
    hasAudiobook: readMediaLinked(book, 'audiobook', 'audio'),
    readaloudPath: readReadaloudPath(book),
    ebookPath: readMediaPath(book, 'ebook'),
    audiobookPath: readMediaPath(book, 'audiobook', 'audio'),
    processing: normalizeProcessing(book),
  };
}

export function readBookList(payload: unknown): StorytellerBookSummary[] {
  const record = asRecord(payload);
  const entries = Array.isArray(payload) ? payload : readArray(record?.books ?? record?.data ?? record?.items);
  return entries.map((entry) => normalizeBook(entry)).filter((book): book is StorytellerBookSummary => book !== null);
}

export function readCapabilityList(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!record) return [];
  const declared = record.capabilities;
  if (Array.isArray(declared)) return declared.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  const nested = asRecord(declared);
  if (nested) return Object.keys(nested).filter((key) => Boolean(nested[key]));
  return [];
}

/** The capabilities endpoint answers with a feature map rather than a list, so its keys are the features. */
export function readCapabilityKeys(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!record) return [];
  return Object.keys(record).filter((key) => Boolean(record[key]));
}

function readProcessingStatus(source: Record<string, unknown>): StorytellerProcessingStatus | null {
  const task = readString(source, 'currentTask', 'current_task', 'task', 'currentStage', 'current_stage', 'stage');
  const progress = normalizeProgress(readNumber(source, 'progress', 'stageProgress', 'stage_progress', 'percentComplete', 'percent_complete'));
  const error = readString(source, 'error', 'errorMessage', 'error_message');
  const inError = readBoolean(source, 'inError', 'in_error');
  const isProcessing = readBoolean(source, 'isProcessing', 'is_processing', 'processing');
  const rawState = readString(source, 'status', 'state');

  let state: StorytellerProcessingState;
  if (inError === true) state = 'failed';
  else {
    state = normalizeState(rawState);
    if (state === 'unknown') {
      if (isProcessing === true) state = 'running';
      else if (isProcessing === false) state = 'idle';
      else if (error !== null) state = 'failed';
    }
  }

  if (state === 'unknown' && task === null && progress === null && error === null) return null;
  return { state, task, progress, error };
}

function readAuthors(book: Record<string, unknown>): string[] {
  const names: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      names.push(value.trim());
      return;
    }
    const record = asRecord(value);
    const name = record ? readString(record, 'name', 'fileAs', 'file_as', 'author') : null;
    if (name) names.push(name);
  };

  for (const entry of readArray(book.authors)) push(entry);
  if (names.length === 0) {
    for (const entry of readArray(book.creators)) {
      const record = asRecord(entry);
      const role = record ? readString(record, 'role') : null;
      if (role !== null && role.toLowerCase() !== 'aut' && role.toLowerCase() !== 'author') continue;
      push(entry);
    }
  }
  if (names.length === 0) push(book.author);
  return [...new Set(names)];
}

function readIdentifiers(book: Record<string, unknown>): string[] {
  const values: string[] = [];
  const raw = book.identifiers;
  for (const entry of readArray(raw)) {
    const record = asRecord(entry);
    if (record) {
      const value = readString(record, 'value', 'identifier', 'id');
      if (value) values.push(value);
      continue;
    }
    if (typeof entry === 'string') values.push(entry);
  }
  const map = asRecord(raw);
  if (map) {
    for (const value of Object.values(map)) {
      if (typeof value === 'string') values.push(value);
    }
  }
  for (const key of ['isbn', 'isbn10', 'isbn13', 'asin', 'uid']) {
    const value = readString(book, key);
    if (value) values.push(value);
  }

  const normalized = values.map((value) => normalizeStorytellerIdentifier(value)).filter((value): value is string => value !== null);
  return [...new Set(normalized)];
}
