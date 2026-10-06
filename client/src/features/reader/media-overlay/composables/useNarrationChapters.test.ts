import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { chapterIndexForSection, registerNarrationChapters, useNarrationChapters } from './useNarrationChapters'
import { useMediaOverlay } from './useMediaOverlay'

vi.mock('./useMediaOverlay', async () => {
  const { ref } = await import('vue')
  const state = { currentFragment: ref<string | null>(null) }
  return { useMediaOverlay: () => state }
})

const TOC: TocItem[] = [
  { label: 'Cover', href: 'cover.xhtml' },
  { label: 'Prologue', href: 'p.xhtml' },
  {
    label: 'Part One',
    href: 'part1.xhtml',
    subitems: [
      { label: 'Chapter 1', href: 'c1.xhtml' },
      { label: 'Chapter 1 scene', href: 'c1.xhtml#s2' },
    ],
  },
  { label: 'Chapter 2', href: 'c2.xhtml' },
]
const SECTIONS: Record<string, number> = { 'cover.xhtml': 9, 'p.xhtml': 0, 'part1.xhtml': 1, 'c1.xhtml': 2, 'c2.xhtml': 4 }
const NARRATED = new Set([0, 1, 2, 4])

function resolveSectionIndex(href: string) {
  return SECTIONS[href.split('#')[0]!]
}

describe('chapterIndexForSection', () => {
  const chapters = [
    { label: 'A', sectionIndex: 0, depth: 0 },
    { label: 'B', sectionIndex: 2, depth: 0 },
    { label: 'B scene', sectionIndex: 2, depth: 1 },
    { label: 'C', sectionIndex: 5, depth: 0 },
  ]

  it('picks the latest chapter starting at or before the section', () => {
    expect(chapterIndexForSection(chapters, 3)).toBe(1)
    expect(chapterIndexForSection(chapters, 5)).toBe(3)
  })

  it('names a section by its first entry', () => {
    expect(chapterIndexForSection(chapters, 2)).toBe(1)
  })

  it('returns -1 before the first chapter or without a section', () => {
    expect(chapterIndexForSection(chapters.slice(1), 0)).toBe(-1)
    expect(chapterIndexForSection(chapters, null)).toBe(-1)
  })
})

describe('useNarrationChapters', () => {
  const playSection = vi.fn<(section: number) => void>()
  let unregister: () => void
  const scope = effectScope()

  beforeEach(() => {
    playSection.mockClear()
    useMediaOverlay().currentFragment.value = 'c1.xhtml#s5'
    unregister = registerNarrationChapters({ toc: ref(TOC), resolveSectionIndex, hasNarration: (section) => NARRATED.has(section), playSection })
  })

  afterEach(() => {
    unregister()
  })

  it('lists only narrated chapters and tracks the narrated one', () => {
    const chapters = scope.run(() => useNarrationChapters())!

    expect(chapters.chapters.value.map((c) => [c.label, c.depth])).toEqual([
      ['Prologue', 0],
      ['Part One', 0],
      ['Chapter 1', 1],
      ['Chapter 1 scene', 1],
      ['Chapter 2', 0],
    ])
    expect(chapters.currentChapter.value?.label).toBe('Chapter 1')
  })

  it('starts narration at the picked chapter', () => {
    const chapters = scope.run(() => useNarrationChapters())!

    chapters.playChapter(4)

    expect(playSection).toHaveBeenCalledWith(4)
  })

  it('lifts chapters of an unnarrated part to the parent level', () => {
    unregister()
    unregister = registerNarrationChapters({
      toc: ref(TOC),
      resolveSectionIndex,
      hasNarration: (section) => section !== 1 && NARRATED.has(section),
      playSection,
    })
    const chapters = scope.run(() => useNarrationChapters())!

    expect(chapters.chapters.value.map((c) => [c.label, c.depth])).toContainEqual(['Chapter 1', 0])
  })

  it('lists a chapter whose entry points at an unnarrated title page before its text', () => {
    unregister()
    const toc: TocItem[] = [
      { label: 'Chapter 4', href: 'c4.xhtml' },
      { label: 'Chapter 5', href: 'c5-title.xhtml' },
    ]
    const sections: Record<string, number> = { 'c4.xhtml': 9, 'c5-title.xhtml': 10, 'c5-text.xhtml': 11 }
    unregister = registerNarrationChapters({
      toc: ref(toc),
      resolveSectionIndex: (href) => sections[href.split('#')[0]!],
      hasNarration: (section) => section === 9 || section === 11,
      playSection,
    })
    const chapters = scope.run(() => useNarrationChapters())!

    expect(chapters.chapters.value.map((c) => c.label)).toEqual(['Chapter 4', 'Chapter 5'])
    useMediaOverlay().currentFragment.value = 'c5-text.xhtml#s3'
    expect(chapters.currentChapter.value?.label).toBe('Chapter 5')
    chapters.playChapter(1)
    expect(playSection).toHaveBeenCalledWith(10)
  })
})
