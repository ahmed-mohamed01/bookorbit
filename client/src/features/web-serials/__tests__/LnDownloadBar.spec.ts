import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnDownloadBar.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const wrapper = mount(Component, { props: { volumeCount: 0, releaseCount: 0, sizeBytes: 0, canSend: true }, global: { plugins: [i18n] } })
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ volumeCount: 3, releaseCount: 2 })
  expect(wrapper.text()).toContain('3 volumes from 2 releases')
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('download')).toHaveLength(1)
})
