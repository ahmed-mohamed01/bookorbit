import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type {
  BookRequestItem,
  DownloadDelivery,
  IndexerSearchStatus,
  MonitoredFormat,
  MonitoredWorkReleasesResponse,
  ReleaseCandidateItem,
  ReleaseSearchProgress,
} from '@bookorbit/types'
import { grabWorkRelease, streamWorkReleases } from '../api/monitored'
import { useMonitoredReleases } from './useMonitoredReleases'

vi.mock('../api/monitored', () => ({
  grabWorkRelease: vi.fn<() => Promise<BookRequestItem>>(),
  streamWorkReleases:
    vi.fn<
      (
        workId: string,
        format: MonitoredFormat,
        onProgress: (progress: ReleaseSearchProgress) => void,
        signal?: AbortSignal,
      ) => Promise<MonitoredWorkReleasesResponse>
    >(),
}))

const grabMock = vi.mocked(grabWorkRelease)
const searchMock = vi.mocked(streamWorkReleases)
const release = { guid: 'release-1', indexerId: 7, seeders: null } as ReleaseCandidateItem

function request(id: number): BookRequestItem {
  return { id } as BookRequestItem
}

function indexerStatus(indexerId: number, delivery: DownloadDelivery): IndexerSearchStatus {
  return { indexerId, delivery, seedsBack: delivery === 'torrent' } as IndexerSearchStatus
}

function searchResult(indexers: IndexerSearchStatus[]): MonitoredWorkReleasesResponse {
  return { releases: [release], indexers, enabledIndexerCount: indexers.length } as MonitoredWorkReleasesResponse
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

  it('keeps the searched list when a grab fails and clears the failure on the next search', async () => {
    searchMock.mockResolvedValue(searchResult([indexerStatus(7, 'torrent')]))
    grabMock.mockRejectedValueOnce(new Error('nope'))
    const { composable, wrapper } = mountComposable()

    await composable.search()
    await composable.grab(release)

    expect(composable.grabError.value).toBe('Failed to grab this release.')
    expect(composable.error.value).toBeNull()
    expect(composable.releases.value).toHaveLength(1)

    await composable.search()
    expect(composable.grabError.value).toBeNull()
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
    expect(composable.grabError.value).toBe('Failed to grab this release.')
    expect(composable.error.value).toBeNull()

    await composable.grab(release)
    expect(grabMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('lets a searched-again release be grabbed after its request was deleted', async () => {
    grabMock.mockResolvedValueOnce(request(4242))
    searchMock.mockResolvedValueOnce(searchResult([indexerStatus(7, 'torrent')]))
    const { composable, wrapper } = mountComposable()

    await composable.grab(release)
    expect(composable.isGrabbed(release)).toBe(true)

    await composable.search()

    expect(composable.isGrabbed(release)).toBe(false)
    wrapper.unmount()
  })
})

describe('useMonitoredReleases delivery', () => {
  beforeEach(() => {
    searchMock.mockReset()
  })

  it.each([
    ['usenet', 'usenet'],
    ['torrent', 'torrent'],
    ['file', 'file'],
  ] as const)('reports the %s delivery its indexer stated', async (delivery, expected) => {
    searchMock.mockResolvedValueOnce(searchResult([indexerStatus(7, delivery)]))
    const { composable, wrapper } = mountComposable()

    await composable.search()

    expect(composable.deliveryFor(release)).toBe(expected)
    wrapper.unmount()
  })

  it('falls back to the release evidence when the status list omits its indexer', async () => {
    searchMock.mockResolvedValueOnce(searchResult([indexerStatus(9, 'usenet')]))
    const { composable, wrapper } = mountComposable()

    await composable.search()

    expect(composable.deliveryFor(release)).toBe('file')
    expect(composable.deliveryFor({ ...release, seeders: 3 } as ReleaseCandidateItem)).toBe('torrent')
    wrapper.unmount()
  })

  it('drops the indexer statuses when a search fails', async () => {
    searchMock.mockResolvedValueOnce(searchResult([indexerStatus(7, 'usenet')]))
    const { composable, wrapper } = mountComposable()
    await composable.search()

    searchMock.mockRejectedValueOnce(new Error('nope'))
    await composable.search()

    expect(composable.deliveryFor(release)).toBe('file')
    wrapper.unmount()
  })
})

describe('useMonitoredReleases streamed search', () => {
  beforeEach(() => {
    grabMock.mockReset()
    searchMock.mockReset()
  })

  /** A snapshot is the final result's shape plus the sources still answering. */
  function progressOf(result: MonitoredWorkReleasesResponse, pending: ReleaseSearchProgress['pending']): ReleaseSearchProgress {
    return { ...result, pending } as ReleaseSearchProgress
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('applies each snapshot as it arrives and only the final result settles the search', async () => {
    const { composable, wrapper } = mountComposable()
    const stream: {
      send: ((progress: ReleaseSearchProgress) => void) | undefined
      finish: ((result: MonitoredWorkReleasesResponse) => void) | undefined
    } = { send: undefined, finish: undefined }
    searchMock.mockImplementationOnce(
      (_workId, _format, onProgress) =>
        new Promise<MonitoredWorkReleasesResponse>((resolve) => {
          stream.send = onProgress
          stream.finish = resolve
        }),
    )
    const searching = composable.search()
    await settle()

    stream.send!(progressOf(searchResult([]), [{ indexerId: 9, indexerName: 'Slow', color: null }]))
    await settle()

    expect(composable.releases.value).toEqual([release])
    expect(composable.pending.value).toEqual([{ indexerId: 9, indexerName: 'Slow', color: null }])
    expect(composable.loading.value).toBe(true)
    expect(composable.searched.value).toBe(false)

    stream.finish!(searchResult([indexerStatus(7, 'torrent')]))
    await searching

    expect(composable.pending.value).toEqual([])
    expect(composable.indexers.value).toEqual([indexerStatus(7, 'torrent')])
    expect(composable.searched.value).toBe(true)
    expect(composable.loading.value).toBe(false)
    wrapper.unmount()
  })

  it('ignores a snapshot and a result from a search a newer one replaced', async () => {
    const { composable, wrapper } = mountComposable()
    const stale: {
      send: ((progress: ReleaseSearchProgress) => void) | undefined
      finish: ((result: MonitoredWorkReleasesResponse) => void) | undefined
    } = { send: undefined, finish: undefined }
    searchMock.mockImplementationOnce(
      (_workId, _format, onProgress) =>
        new Promise<MonitoredWorkReleasesResponse>((resolve) => {
          stale.send = onProgress
          stale.finish = resolve
        }),
    )
    const staleSearch = composable.search()
    await settle()

    const fresh = searchResult([indexerStatus(7, 'torrent')])
    searchMock.mockResolvedValueOnce(fresh)
    await composable.search()

    stale.send!(progressOf(fresh, [{ indexerId: 9, indexerName: 'Slow', color: null }]))
    stale.finish!(fresh)
    await staleSearch

    expect(composable.releases.value).toEqual(fresh.releases)
    expect(composable.indexers.value).toEqual(fresh.indexers)
    expect(composable.pending.value).toEqual([])
    wrapper.unmount()
  })

  it('cuts the previous stream short when a new search starts', async () => {
    const { composable, wrapper } = mountComposable()
    searchMock.mockImplementationOnce(() => new Promise<MonitoredWorkReleasesResponse>(() => {}))
    void composable.search()
    await settle()
    const staleSignal = searchMock.mock.calls[0]?.[3] as AbortSignal
    expect(staleSignal.aborted).toBe(false)

    searchMock.mockResolvedValueOnce(searchResult([indexerStatus(7, 'torrent')]))
    await composable.search()

    expect(staleSignal.aborted).toBe(true)
    wrapper.unmount()
  })
})
