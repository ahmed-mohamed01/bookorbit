import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { BookDetail, ReadAloudProgressSync } from '@bookorbit/types'
import { editionSyncState, readAloudSync } from '@/features/book/lib/__tests__/sync-fixtures'
import EditionSyncHeaderStatus from '../EditionSyncHeaderStatus.vue'

type Props = InstanceType<typeof EditionSyncHeaderStatus>['$props']

function book(sync: Partial<ReadAloudProgressSync> = {}, formats: string[] = ['m4b', 'epub']): BookDetail {
  return {
    id: 7,
    files: formats.map((key, index) => {
      const format = key.split(':')[0]
      const mediaOverlay = key.endsWith(':readalong') ? { available: true } : null
      return { id: index + 1, format, role: 'content', sizeBytes: 1, filename: `b${index}.${format}`, mediaOverlay }
    }),
    formatPriority: [],
    readAloudSync: readAloudSync(sync),
  } as unknown as BookDetail
}

function mountStatus(props: Partial<Props>) {
  return mount(EditionSyncHeaderStatus, {
    attachTo: document.body,
    props: { book: book(), kind: 'index', state: editionSyncState(), checked: true, ...props } as Props,
  })
}

function dropdown(): HTMLElement | null {
  return document.body.querySelector('[data-testid="sync-issue-content"]')
}

describe('EditionSyncHeaderStatus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing without a toggle', () => {
    expect(mountStatus({ kind: 'none' }).find('[data-testid="edition-sync-header-status"]').exists()).toBe(false)
  })

  it('shows Synced and Off as plain text', () => {
    const synced = mountStatus({})
    expect(synced.get('[data-testid="edition-sync-header-text"]').text()).toBe('Synced')
    expect(synced.get('[data-testid="edition-sync-header-text"]').classes()).toContain('text-muted-foreground')
    expect(synced.find('[data-testid="sync-issue-trigger"]').exists()).toBe(false)
    expect(mountStatus({ checked: false }).get('[data-testid="edition-sync-header-text"]').text()).toBe('Off')
  })

  it('spins while indexing', () => {
    const wrapper = mountStatus({ state: editionSyncState({ status: 'running', stage: 'aligning', progress: 42 }) })
    expect(wrapper.find('svg.animate-spin').exists()).toBe(true)
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').text()).toMatch(/· 42\s?%$/)
  })

  it('shows a failure as its text followed by an icon whose dropdown retries indexing', async () => {
    const wrapper = mountStatus({ state: editionSyncState({ status: 'failed', error: 'No audio stream found in chapter 12.' }) })
    const text = wrapper.get('[data-testid="edition-sync-header-text"]')
    expect(text.text()).toBe("Couldn't index")
    expect(text.classes()).toContain('text-destructive')
    const trigger = wrapper.get('[data-testid="sync-issue-trigger"]')
    expect(trigger.attributes('aria-label')).toBe("Couldn't index")

    await trigger.trigger('click')
    await flushPromises()
    expect(dropdown()?.textContent).toContain('No audio stream found in chapter 12.')
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('keeps the queued text beside a clock whose dropdown runs now', async () => {
    const wrapper = mountStatus({ state: editionSyncState({ status: 'queued', queuePosition: 2 }) })
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').text()).toBe('Queued #2')
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    dropdown()?.querySelector<HTMLButtonElement>('[data-action="run"]')?.click()
    await flushPromises()
    expect(wrapper.emitted('run')).toHaveLength(1)
  })

  it('names a read-aloud duration mismatch and explains it with both durations', async () => {
    const wrapper = mountStatus({
      kind: 'readAlong',
      book: book({ state: 'unavailable', unavailableReason: 'duration_mismatch', audioDurationSeconds: 31_680, overlayDurationSeconds: 31_260 }),
    })
    await wrapper.get('[data-testid="sync-issue-trigger"]').trigger('click')
    await flushPromises()
    expect(dropdown()?.textContent).toContain('Durations differ')
    expect(dropdown()?.textContent).toContain('audiobook 8h 48m, read-aloud EPUB 8h 41m')
  })

  it('reads EPUB only when a plain EPUB still syncs with the read-along', () => {
    const wrapper = mountStatus({
      kind: 'readAlong',
      book: book({ state: 'unavailable', unavailableReason: 'duration_mismatch' }, ['m4b', 'epub', 'epub:readalong']),
    })
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').text()).toBe('EPUB only')
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').classes()).toContain('text-warning')
    expect(wrapper.get('[data-testid="sync-issue-trigger"]').attributes('aria-label')).toBe('EPUB only')
  })

  it('renders the read-along status without any edition sync state', () => {
    const wrapper = mountStatus({ kind: 'readAlong', state: null, book: book({}, ['m4b', 'epub:readalong']) })
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').text()).toBe('Synced')
  })

  it('reads EPUB copies only as synced for an ebook and read-along without audio', () => {
    const wrapper = mountStatus({
      kind: 'readAlong',
      state: null,
      book: book({ state: 'unavailable', unavailableReason: 'no_audio_files' }, ['epub', 'epub:readalong']),
    })
    expect(wrapper.get('[data-testid="edition-sync-header-text"]').text()).toBe('EPUB copies only')
    expect(wrapper.find('[data-testid="sync-issue-trigger"]').exists()).toBe(false)
  })

  it('always puts the describing id on the text, never on the icon', () => {
    const text = mountStatus({ describedById: 'status-x' })
    expect(text.get('[data-testid="edition-sync-header-text"]').attributes('id')).toBe('status-x')
    const icon = mountStatus({ describedById: 'status-y', state: editionSyncState({ status: 'failed', error: 'x' }) })
    expect(icon.get('[data-testid="edition-sync-header-text"]').attributes('id')).toBe('status-y')
    expect(icon.get('[data-testid="sync-issue-trigger"]').attributes('id')).toBeUndefined()
    const clock = mountStatus({ describedById: 'status-z', state: editionSyncState({ status: 'queued', queuePosition: 2 }) })
    expect(clock.get('[data-testid="edition-sync-header-text"]').attributes('id')).toBe('status-z')
    expect(clock.get('[data-testid="sync-issue-trigger"]').attributes('id')).toBeUndefined()
  })
})
