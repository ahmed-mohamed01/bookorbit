import { describe, expect, it } from 'vitest'
import type { EditionSyncBookListItem } from '@bookorbit/types'
import { fakeT as t } from '@/features/book/lib/__tests__/sync-fixtures'
import { bookRowView, isActiveStatus, isPendingStatus, type BookRowViewContext } from '../book-row'
import { bookItem } from './list-fixtures'

const B = 'editionSync.books.'

function context(overrides: Partial<BookRowViewContext> = {}): BookRowViewContext {
  return {
    bookSyncMode: 'all_eligible',
    disabledReason: null,
    onQueueTab: false,
    pending: false,
    detailsPending: false,
    toggleOn: true,
    canToggle: true,
    ...overrides,
  }
}

function actionIds(item: EditionSyncBookListItem, overrides: Partial<BookRowViewContext> = {}): string[] {
  return bookRowView(item, context(overrides), t).actions.map((action) => action.id)
}

describe('status grouping', () => {
  it.each([
    ['queued', true, true],
    ['stale', true, true],
    ['running', false, true],
    ['failed', false, false],
    ['ready', false, false],
    ['off', false, false],
  ] as const)('%s: pending %s, active %s', (status, pending, active) => {
    expect(isPendingStatus(status)).toBe(pending)
    expect(isActiveStatus(status)).toBe(active)
  })
})

describe('bookRowView', () => {
  it('offers only Retry on a failed row', () => {
    expect(actionIds(bookItem({ status: 'failed', canRetry: true }))).toEqual(['retry'])
    expect(actionIds(bookItem({ status: 'failed', canRetry: false }))).toEqual([])
  })

  it('offers Run next on queued and out-of-date rows, and nothing on a running one', () => {
    expect(actionIds(bookItem({ status: 'queued', canRunNow: true }))).toEqual(['run', 'toggle'])
    expect(actionIds(bookItem({ status: 'stale', canRunNow: true }))).toEqual(['run', 'toggle'])
    expect(actionIds(bookItem({ status: 'queued', canRunNow: false }))).toEqual(['toggle'])
    expect(actionIds(bookItem({ status: 'running' }))).toEqual([])
  })

  it('words the toggle by its value and locks it when it cannot change', () => {
    const [off] = bookRowView(bookItem(), context({ toggleOn: false, canToggle: false }), t).actions
    expect(off).toMatchObject({ id: 'toggle', label: `${B}actions.turnOn`, disabled: true })
  })

  it('flags warning and destructive statuses as problems', () => {
    expect(bookRowView(bookItem({ status: 'failed', canRetry: true }), context(), t).problem).toBe(true)
    expect(bookRowView(bookItem({ status: 'stale' }), context(), t).problem).toBe(true)
    expect(bookRowView(bookItem({ status: 'ready' }), context(), t).problem).toBe(false)
  })

  it('leaves the queue place out of the status on the Queue tab', () => {
    const item = bookItem({ status: 'queued', queuePosition: 4 })
    expect(bookRowView(item, context(), t).status.text).toContain('4')
    expect(bookRowView(item, context({ onQueueTab: true }), t).status.text).not.toContain('4')
  })

  it('says a queued row without a place is not in the run order yet', () => {
    const details = bookRowView(bookItem({ status: 'queued', queuePosition: null }), context(), t).details
    expect(details.find((entry) => entry.key === 'placeInQueue')?.value).toBe(`${B}values.notInRunOrder`)
  })

  it('shows no details while a row waits for the re-fetch, except the progress of a running one', () => {
    const queued = bookItem({ status: 'queued', invalidatedReason: null })
    expect(bookRowView(queued, context({ detailsPending: true }), t).details).toEqual([])
    const running = bookItem({ status: 'running', stage: 'aligning', progress: 10 })
    expect(bookRowView(running, context({ detailsPending: true }), t).details.map((entry) => entry.key)).toEqual(['stage', 'progress'])
  })
})
