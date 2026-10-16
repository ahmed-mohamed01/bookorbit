import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SelectionActionBar from './SelectionActionBar.vue'

function mountBar(slots: Record<string, string> = {}) {
  return mount(SelectionActionBar, {
    props: { count: 2, visible: true },
    slots,
    attachTo: document.body,
    global: { stubs: { Teleport: true, Transition: false } },
  })
}

describe('SelectionActionBar', () => {
  it('stays a pill without a footer', () => {
    const wrapper = mountBar()
    const container = wrapper.get('div.fixed')

    expect(container.classes()).toContain('rounded-full')
    expect(container.classes()).not.toContain('rounded-2xl')
    wrapper.unmount()
  })

  it('renders the footer slot under the actions in a rounded card', () => {
    const wrapper = mountBar({ content: '<span>row</span>', footer: '<span data-testid="footer">under</span>' })
    const container = wrapper.get('div.fixed')

    expect(container.classes()).toContain('rounded-2xl')
    expect(container.classes()).not.toContain('rounded-full')
    expect(container.get('[data-testid="footer"]').text()).toBe('under')
    wrapper.unmount()
  })
})
