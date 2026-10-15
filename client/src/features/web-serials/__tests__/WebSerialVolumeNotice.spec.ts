import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WebSerialVolumeNotice from '../components/preview/WebSerialVolumeNotice.vue'
import type { VolumePackagingNotice } from '../lib/serialSelection'
import { unit } from './fixtures'

const notice = (overrides: Partial<VolumePackagingNotice> = {}): VolumePackagingNotice => ({
  volumes: 12,
  outsideVolumes: Array.from({ length: 14 }, (_unused, index) => unit(String(1180 + index))),
  partialVolumes: [],
  snappedRange: null,
  ...overrides,
})

function mountNotice(value: VolumePackagingNotice, singleChapters = 14) {
  return mount(WebSerialVolumeNotice, { props: { notice: value, singleChapters }, global: { plugins: [i18n] } })
}

describe('WebSerialVolumeNotice', () => {
  it('summarises volumes and single chapters and says which chapters are outside volumes', async () => {
    const wrapper = mountNotice(notice())
    expect(wrapper.get('[data-testid="volume-notice-summary"]').text()).toBe('12 volumes, 14 single chapters')
    expect(wrapper.get('[data-testid="volume-notice-outside"]').text()).toContain(
      '14 chapters are not in a volume yet and will download as separate chapters',
    )
    expect(wrapper.find('[data-testid="volume-notice-list"]').exists()).toBe(false)
    await wrapper.get('[data-testid="volume-notice-outside"] button').trigger('click')
    expect(wrapper.findAll('[data-testid="volume-notice-list"] li')).toHaveLength(14)
  })

  it('bounds the expanded list', async () => {
    const many = Array.from({ length: 80 }, (_unused, index) => unit(String(index + 1)))
    const wrapper = mountNotice(notice({ outsideVolumes: many }), 80)
    await wrapper.get('[data-testid="volume-notice-outside"] button').trigger('click')
    const items = wrapper.findAll('[data-testid="volume-notice-list"] li')
    expect(items).toHaveLength(51)
    expect(items[50]!.text()).toBe('and 30 more')
  })

  it('names partly selected volumes and a widened range', () => {
    const wrapper = mountNotice(
      notice({
        outsideVolumes: [],
        partialVolumes: [{ volume: '105', selected: 2, total: 4 }],
        snappedRange: { fromSequence: '1071', toSequence: '1193' },
      }),
      2,
    )
    expect(wrapper.find('[data-testid="volume-notice-outside"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="volume-notice-partial"]').text()).toBe(
      'Volume 105 is only partly selected; its chapters will download separately.',
    )
    expect(wrapper.get('[data-testid="volume-notice-snapped"]').text()).toBe(
      'The range was extended to chapters 1071 to 1193 so that whole volumes are downloaded.',
    )
  })
})
