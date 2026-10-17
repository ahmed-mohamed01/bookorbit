import { expect, it, vi } from 'vitest'
import { effectScope, reactive, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useRequestPrefillParam } from './useRequestPrefillParam'
const route = reactive({ query: { title: 'Final', author: 'Author', other: 'keep' } as Record<string, string> })
const replace = vi.fn<(to: unknown) => Promise<void>>()
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
it('waits for readiness then prefills, searches and consumes only prefill params', async () => {
  const ready = ref(false)
  const title = ref('')
  const author = ref('')
  const search = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const scope = effectScope()
  scope.run(() => useRequestPrefillParam({ ready, title, author, search }))
  expect(search).not.toHaveBeenCalled()
  ready.value = true
  await flushPromises()
  expect(title.value).toBe('Final')
  expect(author.value).toBe('Author')
  expect(search).toHaveBeenCalledOnce()
  expect(replace).toHaveBeenCalledWith({ query: { other: 'keep' } })
  scope.stop()
})
