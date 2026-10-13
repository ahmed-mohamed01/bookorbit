import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MergeStrategySegmented from './MergeStrategySegmented.vue'

describe('MergeStrategySegmented', () => {
  it('offers merge-with-existing only for genre fields', async () => {
    const standard = mount(MergeStrategySegmented, { props: { modelValue: 'fillMissing', field: 'title' } })
    const genres = mount(MergeStrategySegmented, {
      props: { modelValue: 'mergeExisting', field: 'genres' },
    })

    expect(standard.findAll('[role="radio"]')).toHaveLength(3)
    expect(standard.text()).not.toContain('Merge')
    expect(genres.findAll('[role="radio"]')).toHaveLength(4)
    expect(genres.text()).toContain('Merge')

    await genres.findAll('[role="radio"]')[2]!.trigger('click')
    expect(genres.emitted('update:modelValue')).toEqual([['overwriteIfProvided']])
  })

  it('offers only additive strategies for other series', () => {
    const otherSeries = mount(MergeStrategySegmented, { props: { modelValue: 'mergeExisting', field: 'otherSeries' } })

    const radios = otherSeries.findAll('[role="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'true'])
  })
})
