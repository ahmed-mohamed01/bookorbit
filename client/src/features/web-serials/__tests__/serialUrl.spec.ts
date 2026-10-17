import { describe, expect, it } from 'vitest'
import { isSerialLink, formatSeriesParam, parseSeriesParam } from '../lib/serialUrl'

describe('isSerialLink', () => {
  it('accepts http and https links', () => {
    expect(isSerialLink('https://www.royalroad.com/fiction/12345/some-novel')).toBe(true)
    expect(isSerialLink('  http://example.org/novel/1  ')).toBe(true)
  })

  it('treats titles as searches, even ones that mention a site', () => {
    expect(isSerialLink('Solo Leveling')).toBe(false)
    expect(isSerialLink('royalroad.com is great')).toBe(false)
    expect(isSerialLink('https://example.com is great')).toBe(false)
    expect(isSerialLink('')).toBe(false)
  })

  it('rejects other schemes and hostless input', () => {
    expect(isSerialLink('ftp://example.com/file')).toBe(false)
    expect(isSerialLink('javascript:alert(1)')).toBe(false)
    expect(isSerialLink('http://localhost')).toBe(false)
  })
})

it('round-trips typed series links and rejects malformed values', () => {
  expect(parseSeriesParam(formatSeriesParam('novel', '123'))).toEqual({ kind: 'novel', matchId: '123' })
  expect(parseSeriesParam('manga:42')).toEqual({ kind: 'manga', matchId: '42' })
  for (const value of [null, ['novel:1'], 'other:1', 'novel:x', 'novel:']) expect(parseSeriesParam(value)).toBeNull()
})
