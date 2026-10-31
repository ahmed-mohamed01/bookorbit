import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import { cardProgress, chainText, chainTitle } from '../sync-chain-messages'

const t = (key: string, params?: Record<string, unknown>) => (params && Object.keys(params).length ? `${key}${JSON.stringify(params)}` : key)

describe('chainText', () => {
  it('resolves a message with its params', () => {
    expect(chainText({ key: 'a.b', params: { n: 2, m: 3 } }, t)).toBe('a.b{"n":2,"m":3}')
    expect(chainText({ key: 'a.b' }, t)).toBe('a.b')
  })

  it('names a missing title', () => {
    expect(chainText({ key: 'x', params: { title: '' } }, t)).toBe('x{"title":"book.detail.editionLink.unknownTitle"}')
  })
})

describe('chainTitle', () => {
  it('falls back for a null or empty title', () => {
    expect(chainTitle('Dune', t)).toBe('Dune')
    expect(chainTitle(null, t)).toBe('book.detail.editionLink.unknownTitle')
    expect(chainTitle('', t)).toBe('book.detail.editionLink.unknownTitle')
  })
})

describe('cardProgress', () => {
  it('reads anything started as at least 1% and caps at 100', () => {
    expect(cardProgress(null)).toBeNull()
    expect(cardProgress(0)).toBe(0)
    expect(cardProgress(0.2)).toBe(1)
    expect(cardProgress(41.6)).toBe(42)
    expect(cardProgress(130)).toBe(100)
  })
})

describe('chain copy', () => {
  const chain = en.book.detail.editionLink.chain

  it('leaves the Settings pointer of a one-way explainer to the appended link', () => {
    expect(chain.explain.absFromAbs).not.toMatch(/Settings/)
    expect(chain.explain.absToAbs).not.toMatch(/Settings/)
  })
})
