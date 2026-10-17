import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useLinkedWorkParam } from '../useLinkedWorkParam'
const route = reactive({ params: { id: '5' }, query: {} as Record<string, string> })
const replace = vi.fn<(to: unknown) => Promise<void>>()
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.forEach((scope) => scope.stop())
  route.params.id = '5'
  route.query = {}
  replace.mockClear()
})
function setup() {
  const works = ref([{ id: 'new' }])
  const ready = ref(true)
  const active = ref(true)
  const open = vi.fn<(work: { id: string }) => void>()
  const load = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useLinkedWorkParam({ works, ready, active, load, open }))
  return { works, ready, active, open, load }
}
it('ignores another author and inactive links', async () => {
  const state = setup()
  route.params.id = '7'
  route.query = { work: 'new' }
  await flushPromises()
  expect(state.load).not.toHaveBeenCalled()
  expect(state.open).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
  route.params.id = '5'
  state.active.value = false
  await flushPromises()
  expect(state.open).not.toHaveBeenCalled()
})
it('invalidates an older resolution before a newer selection', async () => {
  const state = setup()
  let finish!: () => void
  state.load.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  route.query = { work: 'old' }
  await nextTick()
  route.query = { work: 'new' }
  await flushPromises()
  state.works.value.push({ id: 'old' })
  finish()
  await flushPromises()
  expect(state.open.mock.calls).toEqual([[{ id: 'new' }]])
  expect(replace).toHaveBeenCalledTimes(1)
})
it('reloads then opens and strips only work', async () => {
  const state = setup()
  state.load.mockImplementation(async () => {
    state.works.value.push({ id: 'missing' })
  })
  route.query = { work: 'missing', from: '/watchlist' }
  await flushPromises()
  expect(state.load).toHaveBeenCalledOnce()
  expect(state.open).toHaveBeenCalledWith({ id: 'missing' })
  expect(replace).toHaveBeenCalledWith({ query: { from: '/watchlist' } })
})
