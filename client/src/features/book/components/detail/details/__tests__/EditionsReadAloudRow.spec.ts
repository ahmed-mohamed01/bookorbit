import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { ReadAloudCreateSlot } from '@/features/book/lib/read-aloud-row'
import EditionsReadAloudRow from '../EditionsReadAloudRow.vue'

function slot(overrides: Partial<ReadAloudCreateSlot> = {}): ReadAloudCreateSlot {
  return { entry: { kind: 'available' }, job: null, pending: null, errorKey: null, ...overrides }
}

const processing = {
  status: 'processing' as const,
  stage: 'aligning',
  progress: 42,
  queuePosition: null,
  stopping: false,
  canCancel: true,
  canRetry: true,
  errorKey: null,
}

function mountRow(state: ReadAloudCreateSlot, viaIndex?: boolean) {
  return mount(EditionsReadAloudRow, { attachTo: document.body, props: { state, viaIndex } })
}

function dropdown(): HTMLElement | null {
  return document.body.querySelector('[data-testid="sync-issue-content"]')
}

describe('EditionsReadAloudRow', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing when upstream hides the generator', () => {
    expect(
      mountRow(slot({ entry: { kind: 'hidden' } }))
        .find('[data-testid="editions-read-aloud-row"]')
        .exists(),
    ).toBe(false)
  })

  it('shows only the dashed chip and a Create split button until something happens', async () => {
    const wrapper = mountRow(slot())
    expect(wrapper.text()).toContain('Read-aloud')
    expect(wrapper.find('[data-testid="editions-read-aloud-status"]').exists()).toBe(false)
    await wrapper.get('[data-testid="editions-read-aloud-create"]').trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.get('[data-testid="editions-read-aloud-more"]').attributes('aria-label')).toBe('More create options')
  })

  it('locks Create while a start is in flight', () => {
    const wrapper = mountRow(slot({ pending: 'create' }))
    expect(wrapper.get('[data-testid="editions-read-aloud-create"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="editions-read-aloud-create"] svg.animate-spin').exists()).toBe(true)
  })

  it('spins while a job runs and cancels it from the clock dropdown', async () => {
    const wrapper = mountRow(slot({ job: processing }))
    expect(wrapper.find('[data-testid="editions-read-aloud-create"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="editions-read-aloud-status"]').text()).toMatch(/· 42\s?%$/)
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('retries a failed job from its dropdown', async () => {
    const wrapper = mountRow(slot({ job: { ...processing, status: 'failed', errorKey: 'book.detail.files.readAloud.errors.job.alignment_failed' } }))
    expect(wrapper.get('[data-testid="editions-read-aloud-status"]').text()).toBe("Couldn't create")
    const status = wrapper.get('[data-testid="editions-read-aloud-status"]')
    expect(status.classes()).toContain('text-destructive')
    expect(status.element.nextElementSibling?.getAttribute('data-testid')).toBe('sync-issue-trigger')
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('offers Review for a job waiting for review', async () => {
    const wrapper = mountRow(slot({ job: { ...processing, status: 'awaiting_review' } }))
    expect(wrapper.get('[data-testid="editions-read-aloud-status"]').text()).toBe('Ready to review')
    await wrapper.get('[data-testid="editions-read-aloud-review"]').trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })

  describe('read along from the timing index', () => {
    const viaIndex = '[data-testid="editions-read-aloud-via-index"]'
    const status = '[data-testid="editions-read-aloud-status"]'
    const errorKey = 'book.detail.files.readAloud.errors.job.alignment_failed'
    const unavailable = { kind: 'unavailable' as const, reason: null, reasonKey: 'book.detail.editionLink.readAloud.unavailable' }

    it('says so when upstream hides the generator', () => {
      const wrapper = mountRow(slot({ entry: { kind: 'hidden' } }), true)
      expect(wrapper.get(viaIndex).text()).toBe('Available via index')
      expect(wrapper.get('[data-testid="editions-read-aloud-row"]').attributes('data-variant')).toBe('viaIndex')
    })

    it('says so beside Create for a book with no read-along yet', () => {
      const wrapper = mountRow(slot(), true)
      expect(wrapper.get(viaIndex).text()).toBe('Available via index')
      expect(wrapper.find('[data-testid="editions-read-aloud-create"]').exists()).toBe(true)
    })

    it('shows a failed Create instead', () => {
      const wrapper = mountRow(slot({ errorKey }), true)
      expect(wrapper.find(viaIndex).exists()).toBe(false)
      expect(wrapper.get(status).text()).toBe("Couldn't create")
    })

    it('shows a failed Create on a row the generator cannot run on instead', () => {
      const wrapper = mountRow(slot({ entry: unavailable, errorKey }), true)
      expect(wrapper.find(viaIndex).exists()).toBe(false)
      expect(wrapper.find(status).exists()).toBe(true)
      expect(wrapper.find('[data-testid="sync-issue-trigger"]').exists()).toBe(true)
    })

    it('shows a running job instead', () => {
      const wrapper = mountRow(slot({ job: processing }), true)
      expect(wrapper.find(viaIndex).exists()).toBe(false)
      expect(wrapper.get(status).text()).toMatch(/· 42\s?%$/)
    })

    it('is not mentioned without the index', () => {
      expect(
        mountRow(slot({ entry: { kind: 'hidden' } }), false)
          .find('[data-testid="editions-read-aloud-row"]')
          .exists(),
      ).toBe(false)
      expect(mountRow(slot(), false).find(viaIndex).exists()).toBe(false)
    })
  })
})
