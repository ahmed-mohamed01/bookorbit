import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SyncChainRailSwitch from '../SyncChainRailSwitch.vue'

function mountSwitch(props: Partial<InstanceType<typeof SyncChainRailSwitch>['$props']> = {}) {
  return mount(SyncChainRailSwitch, { props: { modelValue: true, tone: 'success', icon: 'link', label: 'Link', ...props } })
}

describe('SyncChainRailSwitch', () => {
  it('slides its thumb without motion when the reader asks for reduced motion', () => {
    expect(mountSwitch().get('[data-testid="sync-chain-rail-thumb"]').classes()).toContain('motion-reduce:transition-none')
  })

  it('sizes itself by the frame it sits in', () => {
    expect(mountSwitch({ size: 'spine' }).get('[role="switch"]').classes()).toEqual(expect.arrayContaining(['h-5', 'w-9']))
    expect(mountSwitch({ size: 'group' }).get('[role="switch"]').classes()).toEqual(expect.arrayContaining(['h-4', 'w-7']))
  })

  it('emits the next value and stays put while disabled', async () => {
    const wrapper = mountSwitch()
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])

    const disabled = mountSwitch({ disabled: true })
    await disabled.get('[role="switch"]').trigger('click')
    expect(disabled.emitted('update:modelValue')).toBeUndefined()
  })
})
