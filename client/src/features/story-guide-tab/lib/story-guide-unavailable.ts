import { isAudioFormat, isComicFormat, isContentBookFile, type BookDetail } from '@bookorbit/types'

const STORY_GUIDE_FILE_FORMATS = new Set(['epub', 'kepub', 'mobi', 'azw3', 'azw'])

export type StoryGuideUnavailableKind = 'audio' | 'comic' | 'format' | 'none'

export interface StoryGuideUnavailable {
  kind: StoryGuideUnavailableKind
  formats: string[]
}

/** Why this book cannot have a story guide, or null when one of its files can carry one. */
export function storyGuideUnavailable(book: Pick<BookDetail, 'files'>): StoryGuideUnavailable | null {
  const formats = (book.files ?? []).filter(isContentBookFile).map((file) => file.format!.toLowerCase())
  if (formats.some((format) => STORY_GUIDE_FILE_FORMATS.has(format))) return null
  const unique = [...new Set(formats)]
  if (!unique.length) return { kind: 'none', formats: unique }
  if (unique.every(isAudioFormat)) return { kind: 'audio', formats: unique }
  if (unique.some(isComicFormat)) return { kind: 'comic', formats: unique }
  return { kind: 'format', formats: unique.filter((format) => !isAudioFormat(format)) }
}
