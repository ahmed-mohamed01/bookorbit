import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import BrowseHeader from './BrowseHeader.vue'

const stubs = { AppIcon: true, PageMenuButton: true, BrowseTitleSwitcher: { template: '<span data-testid="switcher" />' } }

function scroller(top: number) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top })
  Object.defineProperty(el, 'scrollHeight', { value: 2000 })
  Object.defineProperty(el, 'clientHeight', { value: 500 })
  return el
}

describe('BrowseHeader', () => {
  it('lets a page supply its own eyebrow and title in place of the defaults', () => {
    const wrapper = mount(BrowseHeader, {
      props: { eyebrow: 'Browse', title: 'Fantasy', switcher: { kind: 'library', id: 1 } },
      slots: { eyebrow: '<a data-testid="eyebrow">Genres</a>', title: '<button data-testid="title">Fantasy</button>' },
      global: { stubs },
    })

    expect(wrapper.get('[data-testid="eyebrow"]').text()).toBe('Genres')
    expect(wrapper.get('[data-testid="title"]').text()).toBe('Fantasy')
    expect(wrapper.find('[data-testid="switcher"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Browse')
  })

  it('keeps the place switcher when no title is supplied', () => {
    const wrapper = mount(BrowseHeader, {
      props: { eyebrow: 'Library', title: 'Novels', switcher: { kind: 'library', id: 1 } },
      global: { stubs },
    })

    expect(wrapper.find('[data-testid="switcher"]').exists()).toBe(true)
  })

  it('renders the strip below the title and folds it away with the title row', async () => {
    const el = scroller(0)
    const wrapper = mount(BrowseHeader, {
      props: { eyebrow: 'Genres', title: 'Fantasy', scrollContainer: el },
      slots: { below: '<div data-testid="strip">Similar names</div>' },
      global: { stubs },
    })
    const strip = wrapper.get('[data-testid="strip"]')
    const fold = strip.element.parentElement!.parentElement!

    expect(fold.hasAttribute('inert')).toBe(false)

    el.scrollTop = 200
    el.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(fold.hasAttribute('inert')).toBe(true)
    expect(fold.className).toContain('grid-rows-[0fr]')
  })

  it('leaves no strip wrapper when a page has nothing below its title', () => {
    const wrapper = mount(BrowseHeader, { props: { eyebrow: 'Library', title: 'Novels' }, global: { stubs } })

    expect(wrapper.findAll('header > div.grid')).toHaveLength(1)
  })
})

describe('BrowseHeader fork tabs and fold guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function sizedScroller(scrollHeight: number, scrollTop: number) {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { value: 500 })
    el.scrollTop = scrollTop
    return el
  }

  function mountWith(el: HTMLElement, slots: Record<string, string> = {}) {
    return mount(BrowseHeader, { props: { eyebrow: 'Browse', title: 'Watchlist', scrollContainer: el }, slots, global: { stubs } })
  }

  it('renders persistent tabs before the command bar', () => {
    const wrapper = mount(BrowseHeader, {
      props: { eyebrow: 'Browse', title: 'Watchlist' },
      slots: { tabs: '<nav data-testid="tabs">Tabs</nav>', bar: '<input data-testid="search" />' },
      global: { stubs },
    })
    expect(wrapper.html().indexOf('data-testid="tabs"')).toBeLessThan(wrapper.html().indexOf('data-testid="search"'))
  })

  it('does not fold when folding would leave the page too little to scroll', async () => {
    const el = sizedScroller(560, 70)
    const wrapper = mountWith(el)
    el.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[inert]').exists()).toBe(false)
  })

  it('folds once the page has plenty of scroll range', async () => {
    const el = sizedScroller(1200, 70)
    const wrapper = mountWith(el)
    el.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[inert]').exists()).toBe(true)
  })

  it('counts the strip below the title in the range folding takes away', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)
    const withoutStrip = sizedScroller(666, 0)
    const plain = mountWith(withoutStrip)
    withoutStrip.scrollTop = 70
    withoutStrip.dispatchEvent(new Event('scroll'))
    await plain.vm.$nextTick()
    expect(plain.find('[inert]').exists()).toBe(true)

    const withStrip = sizedScroller(666, 0)
    const stripped = mountWith(withStrip, { below: '<div>Similar names</div>' })
    withStrip.scrollTop = 70
    withStrip.dispatchEvent(new Event('scroll'))
    await stripped.vm.$nextTick()
    expect(stripped.find('[inert]').exists()).toBe(false)
  })
})
