import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissMatch, getActiveMatchScan, getMatchDismissals, getMatches, linkAllStrongMatches, linkMatch, startMatchScan } from '../../api/work'
import { filterCount, useEditionLinkMatches } from '../useEditionLinkMatches'
import { match, scanStatus } from './fixtures'

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('../../api/work', () => ({
  dismissMatch: vi.fn<(...args: unknown[]) => unknown>(),
  getActiveMatchScan: vi.fn<(...args: unknown[]) => unknown>(),
  getMatchDismissals: vi.fn<(...args: unknown[]) => unknown>(),
  getMatches: vi.fn<(...args: unknown[]) => unknown>(),
  linkAllStrongMatches: vi.fn<(...args: unknown[]) => unknown>(),
  linkMatch: vi.fn<(...args: unknown[]) => unknown>(),
  restoreMatchDismissal: vi.fn<(...args: unknown[]) => unknown>(),
  startMatchScan: vi.fn<(...args: unknown[]) => unknown>(),
  unlinkEditionBook: vi.fn<(...args: unknown[]) => unknown>(),
}))

const running = scanStatus({ state: 'running', processed: 3, finishedAt: null })

function mountComposable() {
  let links!: ReturnType<typeof useEditionLinkMatches>
  mount(
    defineComponent({
      setup() {
        links = useEditionLinkMatches()
        return () => h('div')
      },
    }),
  )
  return links
}

describe('useEditionLinkMatches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const fn of [dismissMatch, getActiveMatchScan, getMatchDismissals, getMatches, linkAllStrongMatches, linkMatch, startMatchScan]) {
      vi.mocked(fn).mockReset()
    }
    vi.mocked(getMatches).mockResolvedValue({ items: [match()], total: 1, page: 1, pageSize: 50 })
    vi.mocked(getMatchDismissals).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the active scan every two seconds and loads matches when it finishes', async () => {
    vi.mocked(startMatchScan).mockResolvedValue(running)
    vi.mocked(getActiveMatchScan).mockResolvedValueOnce(running).mockResolvedValueOnce(scanStatus())
    const links = mountComposable()

    await links.startScan(undefined)
    expect(links.scanning.value).toBe(true)

    await vi.advanceTimersByTimeAsync(2000)
    expect(getMatches).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(getActiveMatchScan).toHaveBeenCalledTimes(2)
    expect(getMatches).toHaveBeenCalledWith({ page: 1, pageSize: 50, buckets: undefined, libraryId: undefined })
    expect(links.scanFinished.value).toBe(true)
    expect(links.matches.value).toHaveLength(1)
  })

  it('asks for both buckets of the Fix filter and resets to the first page', async () => {
    const links = mountComposable()
    links.scan.value = scanStatus()
    links.page.value = 3

    await links.setFilter('fix')

    expect(getMatches).toHaveBeenCalledWith({ page: 1, pageSize: 50, buckets: ['linked_suspect', 'conflict'], libraryId: undefined })
  })

  it('sums bucket counts per filter', () => {
    const status = scanStatus()
    expect(filterCount(status, 'fix')).toBe(3)
    expect(filterCount(status, 'ready')).toBe(5)
    expect(filterCount(status, 'review')).toBe(8)
    expect(filterCount(status, 'linked')).toBe(4)
    expect(filterCount(null, 'fix')).toBe(0)
  })

  it('links a match and refreshes the counts and the ledger', async () => {
    vi.mocked(linkMatch).mockResolvedValue(undefined)
    vi.mocked(getActiveMatchScan).mockResolvedValue(scanStatus())
    const links = mountComposable()
    links.scan.value = scanStatus()

    expect(await links.link(match())).toBe(true)
    expect(linkMatch).toHaveBeenCalledWith(10)
    expect(getMatches).toHaveBeenCalled()
    expect(links.busyIds.value.size).toBe(0)
  })

  it('dismisses a match and reloads the dismissed list', async () => {
    vi.mocked(dismissMatch).mockResolvedValue(undefined)
    vi.mocked(getActiveMatchScan).mockResolvedValue(scanStatus())
    const links = mountComposable()
    links.scan.value = scanStatus()

    await links.dismiss(match())

    expect(dismissMatch).toHaveBeenCalledWith(10)
    expect(getMatchDismissals).toHaveBeenCalled()
  })

  it('returns the link-all result and null when it fails', async () => {
    vi.mocked(getActiveMatchScan).mockResolvedValue(scanStatus())
    vi.mocked(linkAllStrongMatches).mockResolvedValueOnce({ linked: 4, skipped: 1 }).mockRejectedValueOnce(new Error('boom'))
    const links = mountComposable()
    links.scan.value = scanStatus()

    expect(await links.linkAllStrong()).toEqual({ linked: 4, skipped: 1 })
    expect(await links.linkAllStrong()).toBeNull()
    expect(links.linkingAll.value).toBe(false)
  })

  it('surfaces a failed scan start', async () => {
    vi.mocked(startMatchScan).mockRejectedValue(new Error('409'))
    const links = mountComposable()

    await links.startScan(undefined)

    expect(links.error.value).toBe('Could not start the scan.')
  })
})
