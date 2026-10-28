import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getWorkForBook } from '../../api/work'
import { useWorkForBook } from '../useWorkForBook'
import { variant, work } from './fixtures'

vi.mock('../../api/work', () => ({ getWorkForBook: vi.fn<(...args: unknown[]) => unknown>() }))
const refresh = vi.hoisted(() => ({ callback: null as null | (() => void | Promise<void>) }))
vi.mock('@/features/book/composables/useBookProgressRefresh', () => ({
  useBookProgressRefresh: (callback: () => void | Promise<void>) => {
    refresh.callback = callback
  },
}))

function mountComposable(bookId = ref(1)) {
  let result!: ReturnType<typeof useWorkForBook>
  mount(
    defineComponent({
      setup() {
        result = useWorkForBook(() => bookId.value)
        return () => h('div')
      },
    }),
  )
  return { result, bookId }
}

describe('useWorkForBook', () => {
  beforeEach(() => {
    vi.mocked(getWorkForBook).mockReset().mockResolvedValue(work())
  })

  it('loads the work for the book and derives the other variants', async () => {
    const { result } = mountComposable()
    await flushPromises()

    expect(getWorkForBook).toHaveBeenCalledWith(1)
    expect(result.otherVariants.value.map((entry) => entry.bookId)).toEqual([2])
    expect(result.libraryCount.value).toBe(2)
    expect(result.hasAudioVariant.value).toBe(true)
    expect(result.syncState.value).toBe('sync')
  })

  it('reports catching up and shared state off', async () => {
    vi.mocked(getWorkForBook).mockResolvedValue(work({ inSync: false }))
    const { result } = mountComposable()
    await flushPromises()
    expect(result.syncState.value).toBe('catching')

    vi.mocked(getWorkForBook).mockResolvedValue(work({ sharedState: false }))
    await result.load()
    expect(result.syncState.value).toBe('off')
  })

  it('refetches when the progress-changed refresh fires and when the book changes', async () => {
    const { bookId } = mountComposable()
    await flushPromises()

    await refresh.callback?.()
    expect(getWorkForBook).toHaveBeenCalledTimes(2)

    bookId.value = 9
    await flushPromises()
    expect(getWorkForBook).toHaveBeenLastCalledWith(9)
  })

  it('keeps a standalone book without other variants', async () => {
    vi.mocked(getWorkForBook).mockResolvedValue(work({ linkId: null, variants: [variant({ isThisBook: true })] }))
    const { result } = mountComposable()
    await flushPromises()

    expect(result.hasOtherVariants.value).toBe(false)
  })

  it('records a load failure', async () => {
    vi.mocked(getWorkForBook).mockRejectedValue(new Error('offline'))
    const { result } = mountComposable()
    await flushPromises()

    expect(result.error.value).toBe('work_load_failed')
    expect(result.work.value).toBeNull()
  })
})
