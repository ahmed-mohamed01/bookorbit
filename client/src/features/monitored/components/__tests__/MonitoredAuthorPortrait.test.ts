import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { i18n } from '@/i18n'
import MonitoredAuthorPortrait from '../MonitoredAuthorPortrait.vue'

function setup(props: { imageUrl?: string | null; coverBookId?: number | null; name?: string }) {
  return mount(MonitoredAuthorPortrait, {
    props: { name: 'C. Mantis', ...props },
    global: { plugins: [i18n] },
  })
}

describe('MonitoredAuthorPortrait', () => {
  const { authorCoverFallback } = useDisplaySettings()

  afterEach(() => {
    authorCoverFallback.value = false
  })

  it('shows the portrait when there is one, whatever the cover setting', () => {
    authorCoverFallback.value = true
    const wrapper = setup({ imageUrl: '/api/v1/monitored/authors/m1/portrait', coverBookId: 5 })
    expect(wrapper.get('img').attributes('src')).toBe('/api/v1/monitored/authors/m1/portrait')
  })

  it('stands in a book cover only when the Authors page setting is on', () => {
    authorCoverFallback.value = true
    const wrapper = setup({ coverBookId: 5 })
    expect(wrapper.get('img').attributes('src')).toContain('/5/')
  })

  it('falls back to the plain gradient monogram when the setting is off', () => {
    const wrapper = setup({ coverBookId: 5 })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('CM')
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('falls back to the monogram when a portrait fails to load', async () => {
    const wrapper = setup({ imageUrl: '/api/v1/monitored/authors/m1/portrait' })
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('CM')
  })
})
