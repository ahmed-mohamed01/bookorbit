import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { match, matchBook } from '@/features/edition-link/composables/__tests__/fixtures'
import EditionLinkLedgerRow from '../EditionLinkLedgerRow.vue'

function render(props: Record<string, unknown> = {}) {
  return mount(EditionLinkLedgerRow, {
    props: { match: match(), expanded: false, busy: false, ...props },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('EditionLinkLedgerRow', () => {
  it('shows the bucket chip, the work, the reason and the proposed link actions', () => {
    const wrapper = render()
    const text = wrapper.text()

    expect(text).toContain('Strong')
    expect(text).toContain('95%')
    expect(text).toContain('Dune')
    expect(text).toContain('title 0.95 author 1')
    expect(text).toContain('Link')
    expect(text).toContain('Not the same')
    expect(text).not.toContain('Unlink')
  })

  it('emits the match id for link and dismiss', async () => {
    const wrapper = render()
    const buttons = wrapper.findAll('button')

    await buttons.find((button) => button.text() === 'Link')!.trigger('click')
    await buttons.find((button) => button.text() === 'Not the same')!.trigger('click')

    expect(wrapper.emitted('link')).toEqual([[10]])
    expect(wrapper.emitted('dismiss')).toEqual([[10]])
  })

  it('offers relink and unlink for a suspect link', () => {
    const wrapper = render({ match: match({ bucket: 'linked_suspect', linkId: 4, proposedAction: 'relink' }) })
    const labels = wrapper.findAll('button').map((button) => button.text())

    expect(labels).toContain('Relink')
    expect(labels).toContain('Unlink')
  })

  it('offers only Unlink for a healthy link', () => {
    const wrapper = render({ match: match({ bucket: 'linked_ok', linkId: 4, proposedAction: 'none' }) })
    const labels = wrapper.findAll('button').map((button) => button.text())

    expect(labels).toContain('Unlink')
    expect(labels).not.toContain('Not the same')
  })

  it('opens the compare bench with both books and expands on the chevron', async () => {
    const wrapper = render({
      expanded: true,
      match: match({ source: matchBook({ isbn: '9780441013593', readStatus: 'want_to_read', progress: 20 }) }),
    })

    const bench = wrapper.get('[data-testid="compare-bench"]').text()
    expect(bench).toContain('9780441013593')
    expect(bench).toContain('Want to Read')
    expect(bench).toContain('Audiobooks')

    await wrapper.get('[aria-expanded]').trigger('click')
    expect(wrapper.emitted('expand')).toEqual([[10]])
  })
})
