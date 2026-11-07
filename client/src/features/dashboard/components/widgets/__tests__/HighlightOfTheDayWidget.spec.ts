import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import type { HighlightOfTheDayWidgetData } from '@bookorbit/types'
import HighlightOfTheDayWidget from '../HighlightOfTheDayWidget.vue'

const coverUrl = vi.fn<ReturnType<typeof useCoverVersions>['coverUrl']>(() => '/cover.jpg')

const fetchHighlightOfTheDay = vi.fn<() => Promise<HighlightOfTheDayWidgetData | null>>()

vi.mock('@/features/dashboard/api/dashboard-widget.api', () => ({
  fetchHighlightOfTheDay: () => fetchHighlightOfTheDay(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn<(...args: unknown[]) => void>() }) }))
vi.mock('@/features/book/composables/useCoverVersions', () => ({
  useCoverVersions: () => ({ coverUrl }),
}))

const CoverArtworkStub = {
  name: 'BookCoverArtwork',
  props: ['src'],
  template: '<div data-testid="artwork" :data-src="src" />',
}

describe('HighlightOfTheDayWidget', () => {
  it('requests a versioned thumbnail for the highlighted book', async () => {
    fetchHighlightOfTheDay.mockResolvedValue({
      coverVersion: 'face-v2',
      text: 'The spice must flow.',
      note: null,
      bookTitle: 'Dune',
      bookId: 4,
      hasCover: true,
      chapterTitle: null,
      createdAt: '2026-01-01T00:00:00Z',
    })
    const wrapper = mount(HighlightOfTheDayWidget, {
      global: { stubs: { BookCoverSurface: { template: '<div><slot /></div>' }, BookCoverArtwork: CoverArtworkStub } },
    })
    await flushPromises()

    expect(coverUrl).toHaveBeenCalledWith(4, 'thumbnail', 'face-v2')
    expect(wrapper.get('[data-testid="artwork"]').attributes('data-src')).toBe('/cover.jpg')
  })
})
