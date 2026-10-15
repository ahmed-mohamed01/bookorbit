import { describe, expect, it } from 'vitest'
import { subtitleRepeatsSeries } from './subtitle'

const strata = [{ name: 'The Strata Wars', index: '1' }]

describe('subtitleRepeatsSeries', () => {
  it('spots a subtitle that only names the series and its position', () => {
    expect(subtitleRepeatsSeries('The Strata Wars, Book 1', strata)).toBe(true)
    expect(subtitleRepeatsSeries('The Strata Wars #1', strata)).toBe(true)
    expect(subtitleRepeatsSeries('Strata Wars Volume One', [{ name: 'Strata Wars', index: null }])).toBe(false)
  })

  it('keeps a subtitle that says something else', () => {
    expect(subtitleRepeatsSeries('A Cosmere Novel', [{ name: 'The Cosmere', index: '36' }])).toBe(false)
    expect(subtitleRepeatsSeries('Machine Learning and Human Values', strata)).toBe(false)
    expect(subtitleRepeatsSeries(null, strata)).toBe(false)
    expect(subtitleRepeatsSeries('Book 1', [])).toBe(false)
  })
})
