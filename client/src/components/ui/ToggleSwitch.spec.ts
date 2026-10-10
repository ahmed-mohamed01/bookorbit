import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToggleSwitch from './ToggleSwitch.vue'

describe('ToggleSwitch', () => {
  it('keeps the thumb contained at logical track positions', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false } })
    const track = wrapper.get('[role="switch"]')
    const thumb = track.get('span')

    expect(track.classes()).toContain('overflow-hidden')
    expect(thumb.classes()).toEqual(expect.arrayContaining(['absolute', 'start-0']))
    expect(track.attributes('aria-checked')).toBe('false')

    await wrapper.setProps({ modelValue: true })

    expect(thumb.classes()).toContain('start-4')
    expect(thumb.classes()).not.toContain('start-0')
    expect(track.attributes('aria-checked')).toBe('true')
  })

  it('keeps the primary track without a tone and takes the tone colour only while checked', async () => {
    const plain = mount(ToggleSwitch, { props: { modelValue: true } })
    expect(plain.get('[role="switch"]').classes()).toContain('bg-primary')

    const toned = mount(ToggleSwitch, { props: { modelValue: true, tone: 'warning' } })
    expect(toned.get('[role="switch"]').classes()).toContain('bg-warning')

    await toned.setProps({ modelValue: false })
    expect(toned.get('[role="switch"]').classes()).toContain('bg-muted')
  })

  it('emits the next checked state when clicked', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false } })

    await wrapper.get('[role="switch"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })
})
