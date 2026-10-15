import { describe, expect, it } from 'vitest'
import {
  cleanSourceName,
  groupSourcesByLanguage,
  isLanguageSelected,
  libraryAcceptsKind,
  orderedDomains,
  toggleDomain,
  effectiveSourceIds,
  setSourcesSelected,
  toggleSource,
} from '../components/settings/settingsLib'

describe('libraryAcceptsKind', () => {
  it('treats an empty format list as any and otherwise matches the kind format', () => {
    expect(libraryAcceptsKind({ allowedFormats: [] }, 'manga')).toBe(true)
    expect(libraryAcceptsKind({ allowedFormats: ['cbz'] }, 'manga')).toBe(true)
    expect(libraryAcceptsKind({ allowedFormats: ['cbz'] }, 'novel')).toBe(false)
    expect(libraryAcceptsKind({ allowedFormats: ['epub', 'pdf'] }, 'novel')).toBe(true)
  })
})

describe('manga source groups', () => {
  it('drops the language suffix from a source name', () => {
    expect(cleanSourceName('Mangabat (EN)')).toBe('Mangabat')
    expect(cleanSourceName('NovelCool (PT-BR)')).toBe('NovelCool')
    expect(cleanSourceName('Plain')).toBe('Plain')
  })

  it('groups by lowercase language in code order', () => {
    const groups = groupSourcesByLanguage([
      { id: '1', name: 'A', lang: 'pt-BR', nsfw: false },
      { id: '2', name: 'B', lang: 'en', nsfw: false },
      { id: '3', name: 'C', lang: 'en', nsfw: false },
    ])
    expect(groups.map((group) => [group.lang, group.sources.length])).toEqual([
      ['en', 2],
      ['pt-br', 1],
    ])
  })

  it('selects a regional group through its base language like the server does', () => {
    expect(isLanguageSelected(['pt'], 'pt-BR')).toBe(true)
    expect(isLanguageSelected(['en'], 'pt-BR')).toBe(false)
  })

  it('derives the legacy selection from languages until sources are picked', () => {
    const sources = [
      { id: '1', name: 'A', lang: 'en', nsfw: false },
      { id: '2', name: 'B', lang: 'pt-BR', nsfw: false },
      { id: '3', name: 'C', lang: 'es', nsfw: false },
    ]
    expect(effectiveSourceIds(sources, null, ['en', 'pt'])).toEqual(['1', '2'])
    expect(effectiveSourceIds(sources, ['3'], ['en'])).toEqual(['3'])
    expect(effectiveSourceIds(sources, [], ['en'])).toEqual([])
  })

  it('toggles one source and a whole group while keeping other ids', () => {
    expect(toggleSource(['1'], '2')).toEqual(['1', '2'])
    expect(toggleSource(['1', '2'], '1')).toEqual(['2'])
    expect(setSourcesSelected(['9', '1'], ['1', '2'], true)).toEqual(['9', '1', '2'])
    expect(setSourcesSelected(['9', '1', '2'], ['1', '2'], false)).toEqual(['9'])
  })
})

describe('novel domains', () => {
  const domains = ['a.com', 'b.com', 'c.org']

  it('puts selected sites first and filters by the query', () => {
    expect(orderedDomains(domains, ['c.org'], '')).toEqual(['c.org', 'a.com', 'b.com'])
    expect(orderedDomains(domains, ['c.org'], ' .COM')).toEqual(['a.com', 'b.com'])
  })

  it('toggles a domain', () => {
    expect(toggleDomain(['a.com'], 'b.com')).toEqual(['a.com', 'b.com'])
    expect(toggleDomain(['a.com', 'b.com'], 'a.com')).toEqual(['b.com'])
  })
})
