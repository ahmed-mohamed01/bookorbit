import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import LibraryCreatorReading from '../LibraryCreatorReading.vue'

describe('LibraryCreatorReading', () => {
  it('shows and emits a finished threshold at the requested 0.05% precision', async () => {
    const wrapper = mount(LibraryCreatorReading, {
      props: { readingThreshold: 0.25, markAsFinishedPercentComplete: 99.95 },
    })

    const slider = wrapper.get<HTMLInputElement>('#finished-threshold')
    expect(slider.attributes('step')).toBe('0.05')
    expect(wrapper.get('output[for="finished-threshold"]').text()).toBe('99.95%')

    await slider.setValue('98.05')
    expect(wrapper.emitted('update:markAsFinishedPercentComplete')).toContainEqual([98.05])
  })
})
