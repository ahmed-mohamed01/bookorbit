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

export function createEditionLinkState() {
  const state = {
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    role: ref<EditionLinkRole | null>(null),
    members: ref<EditionLinkMembers | null>(null),
    readAlongOutput: ref(false),
    candidates: ref<EditionLinkCandidate[]>([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    searchError: ref<string | null>(null),
    loadForBook: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    searchCandidates: vi.fn<(query: string) => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
    linkBook: vi.fn<(id: number, sourceBookId?: number) => Promise<boolean>>(),
    unlink: vi.fn<(targetBookId?: number) => Promise<boolean>>(),
    attachReadAlong: vi.fn<(pairBookId: number, readAlongBookId: number) => Promise<boolean>>().mockResolvedValue(true),
    resetSearch: vi.fn<() => void>(),
  }
  state.linkBook.mockImplementation(async () => {
    calls.push('link')
    state.link.value = linkRecord
    state.role.value = 'text'
    state.members.value = makeMembers()
    return true
  })
  state.unlink.mockImplementation(async () => {
    calls.push('unlink')
    state.link.value = null
    state.role.value = null
    state.members.value = null
    return true
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
    fetchStatus: vi.fn<(id: number, counterpartId?: number) => Promise<void>>().mockImplementation(async () => {
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
    refreshLive: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    applyLive: vi.fn<(live: AudiobookshelfBookSyncLive) => void>(),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    audioBookIds: [] as (number | null)[],
  }
}
