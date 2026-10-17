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

it('reloads once before resolving a missing cached work and always consumes the link', async () => {
  const { resolveLinkedWork } = await import('./linked-work')
  const { vi } = await import('vitest')
  let works = [{ id: 'old' }]
  const load = vi.fn<() => Promise<void>>().mockImplementation(async () => {
    works = [{ id: 'new' }]
  })
  const consume = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  expect(await resolveLinkedWork('new', () => works, load, consume)).toEqual({ id: 'new' })
  expect(load).toHaveBeenCalledOnce()
  expect(consume).toHaveBeenCalledOnce()
  expect(await resolveLinkedWork('missing', () => works, load, consume)).toBeUndefined()
  expect(load).toHaveBeenCalledTimes(2)
  expect(consume).toHaveBeenCalledTimes(2)
})
