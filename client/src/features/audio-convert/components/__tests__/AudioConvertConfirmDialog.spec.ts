import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { AudioConvertEncoderOptions } from '@bookorbit/types'

import AudioConvertConfirmDialog from '../AudioConvertConfirmDialog.vue'

let wrapper: VueWrapper | null = null

function mountDialog(defaults: AudioConvertEncoderOptions | null) {
  wrapper = mount(AudioConvertConfirmDialog, {
    props: { open: false, count: 3, defaults, backupDays: 14 },
    attachTo: document.body,
  })
  return wrapper
}

function selects(): HTMLSelectElement[] {
  return [...document.body.querySelectorAll<HTMLSelectElement>('[data-testid="audio-convert-confirm"] select')]
}

function go(): void {
  document.body.querySelector<HTMLButtonElement>('[data-testid="audio-convert-confirm-go"]')!.click()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AudioConvertConfirmDialog', () => {
  it('shows the saved defaults and sends nothing the user did not change', async () => {
    const w = mountDialog({ codec: 'aac', bitrate: '64k', channels: 1 })
    await w.setProps({ open: true })
    await flushPromises()

    expect(selects().map((s) => s.value)).toEqual(['64k', '1'])
    go()
    expect(w.emitted('confirm')).toEqual([[{}]])
  })

  it('sends a field once the user picks it', async () => {
    const w = mountDialog({ codec: 'aac', bitrate: '64k', channels: 1 })
    await w.setProps({ open: true })
    await flushPromises()

    const bitrate = selects()[0]!
    bitrate.value = '160k'
    bitrate.dispatchEvent(new Event('change'))
    go()
    expect(w.emitted('confirm')).toEqual([[{ bitrate: '160k' }]])
  })

  it('takes defaults that arrive after it opened, except for fields already picked', async () => {
    const w = mountDialog(null)
    await w.setProps({ open: true })
    await flushPromises()
    const channels = selects()[1]!
    channels.value = '2'
    channels.dispatchEvent(new Event('change'))

    await w.setProps({ defaults: { codec: 'aac', bitrate: '96k', channels: 1 } })
    await flushPromises()

    expect(selects().map((s) => s.value)).toEqual(['96k', '2'])
    go()
    expect(w.emitted('confirm')).toEqual([[{ channels: 2 }]])
  })

  it('starts each opening from the defaults again', async () => {
    const w = mountDialog({ codec: 'auto', bitrate: '128k', channels: null })
    await w.setProps({ open: true })
    await flushPromises()
    const bitrate = selects()[0]!
    bitrate.value = '32k'
    bitrate.dispatchEvent(new Event('change'))

    await w.setProps({ open: false })
    await w.setProps({ open: true })
    await flushPromises()
    expect(selects()[0]!.value).toBe('128k')
    go()
    expect(w.emitted('confirm')).toEqual([[{}]])
  })
})
