import {
  STORY_GUIDE_TIE_GROUPS,
  storyGuideTieType,
  type ForkStoryGuideCut,
  type ForkStoryGuidePayload,
  type ForkStoryRecap,
  type StoryGuideAnchor,
  type StoryGuideChronicleTimelineEntry,
  type StoryGuideEntityKind,
  type StoryGuideJoin,
} from '@bookorbit/types'

export function anchorVisibility(cut: ForkStoryGuideCut | null) {
  const quotes = new Set(cut?.placedQuotes)
  return (anchor: StoryGuideAnchor) =>
    cut !== null && Number.isInteger(anchor.s) && anchor.s >= 0 && (anchor.s < cut.s || (anchor.s === cut.s && 'q' in anchor && quotes.has(anchor.q)))
}

function compareAnchors(a: StoryGuideAnchor, b: StoryGuideAnchor): number {
  if (a.s !== b.s) return a.s - b.s
  if ('o' in a && 'o' in b) return a.o - b.o
  return Number('end' in a) - Number('end' in b)
}

export type EntityGroup = 'people' | 'places' | 'terms'

export function entityGroup(kind: string): EntityGroup {
  if (kind === 'character') return 'people'
  if (kind === 'place') return 'places'
  return 'terms'
}

export interface EntityView {
  key: string
  name: string
  kind: StoryGuideEntityKind
  importance: 1 | 2 | 3
  mentions: number
  firstSeen: number
  aliases: { name: string; s: number }[]
  profiles: { text: string; s: number }[]
  /** Set for a character the reader last met at least LAST_SEEN_CHAPTERS chapters ago: shown in place of Now. */
  lastSeen: string | null
  search: string[]
}

type Entry = Pick<StoryGuideJoin, 'key' | 'name' | 'names' | 'lines' | 'profiles'>
type Visible = ReturnType<typeof anchorVisibility>
type CutEntity = EntityView & { firstAnchor: StoryGuideAnchor }

function firstName(entry: Entry) {
  return entry.names.reduce<(typeof entry.names)[number] | undefined>(
    (first, name) => (!first || compareAnchors(name.at, first.at) < 0 ? name : first),
    undefined,
  )
}

function entityView(entry: Entry, merged: StoryGuideJoin[], kind: StoryGuideEntityKind, visible: Visible): CutEntity | undefined {
  const first = firstName(entry)
  if (!first || !visible(first.at)) return
  const sources = [entry, ...merged]
  const names = sources
    .flatMap(({ names }) => names)
    .filter(({ at }) => visible(at))
    .sort((a, b) => compareAnchors(a.at, b.at))
  const name = names.some(({ text }) => text === entry.name) ? entry.name : (names[0]?.text ?? first.text)
  const aliases = new Map<string, number>()
  for (const alias of names) {
    if (alias.text !== name && !aliases.has(alias.text)) aliases.set(alias.text, alias.at.s)
  }
  const profiles = sources
    .flatMap((source) => {
      const profiles = source.profiles?.filter(({ through }) => visible(through)) ?? []
      return profiles.length ? profiles : source.lines.filter(({ through }) => visible(through))
    })
    .sort((a, b) => compareAnchors(b.through, a.through))

  return {
    key: entry.key,
    name,
    kind,
    importance: 2,
    mentions: 0,
    firstSeen: first.at.s,
    firstAnchor: first.at,
    aliases: Array.from(aliases, ([name, s]) => ({ name, s })),
    profiles: profiles.map(({ through, text }) => ({ s: through.s, text })),
    lastSeen: null,
    search: [name, ...aliases.keys()].map((name) => name.toLocaleLowerCase()),
  }
}

function visibleEntities(guide: ForkStoryGuidePayload, visible: Visible) {
  const byKey = new Map<string, CutEntity>()
  const resolved = new Map<string, EntityView>()
  for (const entity of guide.entities) {
    const first = firstName(entity)
    const shown = first && visible(first.at)
    const merged: StoryGuideJoin[] = []
    for (const join of entity.joins) {
      const early = guide.chronicle?.joins?.[join.key]
      if (shown && (visible(join.at) || (early && visible(early)))) {
        merged.push(join)
      } else {
        const view = entityView(join, [], entity.kind, visible)
        if (view) {
          byKey.set(view.key, view)
          resolved.set(view.key, view)
        }
      }
    }
    const view = entityView(entity, merged, entity.kind, visible)
    if (view) {
      byKey.set(view.key, view)
      resolved.set(view.key, view)
      for (const join of merged) resolved.set(join.key, view)
    }
  }
  return { byKey, resolved }
}

function addToIndex<K, T>(map: Map<K, T[]>, key: K, item: T) {
  const entries = map.get(key)
  if (entries) entries.push(item)
  else map.set(key, [item])
}

type EntityEntries = Map<EntityView, { entry: StoryGuideChronicleTimelineEntry; own: boolean }[]>

/** Every visible chronicle row, under the shown entity it resolves to (its own or a merged join's). */
function visibleEntries(chronicle: ForkStoryGuidePayload['chronicle'], resolved: Map<string, EntityView>, visible: Visible): EntityEntries {
  const entriesByEntity: EntityEntries = new Map()
  for (const [key, { timeline }] of Object.entries(chronicle?.entities ?? {})) {
    const entity = resolved.get(key)
    if (!entity) continue
    for (const entry of timeline) {
      if (visible(entry.through) && visible(entry.at)) addToIndex(entriesByEntity, entity, { entry, own: key === entity.key })
    }
  }
  return entriesByEntity
}

/** Chapters a character may go unseen before the sheet says "Last seen in" instead of "Now". */
export const LAST_SEEN_CHAPTERS = 10

const CHAPTER_NUMBER = /^\s*(?:chapter|ch\.?)\s*(\d+)(?:\s*[-–]\s*(\d+))?/i

function chapterNumber(label: string | null | undefined, endOfRange = false) {
  const match = label ? CHAPTER_NUMBER.exec(label) : null
  const number = (endOfRange ? match?.[2] : undefined) ?? match?.[1]
  return number === undefined ? null : Number(number)
}

function sectionTitles(guide: ForkStoryGuidePayload) {
  const titled = guide.sections
    .filter(({ title }) => title?.trim())
    .map(({ s, title }) => ({ s, title: title!.trim() }))
    .sort((a, b) => a.s - b.s)
  /** The title of section s, else the nearest titled section before it. */
  return (s: number) => {
    let found: string | null = null
    for (const section of titled) {
      if (section.s > s) break
      found = section.title
    }
    return found
  }
}

/**
 * The chapter label of the unit the reader is in, when the chronicle establishes one: the next unseen unit
 * end must lie at or after the reader's section, the last seen one before it, and an entry of that unit must
 * start at or before the reader's section, so a unit no entity has never borrows a later chapter's label.
 */
function readerUnitChapter(chronicle: ForkStoryGuidePayload['chronicle'], cut: ForkStoryGuideCut, visible: Visible) {
  const timelines = Object.values(chronicle?.entities ?? {}).map(({ timeline }) => timeline)
  let previous: StoryGuideAnchor | undefined
  let next: StoryGuideAnchor | undefined
  for (const timeline of timelines) {
    for (const { through } of timeline) {
      if (visible(through)) {
        if (!previous || compareAnchors(through, previous) > 0) previous = through
      } else if (!next || compareAnchors(through, next) < 0) next = through
    }
  }
  if (!next || next.s < cut.s || (previous && previous.s >= cut.s)) return null
  const end = next
  const unit = timelines.flatMap((timeline) => timeline.filter(({ through }) => compareAnchors(through, end) === 0))
  if (!unit.some(({ at }) => at.s <= cut.s)) return null
  return unit.find(({ chapter }) => chapter != null)?.chapter ?? null
}

function markLastSeen(guide: ForkStoryGuidePayload, cut: ForkStoryGuideCut | null, entriesByEntity: EntityEntries, visible: Visible) {
  if (!cut) return
  const titleOf = sectionTitles(guide)
  const readerChapter = chapterNumber(
    readerUnitChapter(guide.chronicle, cut, visible) ?? (guide.sections.some(({ s }) => s === cut.s) ? titleOf(cut.s) : null),
  )
  if (readerChapter === null) return
  for (const [entity, entries] of entriesByEntity) {
    if (entity.kind !== 'character') continue
    let latest: (typeof entries)[number] | undefined
    for (const candidate of entries) {
      const order = latest ? compareAnchors(candidate.entry.through, latest.entry.through) : 1
      if (order > 0 || (order === 0 && candidate.own && !latest!.own)) latest = candidate
    }
    if (!latest) continue
    const { chapter, through } = latest.entry
    const seen = chapterNumber(chapter ?? titleOf(through.s), true)
    if (seen === null || readerChapter - seen < LAST_SEEN_CHAPTERS) continue
    entity.lastSeen = chapter ? chapter.replace(/^Ch\s+/, 'Chapter ') : sectionChapter(titleOf(through.s), through.s)
  }
}

function sectionChapter(title: string | null, s: number) {
  if (!title) return `Chapter ${s + 1}`
  const number = CHAPTER_NUMBER.exec(title)?.[1]
  return number ? `Chapter ${number}` : title
}

function rankEntities(entriesByEntity: EntityEntries, entities: CutEntity[], tieCount: (key: string) => number) {
  const units = new Set<string>()
  for (const [entity, entries] of entriesByEntity) {
    entries.sort(
      (a, b) =>
        compareAnchors(a.entry.through, b.entry.through) ||
        Number(b.entry.note !== null) - Number(a.entry.note !== null) ||
        Number(b.own) - Number(a.own),
    )
    let previousEnd: StoryGuideAnchor | undefined
    let previousRow: string | undefined
    for (const {
      entry: { through, chapter },
    } of entries) {
      if (previousEnd && compareAnchors(previousEnd, through) === 0) continue
      previousEnd = through
      const row = chapter == null ? `s${through.s}` : `c${chapter}`
      if (row === previousRow) continue
      previousRow = row
      units.add(row)
      entity.mentions++
    }
  }
  if (units.size) {
    for (const entity of entities) {
      if (entity.mentions <= 1) entity.importance = 3
      else if (entity.mentions >= units.size * 0.25) entity.importance = 1
    }
  }

  return entities.sort(
    (a, b) =>
      a.importance - b.importance ||
      b.mentions - a.mentions ||
      tieCount(b.key) - tieCount(a.key) ||
      compareAnchors(a.firstAnchor, b.firstAnchor) ||
      a.name.localeCompare(b.name),
  )
}

/** The newest pair description the reader has reached, under the two raw keys in either order. */
function pairNote(guide: ForkStoryGuidePayload, a: string, b: string, visible: Visible): string | null {
  const pairs = guide.chronicle?.pairs
  const entries = pairs?.[`${a}|${b}`] ?? pairs?.[`${b}|${a}`] ?? []
  let newest: (typeof entries)[number] | undefined
  for (const entry of entries) if (visible(entry.through) && (!newest || compareAnchors(entry.through, newest.through) >= 0)) newest = entry
  return newest?.text ?? null
}

function visibleConnections(guide: ForkStoryGuidePayload, resolved: Map<string, EntityView>, visible: Visible) {
  const ties = guide.ties.flatMap((tie) => {
    const a = resolved.get(tie.a)
    const b = resolved.get(tie.b)
    if (!a || !b || a === b || !visible(tie.at)) return []
    const quotes = tie.quotes.filter(visible)
    if (!quotes.length) return []
    const note = pairNote(guide, tie.a, tie.b, visible)
    return [{ key: tie.key, a, b, label: tie.label, group: storyGuideTieType(tie.type)?.group, quotes, note }]
  })
  const links = (guide.links ?? []).flatMap((link) => {
    const a = resolved.get(link.a)
    const b = resolved.get(link.b)
    if (!a || !b || a === b || !visible(link.at) || (link.until && visible(link.until))) return []
    return [{ a, b, score: link.score }]
  })
  const tiesByKey = new Map<string, typeof ties>()
  const linksByKey = new Map<string, typeof links>()
  for (const tie of ties) {
    addToIndex(tiesByKey, tie.a.key, tie)
    addToIndex(tiesByKey, tie.b.key, tie)
  }
  for (const link of links) {
    addToIndex(linksByKey, link.a.key, link)
    addToIndex(linksByKey, link.b.key, link)
  }
  return { ties, links, tiesByKey, linksByKey }
}

/** The chronicle keeps notes per entity, so one event repeats once per entity: same quote anchor or same text is one note. */
function noteIds(s: number, at: StoryGuideAnchor, text: string): string[] {
  const ids = [JSON.stringify(['text', s, text])]
  if ('q' in at) ids.push(JSON.stringify(['at', at.s, at.o, at.q]))
  return ids
}

function visibleTimeline(guide: ForkStoryGuidePayload, resolved: Map<string, EntityView>, visible: Visible) {
  const notes: { at: StoryGuideAnchor; s: number; text: string; entities: Set<EntityView> }[] = []
  const byId = new Map<string, (typeof notes)[number]>()
  for (const [key, chapter] of Object.entries(guide.chronicle?.entities ?? {})) {
    const entity = resolved.get(key)
    if (!entity) continue
    for (const note of chapter.timeline) {
      if (!note.note || !visible(note.through) || !visible(note.at)) continue
      const text = note.note.trim().replace(/\s+/g, ' ')
      const ids = noteIds(note.through.s, note.at, text)
      let merged = ids.map((id) => byId.get(id)).find((existing) => existing !== undefined)
      if (!merged) {
        merged = { at: note.at, s: note.through.s, text, entities: new Set() }
        notes.push(merged)
      }
      merged.entities.add(entity)
      for (const id of ids) if (!byId.has(id)) byId.set(id, merged)
    }
  }
  return notes.sort((a, b) => a.s - b.s || compareAnchors(a.at, b.at))
}

type ChapterView = {
  s: number
  title: string
  start: number
  locked: boolean
  current: boolean
  summaries: string[]
  hidden: number
  notes: ReturnType<typeof visibleTimeline>
}

function groupChapters(guide: ForkStoryGuidePayload, cut: ForkStoryGuideCut | null, openingTitle: string) {
  const sections = [...guide.sections].sort((a, b) => a.s - b.s)
  const total = sections.reduce((sum, section) => sum + Math.max(section.chars, 1), 0)
  const chapters: ChapterView[] = []
  const chapterBySpine = new Map<number, ChapterView>()
  let before = 0
  let chapter: ChapterView | undefined
  let currentChapter: ChapterView | undefined
  for (const { s, title, chars } of sections) {
    const label = title?.trim()
    if (label || !chapter) {
      chapter = {
        s,
        title: label || openingTitle,
        start: (before / total) * 100,
        locked: !cut || s > cut.s,
        current: false,
        summaries: [],
        hidden: 0,
        notes: [],
      }
      chapters.push(chapter)
    }
    if (cut && s <= cut.s) currentChapter = chapter
    chapterBySpine.set(s, chapter)
    before += Math.max(chars, 1)
  }
  if (currentChapter) currentChapter.current = true
  return { chapters, chapterBySpine, currentChapter }
}

export function buildStoryGuideView(guide: ForkStoryGuidePayload, cut: ForkStoryGuideCut | null, openingTitle: string) {
  const visible = anchorVisibility(cut)
  const { byKey, resolved } = visibleEntities(guide, visible)
  const { ties, links, tiesByKey, linksByKey } = visibleConnections(guide, resolved, visible)
  const timeline = visibleTimeline(guide, resolved, visible)
  const { chapters, chapterBySpine, currentChapter } = groupChapters(guide, cut, openingTitle)
  const notesByKey = new Map<string, typeof timeline>()
  for (const note of timeline) {
    chapterBySpine.get(note.s)?.notes.push(note)
    for (const entity of note.entities) addToIndex(notesByKey, entity.key, note)
  }

  for (const { through, text } of guide.summaries ?? []) {
    const chapter = chapterBySpine.get(through.s)
    if (!chapter) continue
    if (visible(through)) chapter.summaries.push(text)
    else chapter.hidden++
  }
  const entriesByEntity = visibleEntries(guide.chronicle, resolved, visible)
  markLastSeen(guide, cut, entriesByEntity, visible)
  const entities = rankEntities(entriesByEntity, [...byKey.values()], (key) => tiesByKey.get(key)?.length ?? 0)
  const groups = { people: [], places: [], terms: [] } as Record<EntityGroup, EntityView[]>
  for (const entity of entities) groups[entityGroup(entity.kind)].push(entity)

  function details(key: string) {
    const ties = tiesByKey.get(key) ?? []
    const groups = [...STORY_GUIDE_TIE_GROUPS.map(({ group }) => group), undefined]
      .map((group) => ({
        group: group ?? 'other',
        ties: ties.filter((tie) => tie.group === group),
      }))
      .filter(({ ties }) => ties.length)
    const tied = new Set(ties.map(({ a, b }) => (a.key === key ? b : a)))
    const often = new Set<EntityView>()
    for (const link of [...(linksByKey.get(key) ?? [])].sort((a, b) => b.score - a.score)) {
      const other = link.a.key === key ? link.b : link.a
      if (!tied.has(other)) often.add(other)
      if (often.size === 6) break
    }
    return { groups, often, notes: notesByKey.get(key) ?? [] }
  }

  function chapterOf(s: number) {
    const exact = chapterBySpine.get(s)
    if (exact) return exact
    let found: ChapterView | undefined
    for (const chapter of chapters) if (chapter.s <= s) found = chapter
    return found
  }

  function chapterTitle(s: number) {
    return chapterOf(s)?.title ?? openingTitle
  }

  return { chapters, chapterBySpine, currentChapter, chapterOf, chapterTitle, timeline, entities, groups, byKey, ties, links, details }
}

export function previouslyByChapter(previously: ForkStoryRecap['previously'], view: StoryGuideView, openingTitle: string) {
  const groups = new Map<number, { s: number; title: string; start?: number; summaries: string[] }>()
  for (const item of previously) {
    const chapter = view.chapterOf(item.s)
    const key = chapter?.s ?? item.s
    const group = groups.get(key)
    if (group) group.summaries.push(item.text)
    else groups.set(key, { s: key, title: chapter?.title ?? (item.title?.trim() || openingTitle), start: chapter?.start, summaries: [item.text] })
  }
  return [...groups.values()].sort((a, b) => a.s - b.s)
}

export type StoryGuideView = ReturnType<typeof buildStoryGuideView>
