import { describe, expect, it, vi } from 'vitest'
import type { MonitoredBookEntry } from '@bookorbit/types'
import { isMonitoredBookForWork, notifyMonitoredBookCreated, onMonitoredBookCreated } from './monitored-book-state'

function entry(overrides: Partial<MonitoredBookEntry> = {}): MonitoredBookEntry {
  return {
    id: 'book-1',
    ownerUserId: 1,
    isShared: false,
    monitorAuthorId: 'author-1',
    workId: 'work-1',
    formats: ['ebook'],
    paused: false,
    addedAt: '2026-01-01',
    ...overrides,
  }
}

describe('isMonitoredBookForWork', () => {
  it('is true when an entry matches both the monitor author and the work', () => {
    expect(isMonitoredBookForWork([entry()], 'author-1', 'work-1')).toBe(true)
  })

  it('is false when the work matches but the monitor author does not', () => {
    expect(isMonitoredBookForWork([entry({ monitorAuthorId: 'author-2' })], 'author-1', 'work-1')).toBe(false)
  })

  it('is false when the monitor author matches but the work does not', () => {
    expect(isMonitoredBookForWork([entry({ workId: 'work-2' })], 'author-1', 'work-1')).toBe(false)
  })

  it('is false against an empty list', () => {
    expect(isMonitoredBookForWork([], 'author-1', 'work-1')).toBe(false)
  })
})

describe('monitored book created listeners', () => {
  it('notifies every subscribed listener', () => {
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    const unsubscribeFirst = onMonitoredBookCreated(first)
    const unsubscribeSecond = onMonitoredBookCreated(second)

    notifyMonitoredBookCreated()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  it('stops notifying a listener once it unsubscribes', () => {
    const listener = vi.fn<() => void>()
    const unsubscribe = onMonitoredBookCreated(listener)
    unsubscribe()

    notifyMonitoredBookCreated()

    expect(listener).not.toHaveBeenCalled()
  })
})
