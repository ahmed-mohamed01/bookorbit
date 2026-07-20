export const EXTRA_COVER_SOURCE_HANDLERS = Symbol('EXTRA_COVER_SOURCE_HANDLERS');

export interface CoverSource {
  kind: string;
  absolutePath: string;
  format?: string;
}

export interface CoverSourceHandler {
  readonly kind: string;
  resolve(bookId: number, source: CoverSource): Promise<Buffer | null>;
}

export type CoverSourceApplyOutcome = 'saved' | 'locked' | 'failed';
