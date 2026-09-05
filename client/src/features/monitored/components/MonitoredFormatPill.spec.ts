import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitoredFormatPill from './MonitoredFormatPill.vue'

describe('MonitoredFormatPill', () => {
  it('uses the ebook semantic token and localized label', () => {
    const wrapper = mount(MonitoredFormatPill, { props: { format: 'ebook' } })

    expect(wrapper.text()).toBe('Ebook')
    expect(wrapper.get('span').classes()).toContain('text-[var(--pill-info)]')
  })

  it('uses the audiobook semantic token and accepts a progress value', () => {
    const wrapper = mount(MonitoredFormatPill, { props: { format: 'audiobook', value: '12/20' } })

    expect(wrapper.text()).toBe('12/20')
    expect(wrapper.get('span').classes()).toContain('text-[var(--pill-koreader)]')
  })

  it('uses the muted treatment when a format is disabled', () => {
    const wrapper = mount(MonitoredFormatPill, { props: { format: 'audiobook', value: 'Audiobook off', muted: true } })

    expect(wrapper.get('span').classes()).toContain('text-muted-foreground')
  })
})
