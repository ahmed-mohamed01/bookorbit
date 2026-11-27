import { entityGroup, type EntityGroup, type EntityView, type StoryGuideView } from './story-guide-view'

/** One letter matches nearly every note, so the bar searches the story only from two. */
export const MIN_STORY_SEARCH = 2
export const ENTITY_GROUPS: readonly EntityGroup[] = ['people', 'places', 'terms']

type Chapter = StoryGuideView['chapters'][number]
type Note = Chapter['notes'][number]

export interface StorySearchChapter {
  s: number
  title: string
  start: number
  current: boolean
  notes: Note[]
}

export interface StorySearchSummary {
  s: number
  title: string
  start: number
  summaries: string[]
}

export interface StorySearch {
  names: EntityView[]
  namesByGroup: Record<EntityGroup, number>
  timeline: StorySearchChapter[]
  notes: number
  summaries: StorySearchSummary[]
}

export function storySearchPattern(query: string): RegExp | null {
  const needle = query.trim()
  if (!needle) return null
  return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
}

export function matchesName(entity: EntityView, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || entity.search.some((name) => name.includes(needle))
}

/** Names first, then the notes that say the words or tag a matching name, then the chapter summaries that say them. Locked chapters never match. */
export function searchStory(view: StoryGuideView, query: string, kinds: ReadonlySet<EntityGroup>): StorySearch | null {
  const pattern = query.trim().length >= MIN_STORY_SEARCH ? storySearchPattern(query) : null
  if (!pattern) return null
  const namesByGroup: Record<EntityGroup, number> = { people: 0, places: 0, terms: 0 }
  const names: EntityView[] = []
  for (const entity of view.entities) {
    if (!matchesName(entity, query)) continue
    const group = entityGroup(entity.kind)
    namesByGroup[group]++
    if (kinds.has(group)) names.push(entity)
  }
  const named = new Set(names)
  const timeline: StorySearchChapter[] = []
  const summaries: StorySearchSummary[] = []
  let notes = 0
  for (const chapter of view.chapters) {
    if (chapter.locked) continue
    const hits = chapter.notes.filter((note) => pattern.test(note.text) || [...note.entities].some((entity) => named.has(entity)))
    if (hits.length) {
      timeline.push({ s: chapter.s, title: chapter.title, start: chapter.start, current: chapter.current, notes: hits })
      notes += hits.length
    }
    const said = chapter.summaries.filter((text) => pattern.test(text))
    if (said.length) summaries.push({ s: chapter.s, title: chapter.title, start: chapter.start, summaries: said })
  }
  return { names, namesByGroup, timeline, notes, summaries }
}

/** Splits `text` around every case-insensitive match of `query`, for rendering marks without v-html. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const pattern = storySearchPattern(query)
  if (!pattern) return [{ text, hit: false }]
  const global = new RegExp(pattern.source, 'giu')
  const parts: { text: string; hit: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(global)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), hit: false })
    parts.push({ text: match[0], hit: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts
}
