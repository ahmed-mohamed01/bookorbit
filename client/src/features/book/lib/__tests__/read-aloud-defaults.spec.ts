// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReadAloudCandidateFile, ReadAloudCapability } from '@bookorbit/types'
import { defaultReadAloudLanguage, defaultReadAloudRequest } from '../read-aloud-defaults'

function file(id: number, format: string): ReadAloudCandidateFile {
  return { id, filename: `${id}.${format}`, format, sizeBytes: 1024, durationSeconds: null }
}

const capability: Pick<ReadAloudCapability, 'epubFiles' | 'audioFiles' | 'supportedLanguages'> = {
  epubFiles: [file(4, 'epub'), file(5, 'epub')],
  audioFiles: [file(12, 'mp3'), file(10, 'mp3'), file(11, 'mp3')],
  supportedLanguages: ['de', 'en', 'fr'],
}

describe('defaultReadAloudLanguage', () => {
  it('takes the book language when the model supports it, from a tag or a name', () => {
    expect(defaultReadAloudLanguage(capability, 'en-GB', 'de')).toBe('en')
    expect(defaultReadAloudLanguage(capability, 'English', 'de')).toBe('en')
  })

  it('falls back to the saved default when the book language is unsupported or missing', () => {
    expect(defaultReadAloudLanguage(capability, 'nl', 'fr')).toBe('fr')
    expect(defaultReadAloudLanguage(capability, null, 'fr')).toBe('fr')
  })

  it('is null when neither is supported', () => {
    expect(defaultReadAloudLanguage(capability, 'nl', 'sv')).toBeNull()
    expect(defaultReadAloudLanguage(capability, null, null)).toBeNull()
  })
})

describe('defaultReadAloudRequest', () => {
  it('starts with the first EPUB, every track in book order and sentence granularity', () => {
    expect(defaultReadAloudRequest(capability, 'de', null)).toEqual({
      epubFileId: 4,
      audioFileIds: [12, 10, 11],
      language: 'de',
      granularity: 'sentence',
    })
  })

  it('never asks to replace a file', () => {
    expect(defaultReadAloudRequest(capability, 'de', null)).not.toHaveProperty('replaceFileId')
  })

  it('is null without a language, an EPUB or audio, so the dialog asks instead', () => {
    expect(defaultReadAloudRequest(capability, 'nl', null)).toBeNull()
    expect(defaultReadAloudRequest({ ...capability, epubFiles: [] }, 'de', null)).toBeNull()
    expect(defaultReadAloudRequest({ ...capability, audioFiles: [] }, 'de', null)).toBeNull()
  })
})
