import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BookDetail } from '@bookorbit/types'
import BookEditionsCard from '../BookEditionsCard.vue'

const book = {
  id: 42,
  title: 'Dune',
  authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
  isbn10: null,
  isbn13: null,
  seriesName: null,
  publishedYear: 1965,
  language: 'en',
  formatPriority: [],
  files: [{ id: 1, format: 'epub', role: 'primary', filename: 'dune.epub', sizeBytes: 1000 }],
} as unknown as BookDetail

describe('BookEditionsCard edition sync', () => {
  const twoFiles = {
    ...book,
    files: [
      { id: 1, format: 'epub', role: 'primary', filename: 'dune.epub', sizeBytes: 1000 },
      { id: 2, format: 'm4b', role: 'content', filename: 'dune.m4b', sizeBytes: 3000 },
    ],
  } as unknown as BookDetail

  function mountCard(props: Record<string, unknown>, slots: Record<string, string> = {}) {
    return mount(BookEditionsCard, { props: { book: twoFiles, ...props }, slots, global: { stubs: { RouterLink: RouterLinkStub } } })
  }

  it('keeps the upstream header and footer when sync is not active', () => {
    const wrapper = mountCard({}, { 'header-action': '<span data-test="toggle" />' })

    expect(wrapper.get('h3').text()).toBe('Editions')
    expect(wrapper.find('[data-test="toggle"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('2 · ')
    expect(wrapper.text()).toMatch(/Files on disk\s*2$/)
  })

  it('counts the synced editions in the header, with the toggle slot on the right', () => {
    const wrapper = mountCard({ syncCount: 3 }, { 'header-action': '<span data-test="toggle" />' })

    expect(wrapper.get('h3').text()).toBe('Sync 3 editions')
    expect(wrapper.find('[data-test="toggle"]').exists()).toBe(true)
  })

  it('moves the total size beside the files on disk count', () => {
    const wrapper = mountCard({ syncCount: 2 })

    expect(wrapper.text()).toMatch(/Files on disk\s*2 · /)
    expect(wrapper.get('h3').element.parentElement?.textContent).not.toContain('·')
  })

  it('lists extra rows after the editions', () => {
    const wrapper = mountCard({}, { 'extra-rows': '<li data-test="extra">Read-aloud</li>' })

    const items = wrapper.findAll('ul > li')
    expect(items.at(-1)?.attributes('data-test')).toBe('extra')
  })
})
