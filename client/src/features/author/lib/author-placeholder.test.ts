// @vitest-environment node
import { PLACEHOLDER_COVER_STYLES, type PlaceholderCoverStyle } from '@bookorbit/types'
import { describe, expect, it } from 'vitest'
import { colorsOf, renderAuthorPlaceholder } from './author-placeholder'
import type { PlaceholderStrings } from '@/features/book/lib/placeholder'

const strings: PlaceholderStrings = {
  untitled: 'Untitled',
  volume: (n) => `Vol. ${n}`,
  family: (key) => key,
  list: new Intl.ListFormat('en', { style: 'short', type: 'conjunction' }),
}

const PORTRAIT = { width: 112, height: 168 }
const SQUARE = { width: 132, height: 132 }

describe('renderAuthorPlaceholder', () => {
  it.each(PLACEHOLDER_COVER_STYLES)('stacks engine artwork and a figure svg for %s', (style) => {
    const markup = renderAuthorPlaceholder(style, 'Ursula K. Le Guin', PORTRAIT, strings)
    expect(markup.match(/<svg/g)).toHaveLength(2)
    expect(markup.endsWith('</svg>')).toBe(true)
  })

  it.each(PLACEHOLDER_COVER_STYLES)('is deterministic for the same name in %s', (style) => {
    const strip = (m: string) => m.replace(/(pc|ap)[0-9a-z]+/g, '')
    const a = renderAuthorPlaceholder(style, 'Brandon Sanderson', PORTRAIT, strings)
    const b = renderAuthorPlaceholder(style, 'Brandon Sanderson', PORTRAIT, strings)
    expect(strip(a)).toBe(strip(b))
  })

  it('crops portrait slots to the figure band and squares to the full design space', () => {
    const portrait = renderAuthorPlaceholder('bauhaus', 'Terry Pratchett', PORTRAIT, strings)
    expect(portrait).toContain('viewBox="100 40 400 600"')
    const square = renderAuthorPlaceholder('bauhaus', 'Terry Pratchett', SQUARE, strings)
    expect(square).toContain('viewBox="0 0 600 600"')
  })

  it('does not reuse ids across calls', () => {
    const a = renderAuthorPlaceholder('bauhaus', 'N. K. Jemisin', PORTRAIT, strings)
    const b = renderAuthorPlaceholder('bauhaus', 'N. K. Jemisin', PORTRAIT, strings)
    const ids = [...a.matchAll(/id="([\w-]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(b).not.toContain(`id="${id}"`)
      expect(b).not.toContain(`url(#${id})`)
    }
  })

  it('falls back to the bauhaus figure for an unknown style', () => {
    const known = renderAuthorPlaceholder('bauhaus', 'Octavia E. Butler', PORTRAIT, strings)
    const unknown = renderAuthorPlaceholder('nonsense' as PlaceholderCoverStyle, 'Octavia E. Butler', PORTRAIT, strings)
    const structure = (m: string) =>
      m
        .slice(m.lastIndexOf('<svg'))
        .replace(/ap[0-9a-z]+/g, '')
        .replace(/[\d.]+/g, '#')
    expect(structure(unknown)).toBe(structure(known))
  })

  it('falls back to a question mark seed for a blank name', () => {
    const blank = renderAuthorPlaceholder('poster', '   ', PORTRAIT, strings)
    const known = renderAuthorPlaceholder('poster', '?', PORTRAIT, strings)
    expect(blank.replace(/ap[0-9a-z]+/g, '')).toBe(known.replace(/ap[0-9a-z]+/g, ''))
  })
})

describe('colorsOf', () => {
  it('falls back to fixed colours when the markup has no oklch values', () => {
    expect(colorsOf('<svg viewBox="0 0 1 1"></svg>')).toEqual({
      dark: 'oklch(0.2 0.02 265)',
      light: 'oklch(0.95 0.01 85)',
      accent: 'oklch(0.6 0.18 30)',
      mid: 'oklch(0.6 0.05 265)',
    })
  })

  it('sorts the artwork colours by lightness and chroma', () => {
    const c = colorsOf('<svg fill="oklch(0.2 0.02 265)" stroke="oklch(0.95 0.01 85)"><rect fill="oklch(0.6 0.18 30)"/></svg>')
    expect(c).toEqual({
      dark: 'oklch(0.2 0.02 265)',
      light: 'oklch(0.95 0.01 85)',
      accent: 'oklch(0.6 0.18 30)',
      mid: 'oklch(0.6 0.18 30)',
      darkL: 0.2,
    })
  })
})
