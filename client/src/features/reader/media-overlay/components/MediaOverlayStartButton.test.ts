import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import MediaOverlayStartButton from './MediaOverlayStartButton.vue'

enableAutoUnmount(afterEach)

describe('MediaOverlayStartButton', () => {
  it('renders nothing while hidden', () => {
    const wrapper = mount(MediaOverlayStartButton, { props: { visible: false } })

    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('asks the reader to start narration', async () => {
    const wrapper = mount(MediaOverlayStartButton, { props: { visible: true } })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('start')).toHaveLength(1)
  })
})
