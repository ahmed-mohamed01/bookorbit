import { expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useExternalSearch } from '../useExternalSearch'
import type { searchHardcoverUniversal } from '@/features/monitored/api/monitored'
import type { discoverSerials } from '@/features/web-serials/api/webSerials'
const mocks = vi.hoisted(() => ({ hardcover: vi.fn<typeof searchHardcoverUniversal>(), discover: vi.fn<typeof discoverSerials>() }))
vi.mock('@/features/monitored/api/monitored', () => ({ searchHardcoverUniversal: mocks.hardcover }))
vi.mock('@/features/web-serials/api/webSerials', () => ({ discoverSerials: mocks.discover }))
it('reschedules one timer when another member becomes allowed', async () => {
  vi.useFakeTimers()
  mocks.hardcover.mockResolvedValue({ available: true, books: [], authors: [] })
  mocks.discover.mockResolvedValue({ results: [], fallback: null })
  const mangaSearchable = ref(false)
  const localReady = ref(false)
  const scope = effectScope()
  scope.run(() =>
    useExternalSearch({
      query: ref('final'),
      tab: ref('all'),
      isOpen: ref(true),
      hardcoverPermission: ref(true),
      mangaSearchable,
      novelsSearchable: ref(false),
      capabilitiesReady: () => Promise.resolve(),
      localReady,
      strongMatches: ref(0),
    }),
  )
  localReady.value = true
  await nextTick()
  await vi.advanceTimersByTimeAsync(300)
  mangaSearchable.value = true
  await nextTick()
  await vi.advanceTimersByTimeAsync(200)
  expect(mocks.hardcover).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300)
  expect(mocks.hardcover).toHaveBeenCalledOnce()
  expect(mocks.discover).toHaveBeenCalledOnce()
  scope.stop()
  vi.useRealTimers()
})
