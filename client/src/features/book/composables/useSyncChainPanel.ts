import { computed, ref, watch, type UnwrapNestedRefs } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  Permission,
  type AlignmentStatus,
  type AudiobookshelfBookState,
  type AudiobookshelfReconcileDirection,
  type BookDetail,
  type EditionLinkCandidate,
  type EditionLinkMember,
} from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { isReadAlongInFlight } from '@/features/book/lib/read-along-section'
import { readAloudSyncIssue } from '@/features/book/lib/read-aloud-sync-issue'
import {
  buildSyncChain,
  initialViewMode,
  type ChainActionId,
  type ChainConnectorRow,
  type ChainMessage,
  type ChainViewMode,
  type ConnectorKey,
  type EditionKey,
  type EditionMatchChip,
  type SyncChainAlignment,
  type SyncChainBook,
  type SyncChainReadAlong,
  type SyncChainSide,
  type SyncChainSnapshot,
} from '@/features/book/lib/sync-chain'
import { useAudiobookshelfSyncActions } from './useAudiobookshelfSyncActions'
import { useAudiobookshelfSyncLink } from './useAudiobookshelfSyncLink'
import { getBookLinkModality, useEditionLink } from './useEditionLink'
import { useReadAlongSection } from './useReadAlongSection'
import { useReadingAlignment } from './useReadingAlignment'

const EDITION_LINK = 'book.detail.editionLink.'
const CHAIN = `${EDITION_LINK}chain.`

const ALIGNMENT_RUNNING = new Set<AlignmentStatus>(['pending', 'building'])

export type SyncChainDialogKind = 'unlinkPair' | 'detachReadAlong' | 'pauseAbs' | 'change' | 'rebuildReadAlong'

export interface SyncChainDialog {
  kind: SyncChainDialogKind
  title: ChainMessage
  description: ChainMessage
  confirmLabel: ChainMessage
}

type PairEdition = 'ebook' | 'audiobook'

interface ChangePick {
  edition: PairEdition
  candidate: EditionLinkCandidate
}

function toCandidate(member: EditionLinkMember, score: number): EditionLinkCandidate {
  return {
    bookId: member.id,
    title: member.title,
    authorName: member.authorName,
    coverVersion: member.coverVersion,
    score,
    progress: member.progress?.percentage ?? null,
  }
}

const EMPTY_SIDE: SyncChainSide = { book: null, isMember: false, isThisBook: false, match: null }

const IDLE_ALIGNMENT: SyncChainAlignment = {
  status: 'none',
  stale: false,
  builtAt: null,
  samplesDone: null,
  samplesTotal: null,
  buildBlocked: null,
  buildError: null,
  running: false,
}

function isPairEdition(edition: EditionKey | null): edition is PairEdition {
  return edition === 'ebook' || edition === 'audiobook'
}

export function useSyncChainPanel(book: () => BookDetail) {
  const { t } = useI18n()
  const bookId = book().id

  const { hasPermission } = usePermissions()
  const canEditLink = computed(() => hasPermission(Permission.LibraryEditMetadata))
  const canSyncAbs = computed(() => hasPermission(Permission.AudiobookshelfSync))

  const {
    link,
    proposed,
    role,
    members,
    thisBookProgress,
    pickedProgress,
    readAlongOutput,
    linkedCounterpart,
    candidates,
    loading,
    searching,
    mutating,
    error,
    searchError,
    loadForBook,
    invalidateLoad,
    searchCandidates,
    linkBook,
    unlink: unlinkBook,
    attachReadAlong: attachReadAlongBook,
    resetSearch,
  } = useEditionLink(bookId)

  const alignment = useReadingAlignment()
  const readAlongSection = useReadAlongSection(
    () => pairBookId.value,
    () => (link.value ? null : (selected.value?.bookId ?? null)),
  )
  const { readAlong, canGenerate, canRebuild } = readAlongSection

  // Only the first load shows the skeleton. Later reloads (after a link, an unlink or a finished
  // read-along) keep the chain mounted, so focus stays where it was.
  const loadedOnce = ref(false)
  const initialLoading = computed(() => loading.value && !loadedOnce.value)

  // The audiobook the last for-book request named. Without one, the answer was computed for its own proposal.
  let requestedCounterpartId: number | null = null

  async function load(): Promise<void> {
    requestedCounterpartId = forBookCounterpartId()
    await loadForBook(requestedCounterpartId)
    loadedOnce.value = true
  }

  // Without a link the server checks the audiobook it is told about, so a read-along that audiobook
  // holds belongs to the pair on screen and not to whichever candidate the server would rank first.
  function forBookCounterpartId(): number | null {
    return !link.value && thisBook.value === 'ebook' ? (selected.value?.bookId ?? null) : null
  }

  const modality = computed(() => getBookLinkModality(book().files))
  const isReadAlongPage = computed(() => role.value === 'readAlong')
  // The server keys position sync and read-along builds to the pair, so a read-along page acts through
  // the pair's ebook.
  const pairBookId = computed(() => (isReadAlongPage.value && members.value ? (members.value.text?.id ?? members.value.audio.id) : bookId))
  // A read-along whose pair this reader cannot relink gets no panel; the pair's own books relink it.
  const isEligible = computed(() => !readAlongOutput.value && (modality.value === 'text' || modality.value === 'audio' || isReadAlongPage.value))
  // A read-along detached from its pair stays matched to the pair it was built from, so its page offers
  // to link that pair again and never any other.
  const detachedReadAlong = computed(() => isReadAlongPage.value && !link.value && members.value !== null)

  const thisBook = computed<SyncChainSnapshot['thisBook']>(() => {
    if (role.value === 'readAlong') return 'readAlong'
    if (role.value === 'text') return 'ebook'
    if (role.value === 'audio') return 'audiobook'
    return modality.value === 'audio' ? 'audiobook' : 'ebook'
  })

  // A pick from the search replaces the server's proposal.
  const picked = ref<EditionLinkCandidate | null>(null)
  const proposalDismissed = ref(false)
  const selected = computed(() => picked.value ?? (proposalDismissed.value ? null : proposed.value))
  const matchChip = computed<EditionMatchChip | null>(() => {
    if (picked.value) return { source: 'manual' }
    if (selected.value?.fromBuild) return { source: 'build' }
    return selected.value ? { source: 'auto', score: selected.value.score } : null
  })

  function memberSide(member: EditionLinkMember, linked: boolean): SyncChainSide {
    const isThisBook = member.id === bookId
    const progress = member.progress?.percentage ?? null
    return {
      book: {
        id: member.id,
        title: member.title,
        authorName: member.authorName,
        coverVersion: isThisBook ? book().coverVersion : member.coverVersion,
        // A linked member with no progress record has not been started yet, so it reads 0%.
        progress: linked ? (progress ?? 0) : progress,
      },
      isMember: linked,
      isThisBook,
      match: linked ? null : { source: 'pair' },
    }
  }

  const currentBook = computed<SyncChainBook>(() => {
    const current = book()
    return {
      id: current.id,
      title: current.title,
      authorName: current.authors.map((author) => author.name).join(', ') || null,
      coverVersion: current.coverVersion,
      progress: thisBookProgress.value,
    }
  })

  // The answer's own member knows the position first-hand; a pick is described by the server's pickedProgress.
  function candidateProgress(candidate: EditionLinkCandidate): number | null {
    const resolved = members.value
    const member = resolved && [resolved.text, resolved.audio].find((entry) => entry?.id === candidate.bookId)
    if (member) return member.progress?.percentage ?? null
    if (candidate.progress != null) return candidate.progress
    return picked.value?.bookId === candidate.bookId ? pickedProgress.value : null
  }

  function candidateSide(): SyncChainSide {
    const candidate = selected.value
    if (!candidate) return EMPTY_SIDE
    return {
      book: {
        id: candidate.bookId,
        title: candidate.title,
        authorName: candidate.authorName,
        coverVersion: candidate.coverVersion,
        progress: candidateProgress(candidate),
      },
      isMember: false,
      isThisBook: false,
      match: matchChip.value,
    }
  }

  function counterpartSide(): SyncChainSide {
    const summary = link.value ? linkedCounterpart.value : null
    if (summary) return memberSide({ ...summary, progress: null, narrationPercentage: null }, true)
    return candidateSide()
  }

  // Ebook first, audiobook second, whichever page the panel is opened from.
  const sides = computed<Record<PairEdition, SyncChainSide>>(() => {
    const resolved = members.value
    if (resolved && (link.value || detachedReadAlong.value)) {
      const linked = link.value !== null
      // A link with no ebook yet still proposes one, so that slot reads as a candidate rather than empty.
      return { ebook: resolved.text ? memberSide(resolved.text, linked) : candidateSide(), audiobook: memberSide(resolved.audio, linked) }
    }
    const current: SyncChainSide = { book: currentBook.value, isMember: link.value !== null, isThisBook: true, match: null }
    const counterpart = counterpartSide()
    return thisBook.value === 'audiobook' ? { ebook: counterpart, audiobook: current } : { ebook: current, audiobook: counterpart }
  })

  const absAudioBookId = computed(() => sides.value.audiobook.book?.id ?? null)
  const abs = useAudiobookshelfSyncLink(absAudioBookId)
  const absActions = useAudiobookshelfSyncActions(abs, () => absAudioBookId.value)

  // Set from a link request until its first alignment build is under way, so the connector reads
  // Linking for the whole of that window instead of flashing Not aligned.
  const pendingStart = ref(false)
  const alignmentRunning = computed(() => ALIGNMENT_RUNNING.has(alignment.status.value) || alignment.mutating.value)

  const alignmentSnapshot = computed<SyncChainAlignment>(() => {
    // Before a pair exists there is nothing to align, so a stale status from a cancelled link must not
    // narrate a build that no longer belongs to this panel.
    if (!link.value) return { ...IDLE_ALIGNMENT, running: pendingStart.value }
    return {
      status: alignment.status.value,
      stale: alignment.stale.value,
      builtAt: alignment.builtAt.value,
      samplesDone: alignment.samplesDone.value,
      samplesTotal: alignment.samplesTotal.value,
      buildBlocked: alignment.buildBlocked.value,
      buildError: alignment.buildError.value,
      running: pendingStart.value || alignmentRunning.value,
    }
  })

  // Also set on an unlinked ebook page whose candidate audiobook already carries the read-along, but only
  // while that audiobook is the one on screen: a read-along built for another audiobook is not this pair's.
  const readAlongMember = computed(() => {
    const resolved = members.value
    if (!resolved) return null
    if (link.value) return resolved.readAlong
    return resolved.audio.id === sides.value.audiobook.book?.id ? resolved.readAlong : null
  })

  // The server re-attaches a read-along to a relinked pair as part of the link, so its member is normally
  // there already. This is a safety net for a ready output that still lacks one, which onReady never
  // reports (none -> ready). Reloaded once per output book, so a for-book answer that still lacks the
  // member (a deliberate detach) cannot loop.
  let reloadedForOutputId: number | null = null
  const reloadingMember = ref(false)
  const missingReadAlongMemberId = computed(() => {
    const output = readAlong.outputBook.value
    if (!link.value || readAlong.status.value !== 'ready' || !output || members.value?.readAlong) return null
    return output.id
  })
  watch(missingReadAlongMemberId, async (outputId) => {
    if (outputId === null || outputId === reloadedForOutputId) return
    reloadedForOutputId = outputId
    reloadingMember.value = true
    try {
      await load()
    } finally {
      reloadingMember.value = false
    }
  })
  const memberPending = computed(() => reloadingMember.value && missingReadAlongMemberId.value !== null)

  const readAlongSnapshot = computed<SyncChainReadAlong>(() => ({
    member: readAlongMember.value,
    status: readAlong.status.value,
    blocked: readAlong.blocked.value,
    phase: readAlong.phase.value,
    remoteTask: readAlong.remoteTask.value,
    remoteProgress: readAlong.remoteProgress.value,
    queuePosition: readAlong.queuePosition.value,
    outputBook: readAlong.outputBook.value,
    thisBook: isReadAlongPage.value ? currentBook.value : null,
    error: readAlong.error.value,
    mutating: readAlong.mutating.value,
    memberPending: memberPending.value,
  }))

  const snapshot = computed<SyncChainSnapshot>(() => ({
    thisBook: thisBook.value,
    linked: link.value !== null,
    ebook: sides.value.ebook,
    audiobook: sides.value.audiobook,
    alignment: alignmentSnapshot.value,
    readAlong: readAlongSnapshot.value,
    // The book page only describes the read-along's fit with its audiobook on those two pages.
    readAloudIssue: thisBook.value !== 'ebook' && readAloudSyncIssue(book().readAloudSync) !== null ? book().readAloudSync : null,
    abs: canSyncAbs.value ? { configured: abs.configured.value, link: abs.link.value, live: abs.live.value, checking: abs.checking.value } : null,
    can: { editLink: canEditLink.value, generate: canGenerate.value, rebuild: canRebuild.value && link.value !== null },
  }))

  const chain = computed(() => buildSyncChain(snapshot.value))

  /* View mode. */

  const viewMode = ref<ChainViewMode | null>(null)
  let pendingView: { availableHeight: number; force: ChainViewMode | undefined } = { availableHeight: Number.POSITIVE_INFINITY, force: undefined }
  let openId = 0
  let promotedThisOpen = false

  /** Records the space the trigger leaves; the view itself is decided once the open has loaded, so the panel never switches under the reader. */
  function prepareView(availableHeight: number, force?: ChainViewMode): void {
    pendingView = { availableHeight, force }
  }

  function decideView(): void {
    viewMode.value = pendingView.force ?? initialViewMode(chain.value, pendingView.availableHeight)
  }

  // A failure that lands after the view was decided still has to be seen, but a view the reader chose is never overridden.
  watch(
    () => chain.value.needsAttention,
    (needsAttention) => {
      if (!needsAttention || promotedThisOpen || viewMode.value !== 'compact') return
      promotedThisOpen = true
      viewMode.value = 'modify'
    },
  )

  function setViewMode(mode: ChainViewMode): void {
    promotedThisOpen = true
    viewMode.value = mode
  }

  /* Edition search: a slot's Search or Change, in place of the slot. */

  const optionsOpen = ref(false)
  const logOpen = ref(false)
  const changing = ref<EditionKey | null>(null)
  const query = ref('')
  const hasSearched = ref(false)
  const searchAutofocus = ref(false)

  // The candidates are those of the pair member the pick joins, which on a read-along page is not the page's book.
  function searchSourceId(): number {
    if (changing.value === 'ebook') return sides.value.audiobook.book?.id ?? bookId
    if (changing.value === 'audiobook') return sides.value.ebook.book?.id ?? bookId
    return bookId
  }

  function runSearch(): void {
    hasSearched.value = true
    void searchCandidates(query.value, searchSourceId())
  }

  function startSearch(): void {
    query.value = ''
    searchAutofocus.value = true
    runSearch()
  }

  function setQuery(value: string): void {
    query.value = value
    runSearch()
  }

  function closeSearch(): void {
    changing.value = null
    query.value = ''
    hasSearched.value = false
    searchAutofocus.value = false
    resetSearch()
    absActions.search.reset()
  }

  const changePick = ref<ChangePick | null>(null)

  function pick(candidate: EditionLinkCandidate): void {
    const edition = changing.value
    if (isPairEdition(edition) && sides.value[edition].isMember) {
      changePick.value = { edition, candidate }
      dialogKind.value = 'change'
      return
    }
    picked.value = candidate
    proposalDismissed.value = true
    closeSearch()
  }

  async function pickAbsItem(item: AudiobookshelfBookState): Promise<void> {
    if (await absActions.change(item)) changing.value = null
  }

  function openChange(edition: EditionKey): void {
    changing.value = edition
    if (edition === 'abs') {
      absActions.search.reset()
      absActions.search.setQuery('')
      return
    }
    startSearch()
  }

  /* Pair. */

  function linkedCounterpartCandidate(): EditionLinkCandidate | null {
    const resolved = members.value
    // The ebook is the side that leaves on the read-along page too, so only the ebook page restores the audiobook.
    const counterpart = resolved ? (role.value === 'text' ? resolved.audio : resolved.text) : null
    if (counterpart) return toCandidate(counterpart, 0)
    const summary = linkedCounterpart.value
    return summary ? { bookId: summary.id, title: summary.title, authorName: summary.authorName, coverVersion: summary.coverVersion, score: 0 } : null
  }

  function restoreSelection(candidate: EditionLinkCandidate | null): void {
    searchAutofocus.value = false
    if (candidate && proposed.value?.bookId !== candidate.bookId) {
      picked.value = candidate
      proposalDismissed.value = true
      return
    }
    picked.value = null
    proposalDismissed.value = false
  }

  // Nothing read for the old pair may narrate the next one. The status is asked for the restored
  // counterpart, since without one the server answers no_pair and the pair's surviving read-along
  // would be offered as a new build.
  function forgetPair(candidate: EditionLinkCandidate | null): void {
    restoreSelection(candidate)
    readAlong.reset()
    void alignment.fetchStatus(pairBookId.value)
    void readAlong.fetchStatus(pairBookId.value, selected.value?.bookId ?? null)
  }

  // A fresh pair gets its alignment straight away. The read-along is never started here: it is hours
  // of work and always asked for on its own.
  async function alignNewPair(pairId: number): Promise<void> {
    toast.success(t(`${EDITION_LINK}linkedSuccess`))
    await alignment.build(pairId)
    pendingStart.value = false
    // The pre-link read answered for a book without a pair ('no_pair'), which would keep Generate
    // disabled until the panel is reopened.
    void readAlong.fetchStatus(pairId, null)
    if (canGenerate.value) void readAlong.fetchExisting(pairId)
  }

  async function linkPair(): Promise<void> {
    // Taken before the link reloads the page's state: a read-along page whose attach failed reads as a
    // bare read-along afterwards, and pairBookId would then name the read-along itself.
    const pairId = pairBookId.value
    const resolved = members.value
    // A page whose pair the server already knows links through the pair's own books: the detached
    // read-along's ebook and audiobook, or a candidate ebook onto a link that has only the audiobook.
    const request =
      detachedReadAlong.value && resolved?.text
        ? { counterpartId: resolved.audio.id, sourceId: resolved.text.id }
        : resolved && !resolved.text && (detachedReadAlong.value || link.value) && selected.value
          ? { counterpartId: selected.value.bookId, sourceId: resolved.audio.id }
          : !detachedReadAlong.value && !link.value && selected.value
            ? { counterpartId: selected.value.bookId, sourceId: bookId }
            : null
    if (!request) return
    pendingStart.value = true
    const success = await linkBook(request.counterpartId, request.sourceId)
    if (!success) {
      pendingStart.value = false
      toast.error(error.value ?? t(`${EDITION_LINK}linkFailed`))
      return
    }
    await alignNewPair(pairId)
  }

  // Stops whatever this pair has running. A cancel the server refuses is reported and the unlink still
  // happens, except for a read-along already being imported onto this link: unlinking then would strand
  // the imported book, so the link stays.
  async function stopPairBuilds(pairId: number): Promise<boolean> {
    if (isReadAlongInFlight(readAlong.status.value) || readAlong.mutating.value) {
      const outcome = await readAlong.cancel(pairId)
      if (outcome === 'too_late') {
        toast.error(t(`${EDITION_LINK}readAlong.cancelTooLate`))
        return false
      }
      if (outcome === 'failed') toast.error(t(`${EDITION_LINK}readAlong.cancelKeptRunning`))
    }
    if (alignmentRunning.value) {
      const cancelled = await alignment.cancel(pairId)
      if (!cancelled) toast.error(t(`${EDITION_LINK}syncCancelKeptRunning`))
    }
    return true
  }

  // Only a cancel in flight locks the cancel buttons: a link or a build in flight is exactly what they stop.
  const cancelling = ref(false)

  // Unlinked through the ebook where there is one: the server keeps the read-along on the audiobook for
  // that side, while unlinking the audiobook dissolves the whole link, which this switch never confirmed.
  async function cancelLinking(): Promise<void> {
    const pairId = pairBookId.value
    const leavingId = members.value?.text?.id ?? pairId
    const candidate = linkedCounterpartCandidate()
    cancelling.value = true
    try {
      if (!(await stopPairBuilds(pairId))) return
      if (!(await unlinkBook(leavingId))) {
        toast.error(t(`${EDITION_LINK}cancelFailed`))
        return
      }
      forgetPair(candidate)
    } finally {
      cancelling.value = false
    }
  }

  async function unlinkPair(): Promise<void> {
    const pairId = pairBookId.value
    if (!(await stopPairBuilds(pairId))) return
    if (!(await unlinkBook(pairId))) {
      toast.error(error.value ?? t(`${EDITION_LINK}unlinkFailed`))
      return
    }
    toast.success(t(`${EDITION_LINK}unlinkedSuccess`))
    forgetPair(null)
  }

  async function applyChange(change: ChangePick): Promise<void> {
    const resolved = members.value
    const keptId = resolved ? (change.edition === 'audiobook' ? (resolved.text?.id ?? bookId) : resolved.audio.id) : bookId
    const pairId = pairBookId.value
    if (alignmentRunning.value && !(await alignment.cancel(pairId))) toast.error(t(`${EDITION_LINK}syncCancelKeptRunning`))
    if (!(await unlinkBook(pairId))) {
      toast.error(error.value ?? t(`${EDITION_LINK}unlinkFailed`))
      return
    }
    closeSearch()
    pendingStart.value = true
    if (!(await linkBook(change.candidate.bookId, keptId))) {
      pendingStart.value = false
      toast.error(t(`${CHAIN}toast.changeFailed`, { title: change.candidate.title ?? t(`${EDITION_LINK}unknownTitle`) }))
      // Offered again as the candidate, so a second try is one tap.
      forgetPair(change.candidate)
      return
    }
    await alignNewPair(keptId)
  }

  async function buildAlignment(force: boolean): Promise<void> {
    await alignment.build(pairBookId.value, force)
    if (alignment.error.value) toast.error(t('book.detail.readingAlignment.buildFailed'))
  }

  async function cancelAlignment(): Promise<void> {
    cancelling.value = true
    try {
      const cancelled = await alignment.cancel(pairBookId.value)
      if (!cancelled) toast.error(t(`${EDITION_LINK}syncCancelKeptRunning`))
    } finally {
      cancelling.value = false
    }
  }

  /* Read-along. */

  // With no link yet the read-along attaches to the audiobook alone, which starts a link without an ebook.
  // A detached read-along whose pair is not linked gets no output from the status read, but is the page's own book.
  async function attachReadAlong(): Promise<void> {
    const readAlongId = readAlong.outputBook.value?.id ?? (isReadAlongPage.value ? bookId : null)
    const target = link.value ? pairBookId.value : snapshot.value.audiobook.book?.id
    if (readAlongId === null || target === undefined) return
    if (await attachReadAlongBook(target, readAlongId)) toast.success(t(`${CHAIN}toast.attached`))
    else toast.error(t(`${CHAIN}toast.attachFailed`))
  }

  async function detachReadAlong(): Promise<void> {
    const member = readAlongMember.value
    if (!member) return
    // The detached output is still ready on a linked pair, which is exactly what the heal watch reloads for.
    // Set before the request because the detach's own reload fires that watch; a failed detach detached
    // nothing, so the heal is owed again.
    const healedBefore = reloadedForOutputId
    reloadedForOutputId = readAlong.outputBook.value?.id ?? member.id
    if (!(await unlinkBook(member.id))) {
      reloadedForOutputId = healedBefore
      toast.error(t(`${CHAIN}toast.detachFailed`))
      return
    }
    toast.success(t(`${CHAIN}toast.detached`))
    void readAlong.fetchStatus(pairBookId.value, link.value ? null : (selected.value?.bookId ?? null))
  }

  function openGenerate(): void {
    optionsOpen.value = true
    readAlongSection.loadTargetLibraries()
    // An aligned Storyteller book that already covers this pair can be imported instead of rebuilt.
    void readAlong.fetchExisting(pairBookId.value)
  }

  function collapseGenerate(): void {
    optionsOpen.value = false
  }

  function generate(): void {
    void readAlongSection.runBuild(readAlongSection.withDestination({}))
    collapseGenerate()
  }

  function importExisting(): void {
    const match = readAlongSection.existingMatch.value
    if (!match) return
    readAlongSection.handleImportExisting(match.uuid)
    collapseGenerate()
  }

  /* Confirms. */

  const dialogKind = ref<SyncChainDialogKind | null>(null)
  const dialogBusy = ref(false)

  function chainMessage(key: string, params?: Record<string, string | number>): ChainMessage {
    return params ? { key, params } : { key }
  }

  // Leaving from the audiobook dissolves the whole link; leaving from the ebook keeps the read-along on the audiobook.
  const unlinkPairDescription = computed(() => {
    if (!readAlongMember.value) return 'description'
    return thisBook.value === 'audiobook' ? 'descriptionReadAlong' : 'descriptionReadAlongStays'
  })

  const dialog = computed<SyncChainDialog | null>(() => {
    const kind = dialogKind.value
    switch (kind) {
      case 'unlinkPair':
        return {
          kind,
          title: chainMessage(`${CHAIN}confirm.unlinkPair.title`),
          description: chainMessage(`${CHAIN}confirm.unlinkPair.${unlinkPairDescription.value}`),
          confirmLabel: chainMessage(`${EDITION_LINK}unlink`),
        }
      case 'detachReadAlong':
        return {
          kind,
          title: chainMessage(`${CHAIN}confirm.detach.title`),
          description: chainMessage(`${CHAIN}confirm.detach.description`),
          confirmLabel: chainMessage(`${CHAIN}confirm.detach.confirm`),
        }
      case 'pauseAbs':
        return {
          kind,
          title: chainMessage(`${CHAIN}confirm.pauseAbs.title`),
          description: chainMessage(`${CHAIN}confirm.pauseAbs.description`),
          confirmLabel: chainMessage(`${CHAIN}confirm.pauseAbs.confirm`),
        }
      case 'change': {
        const change = changePick.value
        if (!change) return null
        return {
          kind,
          title: chainMessage(`${CHAIN}confirm.change.title`, { title: change.candidate.title ?? '' }),
          description: chainMessage(`${CHAIN}confirm.change.description`, { kind: t(`${CHAIN}short.${change.edition}`).toLocaleLowerCase() }),
          confirmLabel: chainMessage(`${CHAIN}confirm.change.confirm`),
        }
      }
      case 'rebuildReadAlong':
        return {
          kind,
          title: chainMessage(`${EDITION_LINK}readAlong.rebuildDialog.title`),
          description: chainMessage(`${EDITION_LINK}readAlong.rebuildDialog.description`, {
            title: readAlongMember.value?.title ?? t(`${EDITION_LINK}readAlong.readyPending`),
          }),
          confirmLabel: chainMessage(`${EDITION_LINK}readAlong.rebuildDialog.confirm`),
        }
      default:
        return null
    }
  })

  function openDialog(kind: SyncChainDialogKind): void {
    dialogKind.value = kind
  }

  function cancelDialog(): void {
    if (dialogBusy.value) return
    dialogKind.value = null
    changePick.value = null
  }

  async function runDialog(kind: SyncChainDialogKind): Promise<void> {
    switch (kind) {
      case 'unlinkPair':
        return unlinkPair()
      case 'detachReadAlong':
        return detachReadAlong()
      case 'pauseAbs':
        await absActions.pause()
        return
      case 'change':
        if (changePick.value) await applyChange(changePick.value)
        return
      case 'rebuildReadAlong':
        readAlongSection.handleRebuild()
        return
    }
  }

  async function confirmDialog(): Promise<void> {
    const kind = dialogKind.value
    if (!kind || dialogBusy.value) return
    dialogBusy.value = true
    try {
      await runDialog(kind)
    } finally {
      dialogBusy.value = false
      dialogKind.value = null
      changePick.value = null
    }
  }

  // A poll can retire the output while the dialog is open, and the dialog names that book and promises
  // to delete it. Once the read-along is no longer ready there is nothing to replace, so the question goes.
  watch(
    () => readAlong.status.value,
    (status) => {
      if (dialogKind.value === 'rebuildReadAlong' && status !== 'ready') dialogKind.value = null
    },
  )

  const canRequestReadAlongRebuild = computed(
    () =>
      isEligible.value &&
      link.value !== null &&
      readAlongMember.value !== null &&
      readAlong.status.value === 'ready' &&
      canGenerate.value &&
      canRebuild.value,
  )

  function openReadAlongRebuildConfirm(): void {
    if (canRequestReadAlongRebuild.value) openDialog('rebuildReadAlong')
  }

  /* Actions. */

  function rowEdition(rowKey: string | undefined): EditionKey | null {
    const row = chain.value.rows.find((candidate) => candidate.id === rowKey)
    return row && (row.kind === 'card' || row.kind === 'ghost') ? row.edition : null
  }

  function openCardChange(rowKey?: string): void {
    const edition = rowEdition(rowKey)
    if (edition) openChange(edition)
  }

  // A reconcile moves positions on both sides, and the cards read theirs from the link data.
  // A load already in flight was asked before the reconcile, so it would answer with the old positions.
  async function reconcileAbs(direction: AudiobookshelfReconcileDirection): Promise<void> {
    if (!(await absActions.reconcile(direction))) return
    invalidateLoad()
    await load()
  }

  const ACTIONS: Record<ChainActionId, (rowKey?: string) => void> = {
    linkPair: () => void linkPair(),
    cancelLinking: () => void cancelLinking(),
    cancelAlignment: () => void cancelAlignment(),
    retryAlignment: () => void buildAlignment(false),
    alignNow: () => void buildAlignment(false),
    rebuildAlignment: () => void buildAlignment(true),
    unlinkPair: () => openDialog('unlinkPair'),
    attachReadAlong: () => void attachReadAlong(),
    openGenerate,
    generate,
    cancelGenerate: collapseGenerate,
    importExisting,
    cancelReadAlong: () => void readAlongSection.handleCancel(),
    retryReadAlong: () => readAlongSection.handleRetry(),
    rebuildReadAlong: () => openDialog('rebuildReadAlong'),
    toggleLog: () => {
      logOpen.value = !logOpen.value
    },
    change: openCardChange,
    retryAbs: () => void absActions.retry(),
    absPush: () => void reconcileAbs('push'),
    absPull: () => void reconcileAbs('pull'),
    confirmAbs: () => void absActions.confirm(),
    resumeAbs: () => void absActions.resume(),
  }

  function runAction(id: ChainActionId, rowKey?: string): void {
    ACTIONS[id](rowKey)
  }

  const OFF_DIALOG = { pair: 'unlinkPair', readAlong: 'detachReadAlong', abs: 'pauseAbs' } as const

  // Switches are derived from the data, so a cancelled confirm leaves them where they were by itself.
  function switchConnector(key: ConnectorKey, next: boolean): void {
    const row = chain.value.rows.find((candidate): candidate is ChainConnectorRow => candidate.kind === 'connector' && candidate.key === key)
    const toggle = row?.switch
    if (!row || !toggle || toggle.disabled) return
    if (next) {
      if (toggle.onAction) runAction(toggle.onAction, row.id)
      return
    }
    if (!toggle.offTarget) return
    if (row.state === 'linking' && toggle.offTarget === 'pair') {
      void cancelLinking()
      return
    }
    openDialog(OFF_DIALOG[toggle.offTarget])
  }

  const busy = computed(
    () => mutating.value || alignment.mutating.value || readAlong.mutating.value || absActions.busy.value !== null || dialogBusy.value,
  )

  /* Trigger. */

  const readAlongBusy = computed(() => readAlong.mutating.value || isReadAlongInFlight(readAlong.status.value))

  const triggerIconClass = computed(() => {
    if (!link.value) return ''
    if (alignmentRunning.value || readAlongBusy.value) return 'text-info'
    if (readAlong.status.value === 'failed' || alignment.status.value === 'failed') return 'text-destructive'
    if (alignment.status.value === 'ready') return alignment.stale.value ? 'text-warning' : 'text-success'
    return 'text-primary'
  })

  const triggerTooltip = computed(() => {
    if (!link.value) {
      return modality.value === 'audio' ? t(`${EDITION_LINK}tooltipNeedsText`) : t(`${EDITION_LINK}tooltipNeedsAudio`)
    }
    if (readAlong.status.value === 'queued') return t(`${EDITION_LINK}tooltipReadAlongQueued`)
    if (readAlongBusy.value) return t(`${EDITION_LINK}tooltipReadAlongBuilding`)
    if (alignmentRunning.value) return t(`${EDITION_LINK}tooltipAligning`)
    if (readAlong.status.value === 'failed') return t(`${EDITION_LINK}tooltipReadAlongFailed`)
    if (alignment.status.value === 'ready') return t(`${EDITION_LINK}${alignment.stale.value ? 'tooltipAlignStale' : 'tooltipAligned'}`)
    if (alignment.status.value === 'failed') return t(`${EDITION_LINK}tooltipAlignFailed`)
    if (members.value && !members.value.text) return t(`${EDITION_LINK}tooltipNeedsText`)
    return t(`${EDITION_LINK}tooltipLinked`)
  })

  /* Loading. */

  function fetchBuildStatuses(): Promise<unknown> {
    if (!link.value) return Promise.resolve()
    return Promise.allSettled([alignment.fetchStatus(pairBookId.value), readAlong.fetchStatus(pairBookId.value, null)])
  }

  // Read up front so the trigger's hover title reflects the real state before the popover is opened.
  async function loadInitial(): Promise<void> {
    await load()
    void fetchBuildStatuses()
  }

  // A finished build adds the read-along member, which only the for-book response knows about.
  readAlong.onReady(() => {
    void load()
  })

  // Picking another counterpart before linking changes the pair, and so whether a read-along exists for it.
  watch(
    () => selected.value?.bookId,
    (counterpartId, previous) => {
      // A link or unlink reloads this book, and whatever runs it narrates the pair it leaves behind.
      if (link.value || mutating.value || counterpartId === previous) return
      const followed = forBookCounterpartId()
      const answeredFor = requestedCounterpartId ?? proposed.value?.bookId ?? null
      if (followed !== null && followed !== answeredFor) void load()
      if (!canGenerate.value || isReadAlongInFlight(readAlong.status.value)) return
      void readAlong.fetchStatus(pairBookId.value, counterpartId ?? null)
      // Read after the status, which is what records the new counterpart for this lookup.
      if (optionsOpen.value) void readAlong.fetchExisting(pairBookId.value)
    },
  )

  // A build of an unlinked pair is only reachable through its pick, so a reopen during it, after it
  // failed, or after it finished with its output attached to no link has to show that pair rather than the proposal.
  const keepsPick = computed(
    () =>
      isReadAlongInFlight(readAlong.status.value) ||
      readAlong.status.value === 'failed' ||
      (readAlong.status.value === 'ready' && readAlong.outputBook.value !== null && readAlongMember.value === null),
  )

  function resetUi(): void {
    if (!keepsPick.value) {
      picked.value = null
      proposalDismissed.value = false
    }
    changing.value = null
    changePick.value = null
    dialogKind.value = null
    optionsOpen.value = false
    logOpen.value = false
    query.value = ''
    hasSearched.value = false
    searchAutofocus.value = false
    resetSearch()
    absActions.search.reset()
    // Closing and reopening on another candidate would otherwise start an hours-long build with
    // choices nobody re-confirmed.
    readAlongSection.resetChoices()
  }

  async function handleOpen(): Promise<void> {
    const current = ++openId
    resetUi()
    absActions.clearError()
    viewMode.value = null
    promotedThisOpen = false
    const absConfigured = abs.loadConfigured()
    await load()
    let statuses: Promise<unknown> = Promise.resolve()
    if (link.value) {
      statuses = fetchBuildStatuses()
      if (canGenerate.value && !readAlongMember.value) {
        void readAlong.fetchExisting(pairBookId.value)
        readAlongSection.loadTargetLibraries()
      }
    } else if (canGenerate.value || selected.value) {
      // Read on an unlinked book too: the chain has to know whether Storyteller is usable at all, and
      // whether the matched pair already has a read-along that the link would bring back. A reader who
      // cannot generate still needs it to see a build someone else queued for the pair on screen.
      statuses = Promise.allSettled([readAlong.fetchStatus(pairBookId.value, selected.value?.bookId ?? null)])
      if (canGenerate.value) readAlongSection.loadTargetLibraries()
    }
    void abs.refreshLive()
    await Promise.allSettled([statuses, absConfigured])
    if (current === openId) decideView()
  }

  return {
    isEligible,
    triggerIconClass,
    triggerTooltip,
    initialLoading,
    chain,
    abs,
    absActions,
    viewMode,
    setViewMode,
    prepareView,
    optionsOpen,
    logOpen,
    changing,
    search: {
      query,
      candidates,
      searching,
      searchError,
      hasSearched,
      autofocus: searchAutofocus,
      setQuery,
      pick,
      pickAbsItem,
      close: closeSearch,
    },
    readAlongOptions: {
      targetLibraries: readAlongSection.targetLibraries,
      chosenTargetLibraryId: readAlongSection.chosenTargetLibraryId,
      targetLibraryName: readAlongSection.targetLibraryName,
      keepRemoteCopy: readAlong.keepRemoteCopy,
      reclaimable: readAlong.remoteCopyReclaimable,
      existingMatch: readAlongSection.existingMatch,
      busy: readAlong.mutating,
      setTargetLibrary: readAlongSection.setTargetLibrary,
      setKeepRemoteCopy: readAlong.setKeepRemoteCopy,
    },
    runAction,
    switchConnector,
    dialog,
    dialogBusy,
    confirmDialog,
    cancelDialog,
    busy,
    cancelling,
    loadInitial,
    handleOpen,
    canRequestReadAlongRebuild,
    openReadAlongRebuildConfirm,
  }
}

export type SyncChainPanelState = ReturnType<typeof useSyncChainPanel>
export type SyncChainPanelView = UnwrapNestedRefs<SyncChainPanelState>
