import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BookDetail } from '@bookorbit/types'

import { variant, work } from '@/features/edition-link/composables/__tests__/fixtures'
import BookEditionsCard from '../BookEditionsCard.vue'

const book = {
  id: 1,
  title: 'Dune',
  formatPriority: [],
  audioMetadata: null,
  files: [{ id: 1, format: 'epub', role: 'primary', filename: 'dune.epub', sizeBytes: 1000 }],
} as unknown as BookDetail

function render(props: Record<string, unknown> = {}) {
  return mount(BookEditionsCard, {
    props: { book, ...props },
    slots: { missing: '<p data-testid="missing">No audiobook yet</p>' },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('BookEditionsCard work variants', () => {
  it('keeps the plain card when there is no work', () => {
    const wrapper = render()

    expect(wrapper.findAll('[data-testid="work-variant-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="work-footer"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="missing"]').exists()).toBe(true)
  })

  it('lists other variants under a divider with library and source, and counts libraries', () => {
    const wrapper = render({ work: work() })
    const text = wrapper.text()

    expect(text).toContain('same work in other libraries')
    expect(text).toContain('2 · 2 libraries')
    const row = wrapper.get('[data-testid="work-variant-row"]')
    expect(row.text()).toContain('M4B')
    expect(row.text()).toContain('2h 0m')
    expect(row.text()).toContain('42%')
    expect(row.text()).toContain('Audiobooks')
    expect(row.text()).toContain('mirrored')
  })

  it('hides the missing-format request once the work has an audiobook', () => {
    expect(render({ work: work() }).find('[data-testid="missing"]').exists()).toBe(false)
    const ebooksOnly = work({ variants: [variant({ isThisBook: true }), variant({ bookId: 3, libraryName: 'Archive' })] })
    expect(render({ work: ebooksOnly }).find('[data-testid="missing"]').exists()).toBe(true)
  })

  it('labels a same-role variant as a duplicate of this copy', () => {
    const duplicate = work({
      variants: [variant({ isThisBook: true }), variant({ bookId: 3, isPrimary: false, libraryName: 'Archive', formats: ['mobi'] })],
    })

    expect(render({ work: duplicate }).get('[data-testid="work-variant-row"]').text()).toContain('duplicate of this copy')
  })

  it('shows the sync state in the footer and emits manage', async () => {
    const wrapper = render({ work: work() })
    expect(wrapper.get('[data-testid="work-footer"]').text()).toContain('One work · in sync')

    await wrapper.get('[data-testid="work-footer"] button').trigger('click')
    expect(wrapper.emitted('manageWork')).toHaveLength(1)

    expect(render({ work: work({ inSync: false }) }).text()).toContain('One work · catching up')
    expect(render({ work: work({ sharedState: false }) }).text()).toContain('Shared state off')
  })

  it('offers Generate read-along only when allowed and emits on click', async () => {
    expect(render({ work: work() }).text()).not.toContain('Generate read-along')

    const wrapper = render({ work: work({ canGenerateReadAlong: true }), canGenerateReadAlong: true })
    const button = wrapper.findAll('button').find((entry) => entry.text() === 'Generate read-along')!
    await button.trigger('click')

    expect(wrapper.emitted('generateReadAlong')).toHaveLength(1)
  })
})
