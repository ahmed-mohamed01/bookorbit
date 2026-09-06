import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { BookRequestItem, MonitoredWorkReleasesResponse, ReleaseCandidateItem } from '@bookorbit/types'
import { grabWorkRelease, searchWorkReleases } from '../api/monitored'
import { useMonitoredReleases } from './useMonitoredReleases'

vi.mock('../api/monitored', () => ({
  grabWorkRelease: vi.fn<() => Promise<BookRequestItem>>(),
  searchWorkReleases: vi.fn<() => Promise<MonitoredWorkReleasesResponse>>(),
}))

const grabMock = vi.mocked(grabWorkRelease)
const searchMock = vi.mocked(searchWorkReleases)
const release = { guid: 'release-1', indexerId: 7 } as ReleaseCandidateItem

function request(id: number): BookRequestItem {
  return { id } as BookRequestItem
}

function mountComposable(workId = ref<string | null>('work-1')) {
  let composable!: ReturnType<typeof useMonitoredReleases>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useMonitoredReleases(workId, 'ebook')
        return () => null
      },
    }),
  )
  return { composable, wrapper, workId }
}

describe('useMonitoredReleases grab', () => {
  beforeEach(() => {
    grabMock.mockReset()
    searchMock.mockReset()
  })

  it('resolves to the id of the book request the download runs under', async () => {
    grabMock.mockResolvedValueOnce(request(4242))
    const { composable, wrapper } = mountComposable()

    await expect(composable.grab(release)).resolves.toBe(4242)
    expect(composable.isGrabbed(release)).toBe(true)
    wrapper.unmount()
  })

  it('resolves to null when the grab fails, leaving the release ungrabbed', async () => {
    grabMock.mockRejectedValueOnce(new Error('nope'))
    const { composable, wrapper } = mountComposable()

    await expect(composable.grab(release)).resolves.toBeNull()
    expect(composable.isGrabbed(release)).toBe(false)
    wrapper.unmount()
  })

  it('ignores a second click while the first grab is still in flight', async () => {
    let settle = () => {}
    grabMock.mockImplementation(() => new Promise<BookRequestItem>((resolve) => (settle = () => resolve(request(1)))))
    const { composable, wrapper } = mountComposable()

    const first = composable.grab(release)
    const second = composable.grab(release)

    expect(composable.isGrabbing(release)).toBe(true)
    settle()
    await Promise.all([first, second])

    expect(grabMock).toHaveBeenCalledTimes(1)
    expect(composable.isGrabbing(release)).toBe(false)
    wrapper.unmount()
  })

  it('keeps a settling grab from writing into the work the panel moved on to', async () => {
    let reject: (reason: Error) => void = () => {}
    grabMock.mockImplementationOnce(() => new Promise<BookRequestItem>((_resolve, settle) => (reject = settle)))
    const { composable, wrapper, workId } = mountComposable()

    const pending = composable.grab(release)
    workId.value = 'work-2'
    reject(new Error('too late'))
    await pending

    // The failure belonged to work-1, so work-2's panel must stay clean.
    expect(composable.error.value).toBeNull()
    // And work-1's marker must not gate the same release under work-2.
    expect(composable.isGrabbing(release)).toBe(false)

    grabMock.mockResolvedValueOnce(request(2))
    await composable.grab(release)
    expect(grabMock).toHaveBeenCalledTimes(2)
    expect(grabMock).toHaveBeenLastCalledWith('work-2', { format: 'ebook', indexerId: 7, releaseGuid: 'release-1' })
    wrapper.unmount()
  })

  it('does not let a settling grab clear the in-flight marker of a newer work', async () => {
    let finishFirst = () => {}
    grabMock.mockImplementationOnce(() => new Promise<BookRequestItem>((resolve) => (finishFirst = () => resolve(request(1)))))
    const { composable, wrapper, workId } = mountComposable()

    const first = composable.grab(release)
    workId.value = 'work-2'

    grabMock.mockImplementationOnce(() => new Promise<BookRequestItem>(() => {}))
    void composable.grab(release)
    expect(composable.isGrabbing(release)).toBe(true)

    finishFirst()
    await first

    // work-2's grab is still running, so its button stays disabled.
    expect(composable.isGrabbing(release)).toBe(true)
    wrapper.unmount()
  })

  it('releases the guard after a failure so the grab can be retried', async () => {
    grabMock.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(request(3))
    const { composable, wrapper } = mountComposable()

    await composable.grab(release)
    expect(composable.isGrabbing(release)).toBe(false)
    expect(composable.error.value).toBe('Failed to grab this release.')

    await composable.grab(release)
    expect(grabMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('lets a searched-again release be grabbed after its request was deleted', async () => {
    grabMock.mockResolvedValueOnce(request(4242))
    searchMock.mockResolvedValueOnce({ releases: [release], enabledIndexerCount: 1 } as MonitoredWorkReleasesResponse)
    const { composable, wrapper } = mountComposable()

    await composable.grab(release)
    expect(composable.isGrabbed(release)).toBe(true)

    await composable.search()

    expect(composable.isGrabbed(release)).toBe(false)
    wrapper.unmount()
  })
})
