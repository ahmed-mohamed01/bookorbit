import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { useStoryGuideTabAvailability } from './useStoryGuideTabAvailability'

const app = vi.hoisted(() => ({ feature: true }))
const storyGuides = ref<{ building: boolean; served: boolean } | null>(null)
const hasPermission = vi.fn<(name: string) => boolean>(() => false)

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission }) }))
vi.mock('@/features/settings/composables/useAppInfo', () => ({
  useAppInfo: () => ({ ensureAppInfo: vi.fn<() => Promise<void>>(), supportsFeature: () => app.feature, storyGuides }),
}))

function book(format: string, role = 'primary') {
  return { files: [{ format, role }] } as BookDetail
}

describe('useStoryGuideTabAvailability', () => {
  it('shows the tab to readers without the build permission', () => {
    expect(useStoryGuideTabAvailability(() => book('epub')).value).toBe(true)
    expect(hasPermission).not.toHaveBeenCalled()
  })

  it('shows the tab for books a guide cannot be built from, which explain why', () => {
    expect(useStoryGuideTabAvailability(() => book('m4b')).value).toBe(true)
    expect(useStoryGuideTabAvailability(() => book('cbz')).value).toBe(true)
    expect(useStoryGuideTabAvailability(() => book('pdf')).value).toBe(true)
    expect(useStoryGuideTabAvailability(() => book('epub', 'supplement')).value).toBe(true)
  })

  it('hides the tab until the book is loaded', () => {
    expect(useStoryGuideTabAvailability(() => null).value).toBe(false)
  })

  it('needs the server to offer story guides', () => {
    app.feature = false
    expect(useStoryGuideTabAvailability(() => book('epub')).value).toBe(false)
    expect(useStoryGuideTabAvailability(() => book('m4b')).value).toBe(false)
    expect(useStoryGuideTabAvailability(() => book('cbz')).value).toBe(false)
    expect(useStoryGuideTabAvailability(() => book('pdf')).value).toBe(false)
    app.feature = true
    storyGuides.value = { building: false, served: false }
    expect(useStoryGuideTabAvailability(() => book('epub')).value).toBe(false)
    expect(useStoryGuideTabAvailability(() => book('m4b')).value).toBe(false)
    storyGuides.value = { building: false, served: true }
    expect(useStoryGuideTabAvailability(() => book('epub')).value).toBe(true)
    storyGuides.value = { building: true, served: false }
    expect(useStoryGuideTabAvailability(() => book('m4b')).value).toBe(true)
  })
})
