import { computed, defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKnowledgeVisit } from './useKnowledgeVisit'
import { useReaderProgress } from '@/features/reader/shared/composables/useReaderProgress'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
function setup() {
  let progress!: ReturnType<typeof useReaderProgress>
  let visit!: ReturnType<typeof useKnowledgeVisit>
  const restore = vi.fn<(cfi: string | null, fraction: number) => Promise<void>>(async (cfi: string | null, fraction: number) => {
    progress.onRelocate({ cfi: cfi ?? '', fraction, reason: 'anchor' })
  })
  const wrapper = mount(
    defineComponent({
      setup() {
        visit = useKnowledgeVisit(() => ({ cfi: progress.cfi.value, fraction: progress.fraction.value }), restore)
        progress = useReaderProgress(1, 2, ref(0), 0, { trackingEnabled: computed(() => !visit.active.value) })
        return () => null
      },
    }),
  )
  return { progress, visit, restore, wrapper }
}
describe('temporary citation visits with the reader progress writer', () => {
  it('suppresses jump, page turns, flush and unmount until Continue from here', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValue(new Response('{}'))
    const { progress, visit, wrapper } = setup()
    progress.onRelocate({ cfi: 'original', fraction: 0.45, reason: 'anchor' })
    visit.begin()
    progress.onRelocate({ cfi: 'citation', fraction: 0.32 })
    progress.onRelocate({ cfi: 'next-page', fraction: 0.33 })
    progress.flush()
    await progress.save()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api).not.toHaveBeenCalled()
    expect(visit.active.value).toBe(true)
    visit.continueHere()
    await progress.save()
    expect(api).toHaveBeenCalledOnce()
    expect(String(vi.mocked(api).mock.calls[0]?.[1]?.body)).toContain('next-page')
    progress.onRelocate({ cfi: 'later-page', fraction: 0.34 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(api).toHaveBeenCalledTimes(2)
    visit.begin()
    progress.onRelocate({ cfi: 'another-citation', fraction: 0.2 })
    wrapper.unmount()
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('returns to the original CFI across multiple jumps and saves no citation', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValue(new Response('{}'))
    const { progress, visit, restore, wrapper } = setup()
    progress.onRelocate({ cfi: 'original', fraction: 0.45, reason: 'anchor' })
    visit.begin()
    progress.onRelocate({ cfi: 'citation', fraction: 0.32 })
    visit.begin()
    progress.onRelocate({ cfi: 'other-citation', fraction: 0.2 })
    await visit.back()
    expect(restore).toHaveBeenCalledWith('original', 0.45)
    expect(visit.active.value).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(api).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
