// Fork: Convert to M4B. The book ⋮ menu entry, mounted the way DetailsTabActions.spec.ts mounts the tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  push: vi.fn<(to: unknown) => void>(),
  back: vi.fn<() => void>(),
  hasPermission: vi.fn<(permission: string) => boolean>(),
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  onDeleted: null as ((id: number) => void) | null,
  libraries: null as unknown as { value: { id: number; accessLevel: string }[] },
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: mocks.push, back: mocks.back }) }
})

vi.mock('@/lib/api', () => ({ api: mocks.api, setOnAuthFailure: vi.fn<(callback: () => void) => void>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: mocks.hasPermission, isSuperuser: ref(false), isDemoRestrictedAccount: ref(false) }),
}))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref: vueRef } = await import('vue')
  mocks.libraries = vueRef([{ id: 3, accessLevel: 'editor' }])
  return { useLibraries: () => ({ libraries: mocks.libraries }) }
})
vi.mock('@/features/book/composables/useBookProgressRefresh', () => ({ useBookProgressRefresh: vi.fn<() => void>() }))

vi.mock('@/features/book/composables/useDeleteBook', () => ({
  useDeleteBook: (onDeleted: (id: number) => void) => {
    mocks.onDeleted = onDeleted
    return {
      pendingId: { value: null },
      deleting: { value: false },
      promptDelete: vi.fn<(id: number) => void>(),
      cancelDelete: vi.fn<() => void>(),
      confirmDelete: vi.fn<() => void>(),
    }
  },
}))

const DetailsTab = (await import('@/features/book/components/detail/tabs/DetailsTab.vue')).default
const { resetAudioConvertEnabled, useAudioConvertEnabled } = await import('../../composables/useAudioConvertEnabled')

function makeBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return {
    id: 12,
    libraryId: 3,
    libraryName: 'Novels',
    status: 'present',
    folderPath: '/books',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    title: 'Cover Behavior Test',
    subtitle: null,
    description: null,
    isbn10: null,
    isbn13: null,
    publisher: null,
    publishedDate: null,
    publishedYear: null,
    language: null,
    pageCount: null,
    seriesName: null,
    seriesIndex: null,
    rating: null,
    personalNote: null,
    personalNoteUpdatedAt: null,
    communityRatings: [],
    coverSource: 'extracted',
    coverMedia: ['ebook'],
    covers: { ebook: null, audio: null },
    coverVersion: 'legacy:2024-01-01T00:00:00.000Z',
    hardcoverEditionId: null,
    providerIds: {},
    authors: [{ id: 1, name: 'Author One', sortName: null }],
    genres: [],
    tags: [],
    files: [
      {
        id: 101,
        format: 'epub',
        role: 'primary',
        sizeBytes: 1234,
        absolutePath: '/books/cover-behavior-test.epub',
        createdAt: '2026-01-01T00:00:00.000Z',
        filename: 'cover-behavior-test.epub',
        durationSeconds: null,
      },
    ],
    lastWrittenAt: null,
    metadataScore: null,
    readStatus: null,
    audioMetadata: null,
    readAloudSync: {
      mode: 'auto',
      state: 'unavailable',
      unavailableReason: 'no_media_overlay_epub',
      overlayFileId: null,
      audioDurationSeconds: null,
      overlayDurationSeconds: null,
      durationDifferenceSeconds: null,
      durationDifferenceRatio: null,
      koreaderDownloadAvailable: false,
    },
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    collections: [],
    ...overrides,
  }
}

function response(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response
}

function mountTab(overrides: Partial<BookDetail> = {}) {
  return shallowMount(DetailsTab, {
    props: { book: makeBook(overrides) },
    global: {
      stubs: {
        Popover: { template: '<div><slot /><slot name="content" /></div>' },
        PopoverTrigger: { template: '<div><slot /></div>' },
        PopoverContent: { template: '<div><slot /></div>' },
        Tooltip: { template: '<div><slot /></div>' },
        TooltipTrigger: { template: '<div><slot /></div>' },
        TooltipContent: { template: '<div><slot /></div>' },
      },
    },
  })
}

beforeEach(() => {
  mocks.push.mockReset()
  mocks.back.mockReset()
  mocks.api.mockReset().mockResolvedValue(response({}))
  mocks.hasPermission.mockReset().mockReturnValue(true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  mocks.onDeleted = null
  mocks.libraries.value = [{ id: 3, accessLevel: 'editor' }]
})

afterEach(() => {
  resetAudioConvertEnabled()
})

function audioFile(id: number, format: string): BookDetail['files'][number] {
  return {
    id,
    format,
    role: 'content',
    sizeBytes: 1000,
    absolutePath: `/books/track-${id}.${format}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    filename: `track-${id}.${format}`,
    durationSeconds: 60,
  }
}

describe('Convert to M4B in the book menu', () => {
  beforeEach(() => {
    useAudioConvertEnabled({ autoload: false }).setState(true)
  })

  it('is offered on an MP3 book to a library manager', () => {
    const wrapper = mountTab({ files: [audioFile(1, 'mp3'), audioFile(2, 'mp3')] })
    expect(wrapper.findComponent({ name: 'AudioConvertMenuItem' }).exists()).toBe(true)
  })

  it('is not offered on a book that is already one M4B', () => {
    const wrapper = mountTab({ files: [audioFile(1, 'm4b')] })
    expect(wrapper.findComponent({ name: 'AudioConvertMenuItem' }).exists()).toBe(false)
  })

  it('is not offered without manage_libraries or while the tool is off', () => {
    mocks.hasPermission.mockImplementation((permission) => permission !== 'manage_libraries')
    expect(
      mountTab({ files: [audioFile(1, 'mp3')] })
        .findComponent({ name: 'AudioConvertMenuItem' })
        .exists(),
    ).toBe(false)

    mocks.hasPermission.mockReturnValue(true)
    useAudioConvertEnabled({ autoload: false }).setState(false)
    expect(
      mountTab({ files: [audioFile(1, 'mp3')] })
        .findComponent({ name: 'AudioConvertMenuItem' })
        .exists(),
    ).toBe(false)
  })
})
