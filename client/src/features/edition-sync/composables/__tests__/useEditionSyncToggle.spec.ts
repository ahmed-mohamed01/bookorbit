import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { BookDetail, EditionSyncBookState } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  toastError: vi.fn<(message: string) => void>(),
}))
vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import { useEditionSyncToggle } from '../useEditionSyncToggle'

function setup(editionCount: number, eligible: boolean, mode: 'auto' | 'disabled', syncEnabled = false, saves = true) {
  const state = ref({ editionCount, eligible, syncEnabled, hasReadAlong: editionCount >= 3, hasAudio: true } as unknown as EditionSyncBookState)
  const setSyncEnabled = vi.fn<(enabled: boolean) => Promise<boolean>>(() => Promise.resolve(saves))
  const onSaved = vi.fn<(book: BookDetail) => void>()
  const editionSync = {
    visible: ref(true),
    state,
    editionCount: computed(() => state.value.editionCount),
    busy: ref(false),
    setSyncEnabled,
  }
  const toggle = useEditionSyncToggle({
    book: () => ({ id: 7, readAloudSync: { mode } }) as BookDetail,
    editionSync: editionSync as never,
    onSaved,
  })
  return { toggle, setSyncEnabled, onSaved }
}

describe('useEditionSyncToggle', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    mocks.toastError.mockReset()
    mocks.api.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 7 }))))
  })

  it('read-along: header counts editions and writes the read-aloud mode only', async () => {
    const { toggle, setSyncEnabled, onSaved } = setup(3, false, 'auto')
    expect(toggle.count.value).toBe(3)
    expect(toggle.checked.value).toBe(true)
    await toggle.toggle(false)
    expect(setSyncEnabled).not.toHaveBeenCalled()
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/books/7/read-aloud-sync', expect.objectContaining({ body: JSON.stringify({ mode: 'disabled' }) }))
    expect(onSaved).toHaveBeenCalled()
  })

  it('index book: turning on also flips a disabled read-aloud mode to auto', async () => {
    const { toggle, setSyncEnabled } = setup(2, true, 'disabled')
    await toggle.toggle(true)
    expect(setSyncEnabled).toHaveBeenCalledWith(true)
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/books/7/read-aloud-sync', expect.objectContaining({ body: JSON.stringify({ mode: 'auto' }) }))
  })

  it('index book: a failed override save leaves the read-aloud mode alone', async () => {
    const { toggle, setSyncEnabled } = setup(2, true, 'disabled', false, false)
    await toggle.toggle(true)
    expect(setSyncEnabled).toHaveBeenCalledWith(true)
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('index book: reads as off while the read-aloud mode is disabled even if the override is on', () => {
    expect(setup(2, true, 'disabled', true).toggle.checked.value).toBe(false)
    expect(setup(2, true, 'auto', true).toggle.checked.value).toBe(true)
  })

  it('index book: turning off only sets the override', async () => {
    const { toggle, setSyncEnabled } = setup(2, true, 'disabled', true)
    await toggle.toggle(false)
    expect(setSyncEnabled).toHaveBeenCalledWith(false)
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('any other book has no header toggle', () => {
    const { toggle } = setup(2, false, 'auto')
    expect(toggle.count.value).toBeNull()
  })
})
