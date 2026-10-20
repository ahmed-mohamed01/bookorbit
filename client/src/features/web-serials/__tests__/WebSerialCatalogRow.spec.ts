import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WebSerialCatalogRow from '../components/WebSerialCatalogRow.vue'
import { catalogEntry } from './fixtures'

it.each([true, false])('shows Published for novels in print in compact=%s', (compact) => {
  const wrapper = mount(WebSerialCatalogRow, {
    props: {
      density: compact ? 'compact' : 'comfortable',
      entry: catalogEntry({ kind: 'novel', publication: { licensed: true, finalVolume: 2, publishers: [] } }),
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).toContain('Published')
})
it('does not show Published for manga', () => {
  const wrapper = mount(WebSerialCatalogRow, {
    props: { entry: catalogEntry({ publication: { licensed: true, finalVolume: 2, publishers: [] } }) },
    global: { plugins: [i18n] },
  })
  expect(wrapper.text()).not.toContain('Published')
})
