import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import type { NeglectedGemsWidgetData } from '@bookorbit/types'
import NeglectedGemsWidget from '../NeglectedGemsWidget.vue'

const coverUrl = vi.fn<ReturnType<typeof useCoverVersions>['coverUrl']>(() => '/cover.jpg')

const fetchNeglectedGems = vi.fn<() => Promise<NeglectedGemsWidgetData>>()

vi.mock('@/features/dashboard/api/dashboard-widget.api', () => ({
  fetchNeglectedGems: () => fetchNeglectedGems(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn<(...args: unknown[]) => void>() }) }))
vi.mock('@/features/book/composables/useCoverVersions', () => ({
  useCoverVersions: () => ({ coverUrl }),
}))
vi.mock('@/features/book/composables/useBookStatus', () => ({
  useBookStatus: () => ({ setStatus: vi.fn<(...args: unknown[]) => Promise<void>>() }),
}))

const CoverArtworkStub = {
  name: 'BookCoverArtwork',
  props: ['src'],
  template: '<div data-testid="artwork" :data-src="src" />',
}

describe('NeglectedGemsWidget', () => {
  it('requests a versioned thumbnail for the current gem', async () => {
    fetchNeglectedGems.mockResolvedValue({
      gems: [{ coverVersion: 'face-v3', bookId: 8, title: 'Hyperion', hasCover: true, rating: 5, waitingDays: 400, genre: null }],
    })
    const wrapper = mount(NeglectedGemsWidget, {
      global: { stubs: { BookCoverSurface: { template: '<div><slot /></div>' }, BookCoverArtwork: CoverArtworkStub } },
    })
    await flushPromises()

    expect(coverUrl).toHaveBeenCalledWith(8, 'thumbnail', 'face-v3')
    expect(wrapper.get('[data-testid="artwork"]').attributes('data-src')).toBe('/cover.jpg')
  })
})
