import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import ReadAloudJobCard from '@/features/read-aloud/components/ReadAloudJobCard.vue'
import { makeJob } from '@/features/read-aloud/__tests__/fixtures'
import { createReadAloudState } from '@/features/book/composables/__tests__/sync-chain-panel-mocks'

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

import FilesTab from '../FilesTab.vue'

function makeBook(): BookDetail {
  return {
    id: 12,
    libraryId: 1,
    title: 'Dune',
    language: 'en',
    folderPath: '/books',
    formatPriority: [],
    files: [{ id: 101, format: 'epub', role: 'content', filename: 'Dune.epub', absolutePath: '/books/Dune.epub', sizeBytes: 100 }],
  } as unknown as BookDetail
}

async function mountTab() {
  const wrapper = shallowMount(FilesTab, { props: { book: makeBook() } })
  await flushPromises()
  return wrapper
}

describe('FilesTab read-aloud details request', () => {
  beforeEach(() => {
    readAloudState = createReadAloudState()
    readAloudState.job.value = makeJob({ status: 'awaiting_review', bookId: 12 })
    mocks.replace.mockReset().mockResolvedValue(undefined)
    for (const key of Object.keys(mocks.query)) delete mocks.query[key]
  })

  it('opens the job card with Details expanded and drops the request from the URL', async () => {
    Object.assign(mocks.query, { tab: 'files', readAloud: 'details' })
    const wrapper = await mountTab()

    expect(wrapper.findComponent(ReadAloudJobCard).props('initialDetailsOpen')).toBe(true)
    expect(mocks.replace).toHaveBeenCalledWith({ query: { tab: 'files' } })
  })

  it('leaves Details closed on an ordinary visit', async () => {
    mocks.query.tab = 'files'
    const wrapper = await mountTab()

    expect(wrapper.findComponent(ReadAloudJobCard).props('initialDetailsOpen')).toBe(false)
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
