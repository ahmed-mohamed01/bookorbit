import { computed, shallowRef, type Ref } from 'vue'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { useMediaOverlay } from './useMediaOverlay'

export interface NarrationChapter {
  label: string
  sectionIndex: number
  depth: number
}

// Registered by the open reader: the narration player lives at the app root and has no
// other way to reach the book's table of contents or to restart narration elsewhere.
export interface NarrationChapterSource {
  toc: Readonly<Ref<TocItem[]>>
  resolveSectionIndex: (href: string) => number | null | undefined
  // Front matter such as the cover or copyright page has no narration; picking it would
  // silently start at the next narrated section.
  hasNarration: (sectionIndex: number) => boolean
  playSection: (sectionIndex: number) => void | Promise<void>
}

// The source cannot tell a missing section from an unnarrated one, so the last entry's text
// is looked for only this far past the highest section the TOC points at.
const TRAILING_SECTION_PROBE = 8

const source = shallowRef<NarrationChapterSource | null>(null)

export function registerNarrationChapters(next: NarrationChapterSource): () => void {
  source.value = next
  return () => {
    if (source.value === next) source.value = null
  }
}

interface ResolvedEntry {
  label: string
  sectionIndex: number | null
  subitems: ResolvedEntry[]
}

function resolve(items: TocItem[], current: NarrationChapterSource, starts: Set<number>): ResolvedEntry[] {
  return items.map((item) => {
    const index = current.resolveSectionIndex(item.href)
    const sectionIndex = typeof index === 'number' ? index : null
    if (sectionIndex !== null) starts.add(sectionIndex)
    return { label: item.label, sectionIndex, subitems: item.subitems?.length ? resolve(item.subitems, current, starts) : [] }
  })
}

// A chapter entry often points at an unnarrated title page while its text follows in the next
// section with no entry of its own, so an entry counts as narrated when any section up to the
// next entry's start has narration.
function narratedStarts(starts: Set<number>, current: NarrationChapterSource): Set<number> {
  const sorted = [...starts].sort((a, b) => a - b)
  const last = sorted[sorted.length - 1] ?? 0
  const narrated = new Set<number>()
  sorted.forEach((start, i) => {
    const end = sorted[i + 1] ?? last + 1 + TRAILING_SECTION_PROBE
    for (let section = start; section < end; section++) {
      if (current.hasNarration(section)) {
        narrated.add(start)
        return
      }
    }
  })
  return narrated
}

function flatten(entries: ResolvedEntry[], narrated: Set<number>, depth = 0, out: NarrationChapter[] = []) {
  for (const entry of entries) {
    const listed = entry.sectionIndex !== null && narrated.has(entry.sectionIndex)
    if (listed) out.push({ label: entry.label, sectionIndex: entry.sectionIndex!, depth })
    if (entry.subitems.length) flatten(entry.subitems, narrated, listed ? depth + 1 : depth, out)
  }
  return out
}

const chapters = computed<NarrationChapter[]>(() => {
  const current = source.value
  if (!current) return []
  const starts = new Set<number>()
  const entries = resolve(current.toc.value, current, starts)
  return flatten(entries, narratedStarts(starts, current))
})

// The chapter a section belongs to: the latest TOC entry starting at or before it. When a
// section holds several entries the first one names it, since the sentence position inside
// the section is not known.
export function chapterIndexForSection(list: NarrationChapter[], section: number | null): number {
  if (section === null) return -1
  let best = -1
  for (let i = 0; i < list.length; i++) {
    const start = list[i]!.sectionIndex
    if (start > section) continue
    if (best === -1 || start > list[best]!.sectionIndex) best = i
  }
  return best
}

export function useNarrationChapters() {
  const { currentFragment } = useMediaOverlay()

  const narratedSection = computed(() => {
    const fragment = currentFragment.value
    const resolved = fragment ? source.value?.resolveSectionIndex(fragment) : null
    return typeof resolved === 'number' ? resolved : null
  })

  const currentIndex = computed(() => chapterIndexForSection(chapters.value, narratedSection.value))
  const currentChapter = computed(() => chapters.value[currentIndex.value] ?? null)

  function playChapter(index: number) {
    const chapter = chapters.value[index]
    if (!chapter || !source.value) return
    void source.value.playSection(chapter.sectionIndex)
  }

  return { chapters, currentIndex, currentChapter, playChapter }
}
