import type { EpubMediaOverlayPlaylist, EpubMediaOverlayTextPositions } from '@bookorbit/types'

/**
 * Fork: read along in a plain EPUB from the book's edition sync timing index.
 *
 * The server plays the audiobook from the index's timings, and names each sentence by the id it
 * has in the index. The plain chapter has no such ids, so each sentence is found by where its
 * text sits (characters that are not whitespace, counted from the start of `<body>`) and wrapped
 * in spans carrying `data-bo-ra`; the first also takes the id, which is what foliate highlights
 * and follows. Foliate's CFIs skip these spans (epubcfi.js), so positions, highlights and notes
 * stay those of the plain EPUB. A chapter whose text differs from the index is left as it is.
 */

export const INDEX_SENTENCE_ATTRIBUTE = 'data-bo-ra'

type IndexedSection = { id?: string; mediaOverlay?: unknown }
type IndexedBook = { sections?: IndexedSection[]; media?: { activeClass?: string } }

const positionsByBook = new WeakMap<object, Record<string, EpubMediaOverlayTextPositions>>()

/**
 * Lets foliate narrate the plain EPUB `book` from `playlist`: every chapter the index reads gets a
 * media overlay marker, which is all foliate checks before it builds the narration. True when the
 * playlist is a timing index's and reads at least one chapter.
 */
export function attachIndexNarration(book: unknown, playlist: EpubMediaOverlayPlaylist | null): boolean {
  if (!book || typeof book !== 'object' || playlist?.source !== 'timing-index' || !playlist.textPositions) return false
  const indexed = book as IndexedBook
  const narrated = new Set(playlist.items.map((item) => item.sectionIndex))
  let any = false
  indexed.sections?.forEach((section, index) => {
    if (!narrated.has(index) || section.mediaOverlay) return
    section.mediaOverlay = { id: 'bookorbit-timing-index', href: playlist.sections.find((s) => s.index === index)?.smilHref ?? '' }
    any = true
  })
  if (any) positionsByBook.set(book, playlist.textPositions)
  return any
}

/** Whether `book` narrates from a timing index. */
export function hasIndexNarration(book: unknown): boolean {
  return !!book && typeof book === 'object' && positionsByBook.has(book)
}

/** Marks the sentences of section `index` of `book` in its loaded document `doc`. */
export function markIndexSection(book: unknown, index: number, doc: Document): boolean {
  if (!book || typeof book !== 'object') return false
  const positions = positionsByBook.get(book)
  const href = (book as IndexedBook).sections?.[index]?.id
  const chapter = href ? positions?.[href] : undefined
  return chapter ? markIndexSentences(doc, chapter) : false
}

/**
 * The elements of the sentence `id` in `doc`: every piece of one marked from a timing index, or
 * the one element a read-along EPUB gives it. Empty when `doc` has neither.
 */
export function narratedPieces(doc: Document, id: string): Element[] {
  const pieces = doc.querySelectorAll(`[${INDEX_SENTENCE_ATTRIBUTE}="${CSS.escape(id)}"]`)
  if (pieces.length) return [...pieces]
  const el = doc.getElementById(id)
  return el ? [el] : []
}

interface SentenceView {
  goTo: (target: string) => Promise<unknown>
  renderer?: { getContents?: () => { index: number; doc?: Document }[] }
}

/**
 * Goes to `fragment` ('chapter.xhtml#id'), a sentence saved while narrating from a timing index.
 * Only a chapter this session's narration marked has that id; anywhere else foliate lands on the
 * chapter's first page and still reports success. False then, and when the narration is not
 * attached at all, so the caller restores the reading position instead.
 */
export async function goToIndexSentence(view: SentenceView, fragment: string, attached: boolean): Promise<boolean> {
  const id = fragment.split('#')[1]
  if (!attached || !id) return false
  try {
    const resolved = (await view.goTo(fragment)) as { index?: unknown } | undefined
    if (typeof resolved?.index !== 'number') return false
    const doc = view.renderer?.getContents?.().find((x) => x.index === resolved.index)?.doc
    return !!doc?.querySelector(`[${INDEX_SENTENCE_ATTRIBUTE}="${CSS.escape(id)}"]`)
  } catch {
    return false
  }
}

const WHITESPACE = /\s/
/** Text inside these is not counted, and never wrapped. */
const UNCOUNTED = new Set(['script', 'style', 'svg', 'math'])
/** Parents a whitespace-only piece is not wrapped in, as a span there would add a box. */
const NO_INLINE_CHILD = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'ul', 'ol', 'dl'])

// The server counts the same text: the character data of text and CDATA nodes in <body>, outside
// script, style, svg and math.
function countedText(doc: Document): Text[] {
  const body = doc.body
  if (!body) return []
  const nodes: Text[] = []
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== body; el = el.parentElement) {
        if (UNCOUNTED.has(el.localName.toLowerCase())) return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

/** The index in `data` just past its `k`-th counted (not whitespace) character, 1-based. */
function rawEndOf(data: string, k: number): number {
  let seen = 0
  for (let i = 0; i < data.length; i++) {
    if (WHITESPACE.test(data[i]!)) continue
    if (++seen === k) return i + 1
  }
  return data.length
}

/** The index in `data` of its `k`-th counted character, 0-based. */
function rawStartOf(data: string, k: number): number {
  let seen = 0
  for (let i = 0; i < data.length; i++) {
    if (WHITESPACE.test(data[i]!)) continue
    if (seen++ === k) return i
  }
  return data.length
}

/**
 * Wraps each sentence of `positions` in `doc`. False, leaving `doc` untouched, when the chapter's
 * text is not the text the index was made from, or it was marked already.
 */
export function markIndexSentences(doc: Document, positions: EpubMediaOverlayTextPositions): boolean {
  const root = doc.documentElement
  if (!root || root.hasAttribute('data-bo-ra-marked')) return false
  const nodes = countedText(doc)
  const starts: number[] = []
  const counts: number[] = []
  let length = 0
  let hash = 0
  for (const node of nodes) {
    starts.push(length)
    let count = 0
    const data = node.data
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!
      if (WHITESPACE.test(c)) continue
      hash = (Math.imul(hash, 31) + data.charCodeAt(i)) >>> 0
      count++
    }
    counts.push(count)
    length += count
  }
  if (length !== positions.length || (hash | 0) !== positions.hash) return false
  root.setAttribute('data-bo-ra-marked', '')

  const firstNodeAt = (offset: number) => {
    let lo = 0
    let hi = nodes.length - 1
    let found = nodes.length
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! + counts[mid]! > offset) {
        found = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    return found
  }

  // Last sentence first: splitting a text node keeps its head in place, so the sentences before
  // it still find their text where it was counted.
  for (let s = positions.ids.length - 1; s >= 0; s--) {
    const id = positions.ids[s]!
    const start = positions.starts[s]!
    const end = positions.ends[s]!
    if (end <= start || doc.getElementById(id)) continue
    const pieces: { node: Text; from: number; to: number }[] = []
    for (let n = firstNodeAt(start); n < nodes.length && starts[n]! < end; n++) {
      const node = nodes[n]!
      // Whitespace between two pieces is a piece too, so the highlight has no gap there.
      if (counts[n] === 0) {
        const parent = node.parentElement?.localName.toLowerCase() ?? ''
        if (pieces.length && !NO_INLINE_CHILD.has(parent)) pieces.push({ node, from: 0, to: node.data.length })
        continue
      }
      // A sentence that runs on past this node takes its trailing spaces too, so the
      // highlight has no gaps between the pieces; one that began before it takes its leading ones.
      const from = start > starts[n]! ? rawStartOf(node.data, start - starts[n]!) : 0
      const to = end < starts[n]! + counts[n]! ? rawEndOf(node.data, end - starts[n]!) : node.data.length
      pieces.push({ node, from, to })
    }
    for (let p = pieces.length - 1; p >= 0; p--) {
      const { node, from, to } = pieces[p]!
      if (to < node.data.length) node.splitText(to)
      const target = from > 0 ? node.splitText(from) : node
      const span = doc.createElementNS(root.namespaceURI ?? 'http://www.w3.org/1999/xhtml', 'span')
      span.setAttribute(INDEX_SENTENCE_ATTRIBUTE, id)
      if (p === 0) span.id = id
      target.parentNode?.insertBefore(span, target)
      span.appendChild(target)
    }
  }
  return true
}
