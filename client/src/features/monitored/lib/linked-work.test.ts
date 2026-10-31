import { expect, it } from 'vitest'
import { linkedWork } from './linked-work'
it('finds linked works after activation and query changes', () => {
  const works = [{ id: 'one' }, { id: 'two' }]
  expect(linkedWork('one', works)).toBe(works[0])
  expect(linkedWork('two', works)).toBe(works[1])
})
it('silently skips unloaded or invalid linked works', () => {
  expect(linkedWork('missing', [{ id: 'one' }])).toBeUndefined()
  expect(linkedWork(['one'], [{ id: 'one' }])).toBeUndefined()
})
