import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredCardMenu from './MonitoredCardMenu.vue'

const menu = { disabled: false, label: 'Download ebook', owned: false, pending: false }

describe('MonitoredCardMenu', () => {
  it('uses the slotted button itself as the menu trigger', () => {
    const wrapper = mount(MonitoredCardMenu, {
      props: { canManage: true, canQuickView: false, ebook: menu, audiobook: menu },
      slots: { default: '<button type="button" data-testid="kebab">more</button>' },
      attachTo: document.body,
    })

    const trigger = wrapper.get('[data-testid="kebab"]')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })
})
