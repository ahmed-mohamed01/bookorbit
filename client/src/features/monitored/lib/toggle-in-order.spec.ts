import { describe, expect, it } from 'vitest'
import { toggleInOrder } from './toggle-in-order'

describe('toggleInOrder', () => {
  it('toggles within the canonical order and drops entries outside it', () => {
    expect(toggleInOrder(['a', 'b', 'c'], ['a'], 'a')).toEqual([])
    expect(toggleInOrder(['a', 'b', 'c'], ['c'], 'a')).toEqual(['a', 'c'])
    expect(toggleInOrder(['a', 'b', 'c'], ['c', 'b'], 'c')).toEqual(['b'])
    expect(toggleInOrder(['a', 'b', 'c'], ['b', 'x'], 'c')).toEqual(['b', 'c'])
  })
})
