import { getBookMediaProfile } from '@bookorbit/types';

type BookMediaFileRow = { format: string | null; role: string };

type AudiobookMetadataSignals = {
  durationSeconds?: number | null;
  audibleId?: string | null;
  librofmId?: string | null;
};

/**
 * Media type of the book itself, for flows that must ask a provider for the right edition.
 * Files are authoritative; the audio metadata signals only fill in when no file states a format.
 */
export function resolveIsAudiobook(files: readonly BookMediaFileRow[] | undefined, meta: AudiobookMetadataSignals | null | undefined): boolean {
  const primaryMediaKind = files?.length ? getBookMediaProfile(files).primaryMediaKind : 'unknown';
  if (primaryMediaKind !== 'unknown') return primaryMediaKind === 'audiobook';
  return meta?.durationSeconds != null || !!meta?.audibleId || !!meta?.librofmId;
}
