import { languageSubtagOf, type CreateReadAloudJobRequest, type ReadAloudCapability } from '@bookorbit/types'

type DefaultsCapability = Pick<ReadAloudCapability, 'epubFiles' | 'audioFiles' | 'supportedLanguages'>

/**
 * The language upstream's dialog preselects for a fresh job: the book's own language, then the
 * reader's saved default, whichever the speech model supports first.
 */
export function defaultReadAloudLanguage(
  capability: Pick<ReadAloudCapability, 'supportedLanguages'>,
  bookLanguage: string | null,
  savedDefault: string | null,
): string | null {
  const supported = capability.supportedLanguages as readonly string[]
  const candidates = [languageSubtagOf(bookLanguage, capability.supportedLanguages), savedDefault]
  return candidates.find((code): code is string => !!code && supported.includes(code)) ?? null
}

/** What upstream's dialog would start with no changes, or null when it would need the reader to pick something. */
export function defaultReadAloudRequest(
  capability: DefaultsCapability,
  bookLanguage: string | null,
  savedDefault: string | null,
): CreateReadAloudJobRequest | null {
  const epub = capability.epubFiles[0]
  const language = defaultReadAloudLanguage(capability, bookLanguage, savedDefault)
  if (!epub || capability.audioFiles.length === 0 || language === null) return null
  return {
    epubFileId: epub.id,
    audioFileIds: capability.audioFiles.map((file) => file.id),
    language,
    granularity: 'sentence',
  }
}
