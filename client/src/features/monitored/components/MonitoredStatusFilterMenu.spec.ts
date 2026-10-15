import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredStatusFilter } from '@bookorbit/types'
import MonitoredStatusFilterMenu from './MonitoredStatusFilterMenu.vue'

const Menu = defineComponent({
  name: 'DropdownMenu',
  emits: ['update:open'],
  setup:
    (_props, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
const Passthrough = defineComponent({
  setup:
    (_props, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
const CheckboxItem = defineComponent({
  name: 'DropdownMenuCheckboxItem',
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue', 'select'],
  setup:
    (props, { emit, slots }) =>
    () =>
      h(
        'button',
        { type: 'button', 'data-checked': String(props.modelValue), onClick: () => emit('update:modelValue', !props.modelValue) },
        slots.default?.(),
      ),
})
const Item = defineComponent({
  name: 'DropdownMenuItem',
  emits: ['click'],
  setup:
    (_props, { emit, slots }) =>
    () =>
      h('button', { type: 'button', 'data-reset': 'true', onClick: () => emit('click') }, slots.default?.()),
})

function mountMenu(modelValue: MonitoredStatusFilter[]) {
  return mount(MonitoredStatusFilterMenu, {
    props: { modelValue },
    global: {
      stubs: {
        DropdownMenu: Menu,
        DropdownMenuTrigger: Passthrough,
        DropdownMenuContent: Passthrough,
        DropdownMenuLabel: Passthrough,
        DropdownMenuSeparator: true,
        DropdownMenuCheckboxItem: CheckboxItem,
        DropdownMenuItem: Item,
      },
    },
  })
}

function setOpen(wrapper: ReturnType<typeof mountMenu>, open: boolean) {
  wrapper.getComponent(Menu).vm.$emit('update:open', open)
}

describe('MonitoredStatusFilterMenu', () => {
  it('does not reload the list on each tick, only once when the menu closes', async () => {
    const wrapper = mountMenu(['missing', 'in_progress', 'needs_attention', 'upcoming'])
    setOpen(wrapper, true)

    const boxes = wrapper.findAll('[data-checked]')
    await boxes[0]!.trigger('click')
    await boxes[1]!.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    setOpen(wrapper, false)
    expect(wrapper.emitted('update:modelValue')).toEqual([[['needs_attention', 'upcoming']]])
    wrapper.unmount()
  })

  it('says nothing when the menu closes with the selection it opened with', async () => {
    const wrapper = mountMenu(['missing', 'upcoming'])
    setOpen(wrapper, true)
    const boxes = wrapper.findAll('[data-checked]')
    await boxes[2]!.trigger('click')
    await boxes[2]!.trigger('click')

    setOpen(wrapper, false)

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('applies the default selection when reset is chosen and the menu closes', async () => {
    const wrapper = mountMenu(['missing'])
    setOpen(wrapper, true)

    await wrapper.get('[data-reset]').trigger('click')
    setOpen(wrapper, false)

    expect(wrapper.emitted('update:modelValue')).toEqual([[['missing', 'in_progress', 'needs_attention', 'upcoming']]])
    wrapper.unmount()
  })
})
