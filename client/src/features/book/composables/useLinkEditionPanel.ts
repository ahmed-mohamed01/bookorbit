import { computed, ref, watch, type UnwrapNestedRefs } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Permission, type BookDetail, type EditionLinkMember } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { isTickBlockReason } from '@/features/book/lib/read-along-blocks'
import { isTerminalBlock } from '@/features/book/lib/position-sync'
import { getBookLinkModality, useEditionLink, type EditionLinkCandidate } from './useEditionLink'
import { useReadingAlignment, type AlignmentStatus } from './useReadingAlignment'
import { useReadAlongSection } from './useReadAlongSection'

export type LinkEditionPhase = 'nomatch' | 'matched' | 'linking' | 'linked'
export type EditionFormat = 'ebook' | 'audiobook'

export type EditionMatchChip = { source: 'auto'; score: number } | { source: 'manual' }

export interface EditionFilledSlot {
  kind: 'filled'
  format: EditionFormat
  bookId: number
  coverVersion: string | null
  title: string | null
  authorName: string | null
  progress: number | null
  isThisBook: boolean
  match: EditionMatchChip | null
  canChange: boolean
}

export interface EditionSearchSlot {
  kind: 'search'
  format: EditionFormat
}

export type EditionSlot = EditionFilledSlot | EditionSearchSlot

const ALIGNMENT_RUNNING = new Set<AlignmentStatus>(['pending', 'building'])
const ALIGNMENT_UNSYNCED = new Set<AlignmentStatus>(['failed', 'unalignable'])

function toCandidate(member: EditionLinkMember, score: number): EditionLinkCandidate {
  return { bookId: member.id, title: member.title, authorName: member.authorName, coverVersion: member.coverVersion, score }
}

export function useLinkEditionPanel(book: () => BookDetail) {
  const { t } = useI18n()
  const bookId = book().id

  const { hasPermission } = usePermissions()
  const canEditMetadata = computed(() => hasPermission(Permission.LibraryEditMetadata))

  const {
    link,
    proposed,
    role,
    members,
    linkedCounterpart,
    candidates,
    loading,
    searching,
    mutating,
    error,
    searchError,
    loadForBook,
    searchCandidates,
    linkBook,
    unlink: unlinkBook,
    resetSearch,
  } = useEditionLink(bookId)

  const alignment = useReadingAlignment()
  const readAlongSection = useReadAlongSection(() => book().id)
  const { readAlong, canGenerate } = readAlongSection

  // Only the first load shows the skeleton. Later reloads (after a link, an unlink or a finished
  // read-along) keep the pair box mounted, so its transitions play and focus stays where it was.
  const loadedOnce = ref(false)
  const initialLoading = computed(() => loading.value && !loadedOnce.value)

  async function load(): Promise<void> {
    await loadForBook()
    loadedOnce.value = true
  }

  const modality = computed(() => getBookLinkModality(book().files))
  // The read-along book is a member of the link, so its own page shows the membership read only: it
  // can never start or end a link of its own.
  const isReadAlongPage = computed(() => role.value === 'readAlong')
  const isEligible = computed(() => modality.value === 'text' || modality.value === 'audio' || isReadAlongPage.value)
  const currentFormat = computed<EditionFormat>(() => (modality.value === 'audio' ? 'audiobook' : 'ebook'))
  const counterpartFormat = computed<EditionFormat>(() => (currentFormat.value === 'ebook' ? 'audiobook' : 'ebook'))

  // A pick from the search replaces the server's proposal; "Change" clears both until a new pick.
  const picked = ref<EditionLinkCandidate | null>(null)
  const proposalDismissed = ref(false)
  const selected = computed(() => picked.value ?? (proposalDismissed.value ? null : proposed.value))
  const matchChip = computed<EditionMatchChip | null>(() => {
    if (picked.value) return { source: 'manual' }
    const candidate = selected.value
    return candidate ? { source: 'auto', score: candidate.score } : null
  })

  const alignmentRunning = computed(() => ALIGNMENT_RUNNING.has(alignment.status.value) || alignment.mutating.value)

  // Linking narrates a pair's first alignment, wherever it was started and however often the panel
  // reopens. A rebuild keeps the previous built date, so an established pair stays linked and its
  // position sync section says it is aligning.
  const firstAlignment = computed(() => alignmentRunning.value && alignment.builtAt.value === null)

  const phase = computed<LinkEditionPhase>(() => {
    if (isReadAlongPage.value) return 'linked'
    if (link.value) return firstAlignment.value ? 'linking' : 'linked'
    return selected.value ? 'matched' : 'nomatch'
  })

  // Set only when the search slot appears through Change, where the user is about to type.
  const searchAutofocus = ref(false)

  // The server re-attaches an existing read-along to a relinked pair on a status read, and the link is
  // not refetched for it, so until then the status read is the only place that names it. The link's own
  // member wins once present.
  const readAlongMember = computed<EditionLinkMember | null>(() => {
    const linked = members.value?.readAlong
    if (linked) return linked
    const output = readAlong.outputBook.value
    if (!link.value || readAlong.status.value !== 'ready' || !output) return null
    return { id: output.id, title: output.title, authorName: null, coverVersion: null, progress: null, narrationPercentage: null }
  })
  const readAlongIsCurrentBook = computed(() => readAlongMember.value?.id === bookId)

  const query = ref('')
  const hasSearched = ref(false)

  // Deliberately per visit: a read-along is hours of CPU and hundreds of MB, so it is asked for each
  // time rather than carried over from some earlier link.
  const generateOnLink = ref(false)

  const tickBlockReason = computed(() => {
    const blocked = readAlong.blocked.value
    return isTickBlockReason(blocked) ? blocked : null
  })
  const toggleDisabled = computed(() => !canGenerate.value || tickBlockReason.value !== null)
  const willGenerate = computed(() => generateOnLink.value && !toggleDisabled.value)
  const canToggleReadAlong = computed(() => canEditMetadata.value && canGenerate.value)

  // A viewer who cannot link sees a suggested pair, not an offer: there is nothing to build or toggle.
  const matchedReadOnly = computed(() => phase.value === 'matched' && !canEditMetadata.value)
  const showSections = computed(() => phase.value !== 'nomatch' && !matchedReadOnly.value)
  // Before the link, the read-along section is only the toggle, so a user who cannot take it sees none.
  const showReadAlong = computed(() => phase.value !== 'matched' || canToggleReadAlong.value)

  const syncUnavailable = computed(() => ALIGNMENT_UNSYNCED.has(alignment.status.value) || isTerminalBlock(alignment.buildBlocked.value))

  const ctaKey = computed(() => (willGenerate.value ? 'book.detail.editionLink.cta.linkAndGenerate' : 'book.detail.editionLink.cta.link'))

  const chipKey = computed(() => {
    switch (phase.value) {
      case 'linked':
        return 'book.detail.editionLink.chip.linked'
      case 'linking':
        return 'book.detail.editionLink.chip.linking'
      case 'nomatch':
        return 'book.detail.editionLink.chip.noMatch'
      default:
        return matchedReadOnly.value ? 'book.detail.editionLink.chip.suggested' : 'book.detail.editionLink.chip.ready'
    }
  })

  const introKey = computed(() => {
    switch (phase.value) {
      case 'linked':
        return syncUnavailable.value ? 'book.detail.editionLink.intro.linkedUnsynced' : 'book.detail.editionLink.intro.linked'
      case 'linking':
        return 'book.detail.editionLink.intro.linking'
      case 'nomatch':
        return counterpartFormat.value === 'audiobook'
          ? 'book.detail.editionLink.intro.noMatchAudiobook'
          : 'book.detail.editionLink.intro.noMatchEbook'
      default:
        return matchedReadOnly.value ? 'book.detail.editionLink.intro.matchedReadOnly' : 'book.detail.editionLink.intro.matched'
    }
  })

  function memberSlot(format: EditionFormat, member: EditionLinkMember): EditionFilledSlot {
    const isThisBook = member.id === bookId
    return {
      kind: 'filled',
      format,
      bookId: member.id,
      coverVersion: isThisBook ? book().coverVersion : member.coverVersion,
      title: member.title,
      authorName: member.authorName,
      progress: member.progress?.percentage ?? null,
      isThisBook,
      match: null,
      canChange: false,
    }
  }

  const currentSlot = computed<EditionFilledSlot>(() => {
    const current = book()
    return {
      kind: 'filled',
      format: currentFormat.value,
      bookId: current.id,
      coverVersion: current.coverVersion,
      title: current.title,
      authorName: current.authors.map((author) => author.name).join(', ') || null,
      progress: null,
      isThisBook: true,
      match: null,
      canChange: false,
    }
  })

  const counterpartSlot = computed<EditionSlot>(() => {
    const candidate = selected.value
    if (!candidate) return { kind: 'search', format: counterpartFormat.value }
    return {
      kind: 'filled',
      format: counterpartFormat.value,
      bookId: candidate.bookId,
      coverVersion: candidate.coverVersion,
      title: candidate.title,
      authorName: candidate.authorName,
      progress: null,
      isThisBook: false,
      match: matchChip.value,
      canChange: canEditMetadata.value,
    }
  })

  // Ebook above, audiobook below, whichever page the panel is opened from.
  const slots = computed<[EditionSlot, EditionSlot]>(() => {
    const resolved = members.value
    if (link.value && resolved) return [memberSlot('ebook', resolved.text), memberSlot('audiobook', resolved.audio)]
    return currentFormat.value === 'ebook' ? [currentSlot.value, counterpartSlot.value] : [counterpartSlot.value, currentSlot.value]
  })

  // Before a pair exists there is nothing to align, so a stale status from a cancelled link must not
  // narrate a build that no longer belongs to this panel.
  const syncStatus = computed<AlignmentStatus>(() => (link.value ? alignment.status.value : 'none'))
  const canBuildSync = computed(() => canEditMetadata.value && link.value !== null && !isReadAlongPage.value)

  const readAlongMode = computed<'offer' | 'manage' | 'readOnly'>(() => {
    if (isReadAlongPage.value) return 'readOnly'
    return phase.value === 'matched' ? 'offer' : 'manage'
  })

  const alignmentBusy = computed(() => alignmentRunning.value)
  const readAlongBusy = computed(() => readAlong.mutating.value || readAlong.status.value === 'building')

  const triggerIconClass = computed(() => {
    if (!link.value) return ''
    if (alignmentBusy.value || readAlongBusy.value) return 'text-info'
    if (readAlong.status.value === 'failed' || alignment.status.value === 'failed') return 'text-destructive'
    if (alignment.status.value === 'ready') return 'text-success'
    return 'text-primary'
  })

  const triggerTooltip = computed(() => {
    if (!link.value) {
      return modality.value === 'audio' ? t('book.detail.editionLink.tooltipNeedsText') : t('book.detail.editionLink.tooltipNeedsAudio')
    }
    if (readAlongBusy.value) return t('book.detail.editionLink.tooltipReadAlongBuilding')
    if (alignmentBusy.value) return t('book.detail.editionLink.tooltipAligning')
    if (readAlong.status.value === 'failed') return t('book.detail.editionLink.tooltipReadAlongFailed')
    if (alignment.status.value === 'ready') return t('book.detail.editionLink.tooltipAligned')
    if (alignment.status.value === 'failed') return t('book.detail.editionLink.tooltipAlignFailed')
    return t('book.detail.editionLink.tooltipLinked')
  })

  function refreshBuildStatuses(): void {
    if (!link.value) return
    void alignment.fetchStatus(bookId)
    void readAlong.fetchStatus(bookId)
  }

  // Read up front so the trigger's hover title reflects the real state before the popover is opened.
  async function loadInitial(): Promise<void> {
    await load()
    refreshBuildStatuses()
  }

  // A finished build adds the third member, which only the for-book response knows about.
  readAlong.onReady(() => {
    void load()
  })

  // A relinked pair whose read-along still exists has the member backfilled during the status read,
  // after the link response was loaded, and onReady never fires for it (none -> ready). Reloaded once
  // per output book, so a for-book answer that still lacks the member cannot loop.
  let reloadedForOutputId: number | null = null
  const missingReadAlongMemberId = computed(() => {
    const output = readAlong.outputBook.value
    if (!link.value || readAlong.status.value !== 'ready' || !output || members.value?.readAlong) return null
    return output.id
  })
  watch(missingReadAlongMemberId, (outputId) => {
    if (outputId === null || outputId === reloadedForOutputId) return
    reloadedForOutputId = outputId
    void load()
  })

  function runSearch(): void {
    hasSearched.value = true
    void searchCandidates(query.value)
  }

  async function handleOpen(): Promise<void> {
    query.value = ''
    hasSearched.value = false
    resetSearch()
    picked.value = null
    proposalDismissed.value = false
    searchAutofocus.value = false
    // Toggling, closing without linking and reopening on a different candidate would otherwise start
    // an hours-long build nobody re-confirmed. The destination and keep-copy choices go with it.
    generateOnLink.value = false
    readAlongSection.resetChoices()

    await load()
    if (link.value) {
      refreshBuildStatuses()
      if (canGenerate.value && !isReadAlongPage.value && !readAlongMember.value) {
        // An aligned Storyteller book that already covers this pair can be imported instead of rebuilt.
        void readAlong.fetchExisting(bookId)
        readAlongSection.loadTargetLibraries()
      }
    } else if (canGenerate.value) {
      // Read on an unlinked book too: the toggle has to know whether Storyteller is usable at all.
      void readAlong.fetchStatus(bookId)
      readAlongSection.loadTargetLibraries()
    }
    if (canEditMetadata.value && !link.value && !proposed.value) runSearch()
  }

  function setQuery(value: string): void {
    query.value = value
    runSearch()
  }

  function selectCandidate(candidate: EditionLinkCandidate): void {
    picked.value = candidate
    query.value = ''
    searchAutofocus.value = false
  }

  function changeSelection(): void {
    picked.value = null
    proposalDismissed.value = true
    query.value = ''
    searchAutofocus.value = true
    runSearch()
  }

  function setGenerateOnLink(value: boolean): void {
    generateOnLink.value = value
  }

  async function startLink(): Promise<void> {
    const candidate = selected.value
    if (!candidate) return
    const shouldGenerate = willGenerate.value
    const success = await linkBook(candidate.bookId)
    if (!success) {
      toast.error(error.value ?? t('book.detail.editionLink.linkFailed'))
      return
    }
    toast.success(t('book.detail.editionLink.linkedSuccess'))
    query.value = ''
    void alignment.build(bookId)
    if (shouldGenerate && !toggleDisabled.value) {
      void readAlongSection.runBuild(readAlongSection.withDestination({}))
      return
    }
    // The pre-link read answered for a book without a pair ('no_pair'), which would keep Generate
    // disabled until the panel is reopened.
    void readAlong.fetchStatus(bookId)
    if (canGenerate.value) void readAlong.fetchExisting(bookId)
  }

  function linkedCounterpartCandidate(): EditionLinkCandidate | null {
    const resolved = members.value
    const counterpart = resolved ? (role.value === 'audio' ? resolved.text : resolved.audio) : null
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

  // Nothing read for the old pair may narrate the next one: a relink with another counterpart would
  // otherwise show the previous pair's Synced, Built or Ready until the new reads land.
  function forgetPair(): void {
    readAlong.reset()
    void alignment.fetchStatus(bookId)
    void readAlong.fetchStatus(bookId)
  }

  // Stops whatever this link started, then unlinks. A cancel the server refuses is reported and the
  // unlink still happens, except for a read-along already being imported onto this link: unlinking
  // then would strand the imported book or fail the build's own link write, so the link stays.
  async function cancelLinking(): Promise<void> {
    const candidate = linkedCounterpartCandidate()
    if (readAlong.status.value === 'building' || readAlong.mutating.value) {
      const outcome = await readAlong.cancel(bookId)
      if (outcome === 'too_late') {
        toast.error(t('book.detail.editionLink.readAlong.cancelTooLate'))
        return
      }
      if (outcome === 'failed') toast.error(t('book.detail.editionLink.readAlong.cancelKeptRunning'))
    }
    if (alignmentRunning.value) {
      const cancelled = await alignment.cancel(bookId)
      if (!cancelled) toast.error(t('book.detail.editionLink.syncCancelKeptRunning'))
    }
    const success = await unlinkBook()
    if (!success) {
      toast.error(t('book.detail.editionLink.cancelFailed'))
      return
    }
    forgetPair()
    restoreSelection(candidate)
  }

  async function unlink(): Promise<void> {
    const success = await unlinkBook()
    if (!success) {
      toast.error(error.value ?? t('book.detail.editionLink.unlinkFailed'))
      return
    }
    toast.success(t('book.detail.editionLink.unlinkedSuccess'))
    forgetPair()
    restoreSelection(null)
  }

  async function buildSync(force: boolean): Promise<void> {
    await alignment.build(bookId, force)
    if (alignment.error.value) toast.error(t('book.detail.readingAlignment.buildFailed'))
  }

  return {
    canEditMetadata,
    link,
    members,
    linkedCounterpart,
    candidates,
    initialLoading,
    searching,
    mutating,
    searchError,
    alignment,
    readAlongSection,
    readAlongMember,
    readAlongIsCurrentBook,
    isEligible,
    isReadAlongPage,
    counterpartFormat,
    phase,
    selected,
    slots,
    query,
    hasSearched,
    generateOnLink,
    toggleDisabled,
    tickBlockReason,
    canToggleReadAlong,
    showSections,
    showReadAlong,
    searchAutofocus,
    ctaKey,
    chipKey,
    introKey,
    syncStatus,
    canBuildSync,
    readAlongMode,
    triggerIconClass,
    triggerTooltip,
    loadInitial,
    handleOpen,
    setQuery,
    selectCandidate,
    changeSelection,
    setGenerateOnLink,
    startLink,
    cancelLinking,
    unlink,
    buildSync,
  }
}

export type LinkEditionPanelState = ReturnType<typeof useLinkEditionPanel>
export type LinkEditionPanelView = UnwrapNestedRefs<LinkEditionPanelState>
