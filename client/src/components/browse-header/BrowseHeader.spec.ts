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

function scroller(scrollHeight: number, scrollTop: number) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { value: 500 })
  el.scrollTop = scrollTop
  return el
}

function mountWith(el: HTMLElement) {
  return mount(BrowseHeader, { props: { eyebrow: 'Browse', title: 'Watchlist', scrollContainer: el } })
}

it('does not fold when folding would leave the page too little to scroll', async () => {
  const el = scroller(560, 70)
  const wrapper = mountWith(el)
  el.dispatchEvent(new Event('scroll'))
  await wrapper.vm.$nextTick()
  expect(wrapper.find('[inert]').exists()).toBe(false)
})

it('folds once the page has plenty of scroll range', async () => {
  const el = scroller(1200, 70)
  const wrapper = mountWith(el)
  el.dispatchEvent(new Event('scroll'))
  await wrapper.vm.$nextTick()
  expect(wrapper.find('[inert]').exists()).toBe(true)
})
