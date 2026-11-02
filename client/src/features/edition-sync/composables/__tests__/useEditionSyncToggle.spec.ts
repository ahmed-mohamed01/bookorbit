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

const EPUB = { id: 1, format: 'epub', role: 'primary', sizeBytes: 1, mediaOverlay: null }
const AUDIO = { id: 2, format: 'm4b', role: 'content', sizeBytes: 1, mediaOverlay: null }
const READ_ALONG = { id: 3, format: 'epub', role: 'content', sizeBytes: 1, mediaOverlay: { available: true } }

function filesFor(editionCount: number) {
  return editionCount >= 3 ? [EPUB, AUDIO, READ_ALONG] : [EPUB, AUDIO]
}

function setup(
  editionCount: number,
  eligible: boolean,
  mode: 'auto' | 'disabled',
  syncEnabled = false,
  saves = true,
  options: { visible?: boolean; files?: unknown[]; busy?: boolean } = {},
) {
  const state = ref({ editionCount, eligible, syncEnabled, hasReadAlong: editionCount >= 3, hasAudio: true } as unknown as EditionSyncBookState)
  const setSyncEnabled = vi.fn<(enabled: boolean) => Promise<boolean>>(() => Promise.resolve(saves))
  const onSaved = vi.fn<(book: BookDetail) => void>()
  const editionSync = {
    visible: ref(options.visible ?? true),
    state,
    editionCount: computed(() => state.value.editionCount),
    busy: ref(options.busy ?? false),
    setSyncEnabled,
  }
  const toggle = useEditionSyncToggle({
    book: () => ({ id: 7, readAloudSync: { mode }, files: options.files ?? filesFor(editionCount), formatPriority: null }) as unknown as BookDetail,
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

  it('read-along: stays when edition sync is hidden, without the permission or with the user setting off', async () => {
    const { toggle, setSyncEnabled } = setup(3, false, 'auto', false, true, { visible: false, busy: true })
    expect(toggle.kind.value).toBe('readAlong')
    expect(toggle.count.value).toBe(3)
    expect(toggle.disabled.value).toBe(false)
    await toggle.toggle(false)
    expect(setSyncEnabled).not.toHaveBeenCalled()
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/books/7/read-aloud-sync', expect.objectContaining({ body: JSON.stringify({ mode: 'disabled' }) }))
  })

  it('read-along: an ebook beside the read-along without audio still counts as a pair', () => {
    const { toggle } = setup(2, false, 'auto', false, true, { visible: false, files: [EPUB, READ_ALONG] })
    expect(toggle.kind.value).toBe('readAlong')
    expect(toggle.count.value).toBe(2)
  })

  it('read-along alone has nothing to sync', () => {
    const { toggle } = setup(2, false, 'auto', false, true, { visible: false, files: [READ_ALONG] })
    expect(toggle.kind.value).toBe('none')
    expect(toggle.count.value).toBeNull()
  })

  it('index book: hidden while edition sync is not visible', () => {
    const { toggle } = setup(2, true, 'auto', true, true, { visible: false })
    expect(toggle.kind.value).toBe('none')
    expect(toggle.count.value).toBeNull()
  })
})
