import { vi } from 'vitest'
import { ref } from 'vue'
import type {
  AlignmentStatus,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  EditionLinkCounterpartSummary,
  EditionLinkMember,
  EditionLinkMembers,
  EditionLinkRole,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '../useEditionLink'
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '../useReadAlong'

/** Fakes for the composables useSyncChainPanel drives; `calls` records the order of the requests they stand for. */
export const calls: string[] = []

export const linkRecord: EditionLink = {
  id: 1,
  textBookId: 10,
  audioBookId: 20,
  readAlongBookId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
}

export function member(id: number, title: string, percentage: number | null = null): EditionLinkMember {
  return {
    id,
    title,
    authorName: 'Frank Herbert',
    coverVersion: null,
    progress: percentage === null ? null : { percentage, updatedAt: '2026-09-01' },
    narrationPercentage: null,
  }
}

export function makeMembers(readAlong: EditionLinkMember | null = null): EditionLinkMembers {
  return { text: member(10, 'Dune', 26), audio: member(20, 'Dune (audio)'), readAlong }
}

function asCandidate(edition: EditionLinkMember): EditionLinkCandidate {
  return { bookId: edition.id, title: edition.title, authorName: edition.authorName, coverVersion: edition.coverVersion, score: 96 }
}

export function createEditionLinkState() {
  const state = {
    /** The page's own role once linked; set by the spec from the mounted book. */
    pageRole: 'text' as EditionLinkRole,
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    role: ref<EditionLinkRole | null>(null),
    members: ref<EditionLinkMembers | null>(null),
    thisBookProgress: ref<number | null>(null),
    pickedProgress: ref<number | null>(null),
    readAlongOutput: ref(false),
    candidates: ref<EditionLinkCandidate[]>([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    searchError: ref<string | null>(null),
    loadForBook: vi.fn<(counterpartId?: number | null) => Promise<void>>().mockResolvedValue(undefined),
    invalidateLoad: vi.fn<() => void>(),
    searchCandidates: vi.fn<(query: string, sourceBookId?: number) => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
    linkBook: vi.fn<(id: number, sourceBookId?: number) => Promise<boolean>>(),
    unlink: vi.fn<(targetBookId?: number) => Promise<boolean>>(),
    attachReadAlong: vi.fn<(pairBookId: number, readAlongBookId: number) => Promise<boolean>>().mockResolvedValue(true),
    resetSearch: vi.fn<() => void>(),
  }
  // Like the real mutations, the reload lands while `mutating` is still set, so watchers see it set.
  async function settle(): Promise<boolean> {
    await Promise.resolve()
    state.mutating.value = false
    return true
  }
  state.linkBook.mockImplementation(async () => {
    calls.push('link')
    state.mutating.value = true
    state.link.value = linkRecord
    state.role.value = state.pageRole
    state.members.value = makeMembers()
    state.proposed.value = null
    return settle()
  })
  // Mirrors the server: detaching the read-along keeps the pair, and an ebook leaving a link with a
  // read-along keeps that read-along on the audiobook, which the ebook page then sees as its candidate's
  // and the other pages as a link without an ebook. Anything else dissolves the link.
  state.unlink.mockImplementation(async (targetBookId) => {
    calls.push('unlink')
    state.mutating.value = true
    const before = state.members.value
    const link = state.link.value
    if (before && link && before.readAlong?.id === targetBookId && before.text) {
      state.link.value = { ...link, readAlongBookId: null }
      state.members.value = { ...before, readAlong: null }
      return settle()
    }
    const kept = before?.readAlong && before.text && before.text.id === targetBookId ? { ...before, text: null } : null
    if (before?.text && kept && state.pageRole !== 'text') {
      state.link.value = { ...linkRecord, textBookId: null, readAlongBookId: kept.readAlong!.id }
      state.members.value = kept
      state.proposed.value = asCandidate(before.text)
      return settle()
    }
    const other = before ? (state.pageRole === 'audio' ? before.text : before.audio) : null
    state.link.value = null
    state.role.value = null
    state.members.value = kept
    state.proposed.value = other ? asCandidate(other) : null
    return settle()
  })
  return state
}

export function createAlignmentState() {
  return {
    status: ref<AlignmentStatus>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    anchorCount: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    stale: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildError: ref<string | null>(null),
    buildBlocked: ref<'disabled' | 'unavailable' | 'busy' | null>(null),
    fetchStatus: vi.fn<(id: number) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignmentStatus')
    }),
    build: vi.fn<(id: number, force?: boolean) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignment')
    }),
    cancel: vi.fn<(id: number) => Promise<boolean>>().mockImplementation(async () => {
      calls.push('cancelAlignment')
      return true
    }),
  }
}

export function createReadAlongState() {
  return {
    status: ref<ReadAlongStatus>('none'),
    blocked: ref<ReadAlongBlockReason | null>(null),
    phase: ref<ReadAlongPhase | null>(null),
    transport: ref<StorytellerEffectiveTransport | null>(null),
    remoteTask: ref<string | null>(null),
    remoteProgress: ref<number | null>(null),
    queuePosition: ref<number | null>(null),
    targetLibraryName: ref<string | null>(null),
    remoteCopyBytes: ref({ epub: null, audio: null, readAlong: null }),
    keepRemoteCopy: ref(true),
    remoteCopyReclaimable: ref(true),
    setKeepRemoteCopy: vi.fn<(value: boolean) => void>(),
    resetKeepRemoteCopy: vi.fn<() => void>(),
    outputBook: ref<ReadAlongOutputBook | null>(null),
    targetLibraryId: ref<number | null>(null),
    error: ref<string | null>(null),
    mutating: ref(false),
    existingMatches: ref<StorytellerExistingMatch[]>([]),
    fetchStatus: vi.fn<(id: number, counterpartId?: number | null) => Promise<void>>().mockImplementation(async () => {
      calls.push('readAlongStatus')
    }),
    build: vi.fn<() => Promise<ReadAlongBuildOutcome>>().mockImplementation(async () => {
      calls.push('readAlong')
      return 'started'
    }),
    cancel: vi.fn<(id: number) => Promise<ReadAlongCancelOutcome>>().mockImplementation(async () => {
      calls.push('cancelReadAlong')
      return 'cancelled'
    }),
    fetchExisting: vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
    reset: vi.fn<() => void>().mockImplementation(() => {
      calls.push('readAlongReset')
    }),
  }
}

export function createAbsState() {
  return {
    link: ref<AudiobookshelfBookSyncLink | null>(null),
    live: ref<AudiobookshelfBookSyncLive | null>(null),
    checking: ref(false),
    configured: ref(true),
    loadConfigured: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refreshLive: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    applyLive: vi.fn<(live: AudiobookshelfBookSyncLive) => void>(),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    audioBookIds: [] as (number | null)[],
  }
}
