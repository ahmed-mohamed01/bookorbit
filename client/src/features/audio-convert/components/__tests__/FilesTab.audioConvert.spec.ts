// Fork: Convert to M4B. The Files tab button and file-row entry, mounted the way FilesTab.readAloudDetails.spec.ts mounts the tab.
import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { createReadAloudState } from '@/features/book/composables/__tests__/read-aloud-create-mocks'

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  replace: vi.fn<(to: unknown) => Promise<void>>(),
  push: vi.fn<(to: unknown) => Promise<void>>(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: mocks.query }),
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}))
vi.mock('@/lib/api', () => ({ api: vi.fn<() => Promise<Response>>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => true, isDemoRestrictedAccount: { value: false } }),
}))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 1 }) }) }))
vi.mock('@/features/library/composables/useLibraryPermissions', () => ({ useLibraryPermissions: () => ({ hasLibraryPermission: () => true }) }))
vi.mock('@/features/book/composables/useBookDownload', () => ({ useBookDownload: () => ({ downloadFile: vi.fn<() => Promise<void>>() }) }))

let readAloudState = createReadAloudState()
vi.mock('@/features/read-aloud/composables/useReadAloud', () => ({ useReadAloud: () => readAloudState }))

import FilesTab from '@/features/book/components/detail/tabs/FilesTab.vue'
import { resetAudioConvertEnabled, useAudioConvertEnabled } from '../../composables/useAudioConvertEnabled'

function makeBook(files: { format: string }[] = []): BookDetail {
  return {
    id: 12,
    libraryId: 1,
    title: 'Dune',
    language: 'en',
    folderPath: '/books',
    formatPriority: [],
    files: files.map((file, i) => ({
      id: 101 + i,
      format: file.format,
      role: 'content',
      filename: `Dune-${i}.${file.format}`,
      absolutePath: `/books/Dune-${i}.${file.format}`,
      sizeBytes: 100,
    })),
  } as unknown as BookDetail
}

async function mountTab(files: { format: string }[]) {
  const wrapper = shallowMount(FilesTab, {
    props: { book: makeBook(files) },
    // The hero bar is stubbed; keep its actions slot, where the convert button sits.
    global: { stubs: { FilesHeroBar: { template: '<div><slot name="actions" /></div>' } } },
  })
  await flushPromises()
  return wrapper
}

describe('Convert to M4B on the Files tab', () => {
  beforeEach(() => {
    readAloudState = createReadAloudState()
    mocks.replace.mockReset().mockResolvedValue(undefined)
    for (const key of Object.keys(mocks.query)) delete mocks.query[key]
    useAudioConvertEnabled({ autoload: false }).setState(true)
  })

  afterEach(() => {
    resetAudioConvertEnabled()
  })

  it('shows the hero button and offers the file-row entry on an MP3 book', async () => {
    const wrapper = await mountTab([{ format: 'mp3' }, { format: 'mp3' }])

    expect(wrapper.findComponent({ name: 'AudioConvertBookButton' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FileListCard' }).props('canConvert')).toBe(true)
  })

  it('keeps the hero button but drops the file-row entry on a single M4B', async () => {
    const wrapper = await mountTab([{ format: 'm4b' }])

    expect(wrapper.findComponent({ name: 'AudioConvertBookButton' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FileListCard' }).props('canConvert')).toBe(false)
  })

  it('shows neither on a book without audio', async () => {
    const wrapper = await mountTab([{ format: 'epub' }])

    expect(wrapper.findComponent({ name: 'AudioConvertBookButton' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'FileListCard' }).props('canConvert')).toBe(false)
  })

  it('sends the file-row entry to the hero button through ?convert=1', async () => {
    mocks.query.tab = 'files'
    const wrapper = await mountTab([{ format: 'mp3' }])

    wrapper.findComponent({ name: 'FileListCard' }).vm.$emit('convert')
    expect(mocks.replace).toHaveBeenCalledWith({ query: { tab: 'files', convert: '1' } })
  })
})
