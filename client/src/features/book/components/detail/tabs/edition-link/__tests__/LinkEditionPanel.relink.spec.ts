import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import type { BookDetail, EditionLinkCounterpartSummary, EditionLinkMembers, EditionLinkRole, ReadAlongStatusResponse } from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '@/features/book/composables/useEditionLink'
import type { AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import { useLinkEditionPanel } from '@/features/book/composables/useLinkEditionPanel'
import LinkEditionPanel from '../LinkEditionPanel.vue'

// The read-along state is the real composable here, so what the section shows after a relink comes
// from the same state machine the app runs, fed through a faked API.

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>(), info: vi.fn<(message: string) => void>() },
}))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))

const apiMocks = vi.hoisted(() => ({ status: vi.fn<() => Response>() }))
vi.mock('@/lib/api', () => ({
  api: vi.fn<(url: string) => Promise<Response>>(async (url: string) => {
    if (url.endsWith('/status')) return apiMocks.status()
    return { ok: true, status: 200, json: async () => ({ matches: [] }) } as Response
  }),
}))

function statusResponse(overrides: Partial<ReadAlongStatusResponse>): Response {
  const body: ReadAlongStatusResponse = {
    status: 'none',
    blocked: null,
    phase: null,
    transport: null,
    remoteTask: null,
    remoteProgress: null,
    outputBook: null,
    targetLibraryId: null,
    targetLibraryName: null,
    remoteCopyBytes: { epub: null, audio: null, readAlong: null },
    keepRemoteCopyByDefault: false,
    remoteCopyReclaimable: true,
    error: null,
    startedAt: null,
    builtAt: null,
    ...overrides,
  }
  return { ok: true, status: 200, json: async () => body } as Response
}

const failedRead = { ok: false, status: 502, json: async () => ({}) } as Response

function member(id: number, title: string) {
  return { id, title, authorName: null, progress: null, narrationPercentage: null }
}

const editionLink = {
  link: ref<EditionLink | null>(null),
  proposed: ref<EditionLinkCandidate | null>(null),
  linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
  role: ref<EditionLinkRole | null>(null),
  members: ref<EditionLinkMembers | null>(null),
  candidates: ref<EditionLinkCandidate[]>([]),
  loading: ref(false),
  searching: ref(false),
  mutating: ref(false),
  error: ref<string | null>(null),
  searchError: ref<string | null>(null),
  loadForBook: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  searchCandidates: vi.fn<() => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
  linkBook: vi.fn<(id: number) => Promise<boolean>>(),
  unlink: vi.fn<() => Promise<boolean>>(),
  resetSearch: vi.fn<() => void>(),
}
vi.mock('@/features/book/composables/useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLink }
})

vi.mock('@/features/book/composables/useReadingAlignment', () => ({
  useReadingAlignment: () => ({
    status: ref<AlignmentStatus>('ready'),
    samplesDone: ref(null),
    samplesTotal: ref(null),
    anchorCount: ref(null),
    builtAt: ref(null),
    mutating: ref(false),
    error: ref(null),
    buildBlocked: ref(null),
    fetchStatus: vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<(id: number, force?: boolean) => Promise<void>>().mockResolvedValue(undefined),
  }),
}))

const book = {
  id: 10,
  title: 'Dune',
  authors: [],
  coverVersion: 'v1',
  files: [{ id: 1, format: 'epub', role: 'content' }],
} as unknown as BookDetail

const counterpartB: EditionLinkCandidate = { bookId: 21, title: 'Dune (second narration)', authorName: null, score: 90 }

function linkTo(audio: { id: number; title: string }, readAlong: { id: number; title: string } | null) {
  editionLink.link.value = {
    id: 1,
    textBookId: 10,
    audioBookId: audio.id,
    readAlongBookId: readAlong?.id ?? null,
    createdBy: 1,
    createdAt: '2026-01-01',
  }
  editionLink.role.value = 'text'
  editionLink.members.value = {
    text: member(10, 'Dune'),
    audio: member(audio.id, audio.title),
    readAlong: readAlong ? member(readAlong.id, readAlong.title) : null,
  }
}

function mountPanel() {
  let state!: ReturnType<typeof useLinkEditionPanel>
  const Host = defineComponent({
    setup() {
      state = useLinkEditionPanel(() => book)
      return () => h(LinkEditionPanel, { panel: reactive(state) })
    },
  })
  const wrapper = mount(Host, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, ConfirmDialog: { template: '<div />' } } } })
  return { wrapper, state }
}

describe('LinkEditionPanel relinking', () => {
  beforeEach(() => {
    linkTo({ id: 20, title: 'Dune (audio)' }, { id: 30, title: 'Dune (read-along)' })
    editionLink.proposed.value = null
    editionLink.unlink.mockImplementation(async () => {
      editionLink.link.value = null
      editionLink.members.value = null
      editionLink.role.value = null
      editionLink.proposed.value = counterpartB
      return true
    })
    editionLink.linkBook.mockImplementation(async () => {
      linkTo({ id: 21, title: counterpartB.title ?? '' }, null)
      return true
    })
  })

  it("never shows the previous pair's read-along on a new pair, even when the first reads for it fail", async () => {
    apiMocks.status.mockReturnValueOnce(statusResponse({ status: 'ready', outputBook: { id: 30, title: 'Dune (read-along)' } }))
    const { wrapper, state } = mountPanel()
    await state.handleOpen()
    await flushPromises()
    expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('ready')

    apiMocks.status.mockReturnValue(failedRead)
    await wrapper.get('[data-testid="link-edition-unlink"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="link-edition-cta"]').trigger('click')
    await flushPromises()

    const section = wrapper.get('[data-testid="read-along-section"]')
    expect(section.attributes('data-state')).toBe('none')
    expect(wrapper.get('[data-testid="read-along-body"]').text()).toBe('Not generated yet.')
    expect(wrapper.get('[data-testid="read-along-generate"]').attributes('disabled')).toBeUndefined()
  })
})
