import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { useActiveKeydown } from '../useActiveKeydown'

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key }))
}

describe('useActiveKeydown', () => {
  it('listens only while the kept-alive view is shown, and stops on unmount', async () => {
    const handler = vi.fn<(event: KeyboardEvent) => void>()
    const Listening = defineComponent({
      setup() {
        useActiveKeydown(handler)
        return () => h('div', 'convert')
      },
    })
    const Other = defineComponent({ render: () => h('div', 'other') })
    const showing = ref<'convert' | 'other'>('convert')
    const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, [h(showing.value === 'convert' ? Listening : Other)]) }))

    press('j')
    expect(handler).toHaveBeenCalledTimes(1)

    showing.value = 'other'
    await nextTick()
    press('j')
    expect(handler).toHaveBeenCalledTimes(1)

    showing.value = 'convert'
    await nextTick()
    press('j')
    expect(handler).toHaveBeenCalledTimes(2)

    wrapper.unmount()
    press('j')
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
