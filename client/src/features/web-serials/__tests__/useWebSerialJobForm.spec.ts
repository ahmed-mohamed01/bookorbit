import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { WebSerialErrorCode } from '@bookorbit/types'
import type { WebSerialSeriesDetail } from '@bookorbit/types'
import { job, mangaDetail, novelDetail, unit } from './fixtures'

const state = vi.hoisted(() => ({
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchCapabilities: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => ({ createSerialJob: state.createSerialJob, fetchCapabilities: state.fetchCapabilities }))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref: makeRef } = await import('vue')
  const libraries = makeRef([
    { id: 1, type: 'books', name: 'Novels', accessLevel: 'owner', folders: [{ id: 11, path: '/novels' }] },
    { id: 2, type: 'books', name: 'Shared', accessLevel: 'viewer', folders: [{ id: 21, path: '/shared' }] },
    {
      id: 3,
      type: 'books',
      name: 'Manga',
      accessLevel: 'editor',
      folders: [
        { id: 31, path: '/manga' },
        { id: 32, path: '/manga2' },
      ],
    },
    { id: 4, type: 'podcasts', name: 'Pods', accessLevel: 'owner', folders: [] },
    { id: 5, type: 'books', name: 'Audio', accessLevel: 'owner', allowedFormats: ['m4b', 'mp3'], folders: [{ id: 51, path: '/audio' }] },
  ])
  return { useLibraries: () => ({ libraries, loaded: makeRef(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

import { WebSerialApiError } from '../api/http'
import { acceptsKind, canAddToLibrary, useWebSerialJobForm } from '../composables/useWebSerialJobForm'

function setup(detail: WebSerialSeriesDetail | null, userId: number | null = 7) {
  const detailRef = ref<WebSerialSeriesDetail | null>(detail)
  return { detailRef, form: useWebSerialJobForm(detailRef, undefined, ref(userId)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.fetchCapabilities.mockResolvedValue(null)
  window.localStorage.clear()
})

describe('useWebSerialJobForm', () => {
  it('offers only book libraries the user can add to', () => {
    const { form } = setup(mangaDetail())
    expect(form.libraries.value.map((library) => library.id)).toEqual([1, 3])
    expect(canAddToLibrary({ type: 'books', accessLevel: 'viewer' })).toBe(false)
    expect(canAddToLibrary({ type: 'books', accessLevel: null })).toBe(true)
  })

  it('preselects the first library and its first folder', () => {
    const { form } = setup(mangaDetail())
    expect(form.libraryId.value).toBe(1)
    expect(form.folderId.value).toBe(11)
  })

  it('resets the range and packaging when another series opens', async () => {
    const { form, detailRef } = setup(novelDetail())
    form.setMode('range')
    form.setPackaging('series')
    detailRef.value = mangaDetail()
    await nextTick()
    expect(form.packaging.value).toBe('chapter')
    expect(form.range.value).toEqual({ mode: 'all', fromSequence: '1', toSequence: '5' })
  })

  it('keeps manga on chapters and lets a novel choose between volume and series', () => {
    const manga = setup(mangaDetail()).form
    expect(manga.isManga.value).toBe(true)
    expect(manga.choosesPackaging.value).toBe(false)
    manga.setPackaging('series')
    expect(manga.packaging.value).toBe('chapter')

    const novel = setup(novelDetail()).form
    expect(novel.choosesPackaging.value).toBe(true)
    novel.setPackaging('series')
    expect(novel.packaging.value).toBe('series')
  })

  it('keeps the range ordered when one end is dragged past the other', () => {
    const { form } = setup(mangaDetail())
    form.setMode('range')
    form.setFrom('4')
    expect(form.range.value).toMatchObject({ fromSequence: '4', toSequence: '' })
    form.setTo('2')
    expect(form.range.value).toMatchObject({ fromSequence: '2', toSequence: '2' })
  })

  it('selects a range with two taps in either order and starts over on the third', () => {
    const { form } = setup(mangaDetail())
    form.setMode('range')
    form.selectRangeUnit('4')
    expect(form.range.value).toMatchObject({ fromSequence: '4', toSequence: '' })
    form.selectRangeUnit('2')
    expect(form.range.value).toMatchObject({ fromSequence: '2', toSequence: '4' })
    form.selectRangeUnit('5')
    expect(form.range.value).toMatchObject({ fromSequence: '5', toSequence: '' })
  })

  it('quick-picks the missing span and reports imported gaps inside it', () => {
    const { form } = setup(mangaDetail({ importedUnitKeys: ['u2', 'u4'] }))
    form.selectNotImported()
    expect(form.range.value).toMatchObject({ mode: 'range', fromSequence: '1', toSequence: '5' })
    expect(form.rangeIncludesImportedGap.value).toBe(true)
    expect(form.summary.value).toMatchObject({ books: 5, alreadyHave: 2, toDownload: 3 })
  })

  it('summarises a whole-series novel as one book', () => {
    const { form } = setup(novelDetail())
    form.setPackaging('series')
    expect(form.summary.value).toMatchObject({ books: 1, toDownload: 1 })
  })

  it('reports skipped units and blocks Get when nothing new is left', () => {
    const { form } = setup(mangaDetail({ importedUnitKeys: ['u1', 'u2', 'u3', 'u4', 'u5'] }))
    expect(form.nothingToDownload.value).toBe(true)
    expect(form.canSubmit.value).toBe(false)
  })

  it('submits the selection with the chosen library and folder', async () => {
    state.createSerialJob.mockResolvedValue(job())
    const { form } = setup(mangaDetail())
    form.selectLibrary(3)
    form.setFolder(32)
    form.setMode('range')
    form.setFrom('2')
    form.setTo('4')

    await expect(form.submit()).resolves.toMatchObject({ id: 1 })

    expect(state.createSerialJob).toHaveBeenCalledWith({
      seriesKey: 'm:7',
      packaging: 'chapter',
      selection: { mode: 'range', fromSequence: '2', toSequence: '4' },
      skipImported: true,
      libraryId: 3,
      folderId: 32,
    })
    expect(window.localStorage.getItem('bookorbit.webSerials.lastLibraryId.7')).toBe('3')
  })

  it('prefers the library used last time', () => {
    window.localStorage.setItem('bookorbit.webSerials.lastLibraryId.7', '3')
    expect(setup(mangaDetail()).form.libraryId.value).toBe(3)
  })

  it("never starts in another user's last library", () => {
    window.localStorage.setItem('bookorbit.webSerials.lastLibraryId.7', '3')
    expect(setup(mangaDetail(), 8).form.libraryId.value).toBe(1)
    expect(setup(mangaDetail(), null).form.libraryId.value).toBe(1)
  })

  it('names the site when the chapter list is still loading', async () => {
    state.createSerialJob.mockRejectedValue(
      new WebSerialApiError('still loading', 503, WebSerialErrorCode.SeriesLoading, null, { retryAfterMs: 5000 }),
    )
    const { form } = setup(mangaDetail({ sourceName: 'MangaDex' }))
    await expect(form.submit()).resolves.toBeNull()
    expect(form.error.value).toBe('Loading the full chapter list from MangaDex. Long series can take several minutes.')
  })

  it('surfaces the server message when the job is refused', async () => {
    state.createSerialJob.mockRejectedValue(new Error('You cannot add books to that library.'))
    const { form } = setup(mangaDetail())
    await expect(form.submit()).resolves.toBeNull()
    expect(form.error.value).toBe('You cannot add books to that library.')
    expect(form.submitting.value).toBe(false)
  })

  it('prefers the admin library for the series kind over the last one used', async () => {
    window.localStorage.setItem('bookorbit.webSerials.lastLibraryId.7', '1')
    state.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: 3 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null },
    })
    const { form } = setup(mangaDetail())
    await flushPromises()
    expect(form.libraryId.value).toBe(3)
  })

  it('keeps a library the user picked when the defaults arrive later', async () => {
    let resolve: (value: unknown) => void = () => undefined
    state.fetchCapabilities.mockReturnValue(new Promise((r) => (resolve = r)))
    const { form } = setup(mangaDetail())
    form.selectLibrary(1)
    resolve({
      manga: { available: true, searchable: true, defaultLibraryId: 3 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null },
    })
    await flushPromises()
    expect(form.libraryId.value).toBe(1)
  })

  it('recomputes the preselected folder when the next series is of another kind', async () => {
    state.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: 3, targetFolderId: 32 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: 3, targetFolderId: 31 },
    })
    const { form, detailRef } = setup(mangaDetail())
    await flushPromises()
    form.selectLibrary(3)
    expect(form.folderId.value).toBe(32)
    detailRef.value = novelDetail()
    await flushPromises()
    expect(form.folderId.value).toBe(31)
  })

  it('leaves the folder to the server until the user picks one', async () => {
    state.createSerialJob.mockResolvedValue(job())
    const { form } = setup(mangaDetail())
    form.selectLibrary(3)
    await form.submit()
    expect(state.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ libraryId: 3, folderId: null }))
  })

  it('keeps a range and one book for the series apart', () => {
    const { form } = setup(novelDetail())
    form.setMode('range')
    form.setPackaging('series')
    expect(form.range.value.mode).toBe('all')
    form.setMode('range')
    expect(form.packaging.value).toBe('volume')
  })

  it('leaves out libraries that do not take the series format', () => {
    const { form } = setup(novelDetail())
    expect(form.libraries.value.map((library) => library.id)).not.toContain(5)
    expect(acceptsKind({ allowedFormats: ['cbz'] }, 'manga')).toBe(true)
    expect(acceptsKind({ allowedFormats: ['epub'] }, 'manga')).toBe(false)
  })

  it('applies the admin library once a series opens after the defaults loaded', async () => {
    state.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: 3 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null },
    })
    const { form, detailRef } = setup(null)
    await flushPromises()
    detailRef.value = mangaDetail()
    await nextTick()
    expect(form.libraryId.value).toBe(3)
  })

  it('lets manga pack per volume only when a selected chapter has a known volume', async () => {
    const chapterVolumes = ref<Record<string, string> | null>(null)
    const loading = ref(false)
    const detailRef = ref<WebSerialSeriesDetail | null>(mangaDetail({ packagingOptions: ['chapter', 'volume', 'series'] }))
    const form = useWebSerialJobForm(detailRef, { chapterVolumes, loading })

    form.setPackaging('volume')
    expect(form.packaging.value).toBe('chapter')
    expect(form.volumeUnavailable.value).toBe(true)

    chapterVolumes.value = { u1: '1', u2: '1' }
    await nextTick()
    form.setPackaging('volume')
    expect(form.packaging.value).toBe('volume')
    expect(form.chaptersWithoutVolume.value).toBe(3)

    form.setMode('range')
    form.setFrom('4')
    form.setTo('5')
    await nextTick()
    expect(form.packaging.value).toBe('chapter')
  })

  it('widens a per-volume range to whole volumes and leaves other packagings alone', async () => {
    const chapterVolumes = ref<Record<string, string> | null>({ u1: '1', u2: '1', u3: '1', u5: '2', u6: '2' })
    const detailRef = ref<WebSerialSeriesDetail | null>(
      mangaDetail({ packagingOptions: ['chapter', 'volume', 'series'], units: ['1', '2', '3', '4', '5', '6'].map((sequence) => unit(sequence)) }),
    )
    const form = useWebSerialJobForm(detailRef, { chapterVolumes, loading: ref(false) })
    form.setPackaging('volume')
    form.setMode('range')
    form.setFrom('2')
    form.setTo('5')
    await nextTick()

    expect(form.effectiveRange.value).toMatchObject({ fromSequence: '1', toSequence: '6' })
    expect(form.selectedUnits.value).toHaveLength(6)
    expect(form.volumeNotice.value).toMatchObject({ volumes: 2, snappedRange: { fromSequence: '1', toSequence: '6' } })
    expect(form.volumeNotice.value?.outsideVolumes.map((item) => item.sequence)).toEqual(['4'])
    expect(form.singleChapterCount.value).toBe(1)
    expect(form.summary.value).toMatchObject({ books: 3, toDownload: 3, chapters: 6 })

    form.setPackaging('chapter')
    await nextTick()
    expect(form.volumeNotice.value).toBeNull()
    expect(form.selectedUnits.value.map((item) => item.sequence)).toEqual(['2', '3', '4', '5'])
  })

  it('keeps a manga range when the whole selection becomes one book', () => {
    const detailRef = ref<WebSerialSeriesDetail | null>(mangaDetail({ packagingOptions: ['chapter', 'volume', 'series'] }))
    const form = useWebSerialJobForm(detailRef)
    form.setMode('range')
    form.setFrom('2')
    form.setTo('4')
    form.setPackaging('series')
    expect(form.packaging.value).toBe('series')
    expect(form.range.value).toMatchObject({ mode: 'range', fromSequence: '2', toSequence: '4' })
    expect(form.summary.value).toMatchObject({ books: 1 })
  })
  it('preselects the admin default folder, which the server also uses, in the default library', async () => {
    state.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: 3, targetFolderId: 32 },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null },
    })
    const { form } = setup(mangaDetail())
    await flushPromises()
    expect(form.libraryId.value).toBe(3)
    expect(form.folderId.value).toBe(32)
    state.createSerialJob.mockResolvedValue(job())
    await form.submit()
    expect(state.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ libraryId: 3, folderId: null }))
  })

  it('does not block Get on chapters owned when the whole series becomes one book', () => {
    const detailRef = ref<WebSerialSeriesDetail | null>(
      mangaDetail({ packagingOptions: ['chapter', 'series'], importedUnitKeys: ['u1', 'u2', 'u3', 'u4', 'u5'] }),
    )
    const form = useWebSerialJobForm(detailRef)
    expect(form.canSubmit.value).toBe(false)
    form.setPackaging('series')
    expect(form.nothingToDownload.value).toBe(false)
    expect(form.canSubmit.value).toBe(true)
  })

  it('takes the latest and first units by sequence, not by array order', () => {
    const units = [3, 0, 1, 2, 4].map((n) => ({ ...mangaDetail().units[0]!, key: `u${n}`, sequence: String(n) }))
    const { form } = setup(mangaDetail({ units }))
    form.selectLatest(2)
    expect(form.range.value).toMatchObject({ fromSequence: '3', toSequence: '4' })
    form.selectFirst(2)
    expect(form.range.value).toMatchObject({ fromSequence: '0', toSequence: '1' })
  })
})
