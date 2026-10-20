import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnOtherFormats.vue'

it('renders other formats without duplicating the sheet web sources disclosure', () => {
  const wrapper = mount(Component, { props: { releases: [] }, global: { plugins: [i18n] } })
  expect(wrapper.text()).toContain('Other formats of this series')
  expect(wrapper.find('summary').exists()).toBe(false)
})
