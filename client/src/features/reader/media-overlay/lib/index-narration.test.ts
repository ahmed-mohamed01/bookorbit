import { beforeAll, describe, expect, it } from 'vitest'
import type { EpubMediaOverlayPlaylist, EpubMediaOverlayTextPositions } from '@bookorbit/types'

import { attachIndexNarration, hasIndexNarration, markIndexSection, markIndexSentences, narratedPieces } from './index-narration'

type Cfi = {
  fromRange: (range: Range) => string
  toRange: (doc: Document, parts: unknown) => Range
  parse: (cfi: string) => unknown
}
let CFI: Cfi

beforeAll(async () => {
  Object.assign(globalThis, { NodeFilter: window.NodeFilter, Node: window.Node })
  const path = '../../../../../public/assets/foliate/epubcfi.js'
  CFI = (await import(/* @vite-ignore */ path)) as Cfi
})

// The server's count, written out: non-whitespace characters, h = h * 31 + c.
function positionsOf(text: string, sentences: [string, string][]): EpubMediaOverlayTextPositions {
  const counted = text.replace(/\s+/g, '')
  let hash = 0
  for (let i = 0; i < counted.length; i++) hash = (Math.imul(hash, 31) + counted.charCodeAt(i)) >>> 0
  const ids: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let from = 0
  for (const [id, sentence] of sentences) {
    const s = sentence.replace(/\s+/g, '')
    const at = counted.indexOf(s, from)
    ids.push(id)
    starts.push(at)
    ends.push(at + s.length)
    from = at + s.length
  }
  return { length: counted.length, hash: hash | 0, ids, starts, ends }
}

function chapter(body: string): Document {
  return new DOMParser().parseFromString(`<html><head><style>p{}</style></head><body>${body}</body></html>`, 'text/html')
}

const XHTML_DOCTYPE = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">'

function xhtmlChapter(body: string, doctype = ''): Document {
  return new DOMParser().parseFromString(
    `<?xml version="1.0" encoding="UTF-8"?>${doctype}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
}

const pieceText = (doc: Document, id: string) =>
  narratedPieces(doc, id)
    .map((el) => el.textContent)
    .join('')

const BODY = '<p>It was dark. The <em>rain fell</em> hard.</p>\n<p>Nobody came.</p>'
const TEXT = 'It was dark. The rain fell hard. Nobody came.'

const CFI_SENTENCES: [string, string][] = [
  ['s1', 'It was dark.'],
  ['s2', 'The rain fell hard.'],
  ['s3', 'Nobody came.'],
]

describe('narratedPieces', () => {
  it('falls back to the element a read-along EPUB gives the id', () => {
    const doc = chapter('<p><span id="s1">One.</span></p>')
    expect(narratedPieces(doc, 's1')).toEqual([doc.getElementById('s1')])
    expect(narratedPieces(doc, 'missing')).toEqual([])
  })

  it('finds every piece of an id that needs escaping', () => {
    const doc = chapter("<p><span data-bo-ra='a\"b' id='a\"b'>One</span> <span data-bo-ra='a\"b'>two.</span></p>")
    expect(narratedPieces(doc, 'a"b')).toHaveLength(2)
  })
})

describe('markIndexSentences', () => {
  it('wraps each sentence where the index counts it, across inline elements', () => {
    const doc = chapter(BODY)
    const ok = markIndexSentences(
      doc,
      positionsOf(TEXT, [
        ['s1', 'It was dark.'],
        ['s2', 'The rain fell hard.'],
        ['s3', 'Nobody came.'],
      ]),
    )
    expect(ok).toBe(true)
    expect(doc.getElementById('s1')?.textContent).toBe('It was dark.')
    const s2 = [...doc.querySelectorAll('[data-bo-ra="s2"]')].map((el) => el.textContent).join('')
    expect(s2).toBe('The rain fell hard.')
    expect(doc.querySelectorAll('[id="s2"]')).toHaveLength(1)
    expect(doc.getElementById('s3')?.textContent).toBe('Nobody came.')
    // The text itself is unchanged.
    expect(doc.body.textContent).toBe(chapter(BODY).body.textContent)
  })

  it('leaves a chapter whose text differs from the index untouched', () => {
    const doc = chapter(BODY.replace('dark', 'light'))
    expect(markIndexSentences(doc, positionsOf(TEXT, [['s1', 'It was dark.']]))).toBe(false)
    expect(doc.querySelector('[data-bo-ra]')).toBeNull()
  })

  it('marks a chapter once', () => {
    const doc = chapter(BODY)
    const positions = positionsOf(TEXT, [['s1', 'It was dark.']])
    expect(markIndexSentences(doc, positions)).toBe(true)
    expect(markIndexSentences(doc, positions)).toBe(false)
    expect(doc.querySelectorAll('[data-bo-ra]')).toHaveLength(1)
  })

  it('marks an XHTML chapter the same way', () => {
    const doc = xhtmlChapter(BODY)
    const ok = markIndexSentences(
      doc,
      positionsOf(TEXT, [
        ['s1', 'It was dark.'],
        ['s2', 'The rain fell hard.'],
      ]),
    )
    expect(ok).toBe(true)
    expect(pieceText(doc, 's1')).toBe('It was dark.')
    expect(pieceText(doc, 's2')).toBe('The rain fell hard.')
    expect(doc.getElementById('s2')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
  })

  it('counts CDATA as text and marks inside it', () => {
    const doc = xhtmlChapter('<p>It was <![CDATA[dark. The]]> rain fell.</p>')
    expect(doc.body.firstChild?.childNodes[1]?.nodeType).toBe(Node.CDATA_SECTION_NODE)
    const ok = markIndexSentences(
      doc,
      positionsOf('It was dark. The rain fell.', [
        ['s1', 'It was dark.'],
        ['s2', 'The rain fell.'],
      ]),
    )
    expect(ok).toBe(true)
    expect(pieceText(doc, 's1')).toBe('It was dark.')
    expect(pieceText(doc, 's2')).toBe('The rain fell.')
  })

  it('does not count or wrap text inside svg and math', () => {
    const body =
      '<p>It was dark.</p><svg xmlns="http://www.w3.org/2000/svg"><text>Figure one</text></svg>' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math><p>Nobody came.</p>'
    for (const doc of [chapter(body), xhtmlChapter(body)]) {
      const ok = markIndexSentences(
        doc,
        positionsOf('It was dark. Nobody came.', [
          ['s1', 'It was dark.'],
          ['s2', 'Nobody came.'],
        ]),
      )
      expect(ok).toBe(true)
      expect(pieceText(doc, 's2')).toBe('Nobody came.')
      expect(doc.querySelector('svg text')?.innerHTML).toBe('Figure one')
      expect(doc.querySelector('svg [data-bo-ra], math [data-bo-ra]')).toBeNull()
    }
  })

  // jsdom's XML parser rejects `&nbsp;` even under the XHTML doctype a browser reads it from, so
  // the space is written as the character reference that entity stands for.
  it('does not count a no-break space', () => {
    const doc = xhtmlChapter('<p>It was&#160;dark.&#160;Nobody came.</p>', XHTML_DOCTYPE)
    expect(doc.body.textContent).toContain('\u00a0')
    const ok = markIndexSentences(
      doc,
      positionsOf('It was dark. Nobody came.', [
        ['s1', 'It was dark.'],
        ['s2', 'Nobody came.'],
      ]),
    )
    expect(ok).toBe(true)
    expect(pieceText(doc, 's1')).toBe('It was\u00a0dark.')
    expect(pieceText(doc, 's2')).toBe('Nobody came.')
  })

  it('wraps the whitespace between pieces of a sentence, never as its first piece', () => {
    const doc = chapter('<p><em>Hello</em> <em>world.</em> <b>Again.</b></p>')
    markIndexSentences(
      doc,
      positionsOf('Hello world. Again.', [
        ['s1', 'Hello world.'],
        ['s2', 'Again.'],
      ]),
    )
    expect(pieceText(doc, 's1')).toBe('Hello world.')
    expect(narratedPieces(doc, 's1')).toHaveLength(3)
    expect(narratedPieces(doc, 's1')[0]).toBe(doc.getElementById('s1'))
    expect(doc.getElementById('s2')?.textContent).toBe('Again.')
  })

  it.each([
    ['an HTML', chapter, BODY, TEXT, CFI_SENTENCES, ['was', 'rain', 'hard', 'Nobody']],
    ['an XHTML', xhtmlChapter, BODY, TEXT, CFI_SENTENCES, ['was', 'rain', 'hard', 'Nobody']],
    [
      'a whitespace-wrapping',
      chapter,
      '<p><em>Hello</em> <em>world.</em> <b>Again.</b></p>',
      'Hello world. Again.',
      [
        ['s1', 'Hello world.'],
        ['s2', 'Again.'],
      ] as [string, string][],
      ['Hello', 'world', 'Again'],
    ],
  ])('keeps every CFI the same as in the unmarked chapter (%s chapter)', (_, parse, body, text, sentences, words) => {
    const plain = parse(body)
    const marked = parse(body)
    expect(markIndexSentences(marked, positionsOf(text, sentences))).toBe(true)
    const rangeIn = (doc: Document, word: string, length: number) => {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue!.indexOf(word)
        if (at < 0) continue
        const range = doc.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + length)
        return range
      }
      throw new Error(`${word} not found`)
    }
    for (const word of words) {
      const cfi = CFI.fromRange(rangeIn(plain, word, word.length))
      expect(CFI.fromRange(rangeIn(marked, word, word.length))).toBe(cfi)
      expect(CFI.toRange(marked, CFI.parse(cfi)).toString()).toBe(word)
    }
  })
})

describe('attachIndexNarration', () => {
  const playlist = (source: 'timing-index' | 'epub'): EpubMediaOverlayPlaylist => ({
    bookId: 1,
    fileId: 2,
    durationSeconds: 10,
    items: [
      {
        index: 0,
        sectionIndex: 1,
        smilHref: 'OEBPS/ch1.smil',
        textHref: 'OEBPS/ch1.xhtml',
        textFragment: 's1',
        audioHref: 'bookorbit-audio/9.m4b',
        audioMimeType: 'audio/mp4',
        clipBeginSeconds: 0,
        clipEndSeconds: 2,
        durationSeconds: 2,
        label: null,
      },
    ],
    sections: [{ index: 1, href: 'OEBPS/ch1.xhtml', label: null, smilHref: 'OEBPS/ch1.smil', startSeconds: 0, durationSeconds: 2 }],
    resources: [],
    source,
    textPositions: { 'OEBPS/ch1.xhtml': positionsOf(TEXT, [['s1', 'It was dark.']]) },
  })

  it('gives the narrated chapters a media overlay and marks them as they load', () => {
    const book = { sections: [{ id: 'OEBPS/cover.xhtml' }, { id: 'OEBPS/ch1.xhtml' }] as { id: string; mediaOverlay?: unknown }[] }
    expect(attachIndexNarration(book, playlist('timing-index'))).toBe(true)
    expect(book.sections[0]!.mediaOverlay).toBeUndefined()
    expect(book.sections[1]!.mediaOverlay).toBeTruthy()
    expect(hasIndexNarration(book)).toBe(true)
    const doc = chapter(BODY)
    expect(markIndexSection(book, 1, doc)).toBe(true)
    expect(doc.getElementById('s1')?.textContent).toBe('It was dark.')
  })

  it('ignores a read-along EPUB playlist', () => {
    const book = { sections: [{ id: 'a' }, { id: 'OEBPS/ch1.xhtml' }] }
    expect(attachIndexNarration(book, playlist('epub'))).toBe(false)
    expect(hasIndexNarration(book)).toBe(false)
  })
})
