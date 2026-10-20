import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import BrowseHeader from './BrowseHeader.vue'

it('renders persistent tabs before the command bar', () => {
  const wrapper = mount(BrowseHeader, {
    props: { eyebrow: 'Browse', title: 'Watchlist' },
    slots: { tabs: '<nav data-testid="tabs">Tabs</nav>', bar: '<input data-testid="search" />' },
  })
  expect(wrapper.html().indexOf('data-testid="tabs"')).toBeLessThan(wrapper.html().indexOf('data-testid="search"'))
})
