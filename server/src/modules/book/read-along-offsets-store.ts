import type { ReadAlongNarrationMismatch, ReadAlongOffsetsSource } from '@bookorbit/types';

export const READ_ALONG_OFFSETS_STORE = Symbol('READ_ALONG_OFFSETS_STORE');

/** Where one narration file of a read-along starts on its audiobook's clock. */
export type NarrationFileOffset = { audioHref: string; startSeconds: number; durationSeconds: number };

export type NarrationSignatureEntry = { audioHref: string; durationSeconds: number };

export type AudioSignatureEntry = { fileId: number; durationSeconds: number };

export type ReadAlongOffsetsStatus = 'ready' | 'mismatch';

export interface ReadAlongOffsetsRecord {
  readAlongFileId: number;
  audioBookId: number;
  narrationSignature: NarrationSignatureEntry[];
  audioSignature: AudioSignatureEntry[];
  status: ReadAlongOffsetsStatus;
  source: ReadAlongOffsetsSource;
  offsets: NarrationFileOffset[] | null;
  mismatch: ReadAlongNarrationMismatch | null;
}

export interface ReadAlongOffsetsStore {
  find(readAlongFileId: number, audioBookId: number): Promise<ReadAlongOffsetsRecord | null>;
  save(record: ReadAlongOffsetsRecord): Promise<void>;
  delete(readAlongFileId: number, audioBookId: number): Promise<void>;
}
