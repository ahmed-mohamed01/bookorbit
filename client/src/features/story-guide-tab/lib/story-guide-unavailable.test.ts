import { describe, expect, it } from 'vitest'
import type { BookDetail } from '@bookorbit/types'
import { storyGuideUnavailable } from './story-guide-unavailable'

function book(...files: Array<[string | null, string?]>) {
  return { files: files.map(([format, role = 'content']) => ({ format, role })) } as BookDetail
}

describe('storyGuideUnavailable', () => {
  it('is null when any content file is a story guide format', () => {
    expect(storyGuideUnavailable(book(['EPUB', 'primary']))).toBeNull()
    expect(storyGuideUnavailable(book(['m4b'], ['azw3']))).toBeNull()
    expect(storyGuideUnavailable(book(['cbz'], ['kepub']))).toBeNull()
  })

  it('names audio when only audio files remain', () => {
    expect(storyGuideUnavailable(book(['m4b'], ['mp3'], ['epub', 'supplement']))).toEqual({ kind: 'audio', formats: ['m4b', 'mp3'] })
  })

  it('names comics before other formats', () => {
    expect(storyGuideUnavailable(book(['cbr'], ['pdf'], ['mp3']))?.kind).toBe('comic')
    expect(storyGuideUnavailable(book(['cb7']))?.kind).toBe('comic')
  })

  it('lists the other formats once, without audio', () => {
    expect(storyGuideUnavailable(book(['pdf'], ['PDF'], ['fb2'], ['m4b']))).toEqual({ kind: 'format', formats: ['pdf', 'fb2'] })
  })

  it('reports none without content files', () => {
    expect(storyGuideUnavailable(book())).toEqual({ kind: 'none', formats: [] })
    expect(storyGuideUnavailable({ files: undefined } as unknown as BookDetail)).toEqual({ kind: 'none', formats: [] })
    expect(storyGuideUnavailable(book(['jpg', 'cover'], [null]))).toEqual({ kind: 'none', formats: [] })
  })
})
