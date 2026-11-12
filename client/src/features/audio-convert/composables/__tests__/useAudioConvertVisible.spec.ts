import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'

import { resetAudioConvertEnabled, useAudioConvertEnabled } from '../useAudioConvertEnabled'
import { useAudioConvertVisible } from '../useAudioConvertVisible'

const mocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>() }))

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: mocks.hasPermission }) }))
vi.mock('../../api/audio-convert', () => ({
  AudioConvertHttpError: class extends Error {},
  fetchAudioConvertEnabled: vi.fn<() => Promise<never>>(() => new Promise<never>(() => {})),
}))

function book(...files: [format: string | null, role?: string][]): BookDetail {
  return { id: 1, files: files.map(([format, role = 'content'], i) => ({ id: i + 1, format, role })) } as unknown as BookDetail
}

beforeEach(() => {
  mocks.hasPermission.mockReturnValue(true)
  useAudioConvertEnabled({ autoload: false }).setState(true)
})

afterEach(() => {
  resetAudioConvertEnabled()
  vi.clearAllMocks()
})

describe('useAudioConvertVisible', () => {
  it('shows the button and the menu entries for a manager on an MP3 book', () => {
    const { visible, offered } = useAudioConvertVisible(book(['mp3'], ['mp3']))
    expect(visible.value).toBe(true)
    expect(offered.value).toBe(true)
  })

  it('keeps the button but drops the menu entries on a book that is already one M4B', () => {
    const { visible, offered } = useAudioConvertVisible(book(['m4b'], ['jpg', 'cover']))
    expect(visible.value).toBe(true)
    expect(offered.value).toBe(false)
  })

  it('hides everything without manage_libraries, while the tool is off or unknown, and on books without audio', () => {
    mocks.hasPermission.mockReturnValue(false)
    expect(useAudioConvertVisible(book(['mp3'])).visible.value).toBe(false)

    mocks.hasPermission.mockReturnValue(true)
    expect(useAudioConvertVisible(book(['epub'], [null])).visible.value).toBe(false)

    useAudioConvertEnabled({ autoload: false }).setState(false)
    expect(useAudioConvertVisible(book(['mp3'])).offered.value).toBe(false)

    resetAudioConvertEnabled()
    expect(useAudioConvertVisible(book(['mp3'])).visible.value).toBe(false)
  })

  it('follows the book as its files change', () => {
    const current = ref(book(['mp3'], ['mp3']))
    const { offered } = useAudioConvertVisible(current)
    expect(offered.value).toBe(true)

    current.value = book(['m4b'])
    expect(offered.value).toBe(false)
  })
})
