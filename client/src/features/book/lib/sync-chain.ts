import type {
  AlignmentBuildBlockReason,
  AlignmentStatus,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  EditionLinkMember,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  ReadAloudProgressSync,
} from '@bookorbit/types'
import { isTerminalBlock } from '@/features/book/lib/position-sync'
import { displayPercentage } from '@/features/book/lib/abs-sync-status'
import { isActionBlocked, READ_ALONG_STAGES, stageIndex } from '@/features/book/lib/read-along-section'
import { readAloudSyncIssueMessage } from '@/features/book/lib/read-aloud-sync-issue'

/**
 * The Position sync panel as a modality chain: the editions that sync with each other as cards in a
 * fixed order joined by connectors that each carry their own state and switch, and everything else
 * waiting in an Available section underneath. `buildSyncChain` turns one snapshot of the panel's
 * composables into that row list; it is pure so every state can be pinned by a unit test.
 */

export type EditionFormat = 'ebook' | 'audiobook'

export type EditionKey = 'ebook' | 'readAlong' | 'audiobook' | 'abs'
export const EDITION_ORDER: readonly EditionKey[] = ['ebook', 'readAlong', 'audiobook', 'abs']

export type ConnectorKey = 'ebook-readAlong' | 'readAlong-audiobook' | 'ebook-audiobook' | 'audiobook-abs'

export type ChainTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'
export type ChainIcon = 'link' | 'spinner' | 'alert' | 'ban'
export type ChainViewMode = 'compact' | 'modify'

/** What a connector's switch turns off, picked by `offTargetFor`: the side farther from this book. */
export type ChainOffTarget = 'pair' | 'readAlong' | 'abs'

export type ChainActionId =
  | 'linkPair'
  | 'cancelLinking'
  | 'cancelAlignment'
  | 'retryAlignment'
  | 'alignNow'
  | 'rebuildAlignment'
  | 'unlinkPair'
  | 'attachReadAlong'
  | 'detachReadAlong'
  | 'openGenerate'
  | 'generate'
  | 'cancelGenerate'
  | 'importExisting'
  | 'cancelReadAlong'
  | 'retryReadAlong'
  | 'rebuildReadAlong'
  | 'toggleLog'
  | 'openSearch'
  | 'change'
  | 'retryAbs'
  | 'absPush'
  | 'absPull'
  | 'confirmAbs'
  | 'resumeAbs'
  | 'pauseAbs'

/** A translated line: the i18n key and its interpolation params, resolved by the component with `t()`. */
export interface ChainMessage {
  key: string
  params?: Record<string, string | number>
}

export interface ChainAction {
  id: ChainActionId
  label: ChainMessage
  disabled: boolean
}

/* Snapshot: what the composables know at one instant. */

export interface SyncChainBook {
  id: number
  title: string | null
  authorName: string | null
  coverVersion: string | null
  /** 0..100, null when nothing is recorded. */
  progress: number | null
}

export type EditionMatchChip = { source: 'auto'; score: number } | { source: 'manual' } | { source: 'pair' }

/** One side of the ebook/audiobook pair: the book in that slot, if any, and how it got there. */
export interface SyncChainSide {
  book: SyncChainBook | null
  isMember: boolean
  isThisBook: boolean
  /** How the book was chosen while not yet a member: a server proposal, a pick, or the read-along's own pair. */
  match: EditionMatchChip | null
}

export interface SyncChainAlignment {
  status: AlignmentStatus
  stale: boolean
  builtAt: string | null
  samplesDone: number | null
  samplesTotal: number | null
  buildBlocked: AlignmentBuildBlockReason | null
  buildError: string | null
  /** A build is queued or running, including the window between a link and the first optimistic 'building'. */
  running: boolean
}

export interface SyncChainReadAlong {
  /** Strictly the link's own read-along member; a detached output never counts. */
  member: EditionLinkMember | null
  status: ReadAlongStatus
  blocked: ReadAlongBlockReason | null
  phase: ReadAlongPhase | null
  remoteTask: string | null
  remoteProgress: number | null
  queuePosition: number | null
  outputBook: ReadAlongOutputBook | null
  /** The current book, set only on the read-along's own page, where neither the link nor the status read returns it. */
  thisBook: SyncChainBook | null
  error: string | null
  mutating: boolean
  /** The output is ready and the link is being reloaded to pick up its member, so no row is shown yet. */
  memberPending: boolean
  targetLibraryName: string | null
}

export interface SyncChainAbs {
  link: AudiobookshelfBookSyncLink | null
  live: AudiobookshelfBookSyncLive | null
  checking: boolean
}

export interface SyncChainPermissions {
  editLink: boolean
  generate: boolean
  rebuild: boolean
}

export interface SyncChainSnapshot {
  thisBook: Exclude<EditionKey, 'abs'>
  linked: boolean
  ebook: SyncChainSide
  audiobook: SyncChainSide
  alignment: SyncChainAlignment
  readAlong: SyncChainReadAlong
  /** The read-along's fit with its audiobook when it is not syncing; only known on the audiobook or read-along page. */
  readAloudIssue: ReadAloudProgressSync | null
  /** Null without the Audiobookshelf sync permission. */
  abs: SyncChainAbs | null
  can: SyncChainPermissions
}

/* Rows. */

export type ChainCover =
  | { kind: 'book'; bookId: number; coverVersion: string | null }
  | { kind: 'abs'; absLibraryItemId: string }
  | { kind: 'readAlongTile' }
  | { kind: 'none' }

export interface ChainReadAlongJob {
  /** Index into the four build stages (Sending, Transcribing, Aligning, Importing). */
  stage: number
  remoteProgress: number | null
  /** The build failed at `stage`, so the stepper shows that step as failed instead of in progress. */
  failed: boolean
  cancel: ChainAction | null
  retry: ChainAction | null
  error: string | null
}

export interface ChainCardRow {
  kind: 'card'
  id: string
  edition: EditionKey
  cover: ChainCover
  title: string | null
  /** Author for a book, library for the Audiobookshelf item. */
  subtitle: string | null
  /** The book page the title links to; null for this book and for Audiobookshelf. */
  routeBookId: number | null
  /** Audiobookshelf's own page for the item, opened in a new tab. */
  href: string | null
  isThisBook: boolean
  external: boolean
  progress: number | null
  /** The live check is still running, so the progress bar shows a shimmer. */
  progressPending: boolean
  /** Modify-only Change: offered, blocked while a read-along exists (shown disabled with `c.change.blocked`), or absent. */
  change: 'available' | 'blocked' | 'none'
  rebuild: ChainAction | null
  /** A read-along member being rebuilt shows its stepper and cancel or retry under the card. */
  job: ChainReadAlongJob | null
}

export type ChainConnectorState =
  | 'linking'
  | 'rebuilding'
  | 'alignmentFailed'
  | 'outOfDate'
  | 'cantAlign'
  | 'alignmentBlocked'
  | 'notAligned'
  | 'linkedViaWhisper'
  | 'linked'
  | 'available'
  | 'readAloudIssue'
  | 'absUnreachable'
  | 'absDiverged'
  | 'absReceiving'
  | 'absSending'
  | 'absOneWay'
  | 'absLinked'

export interface ChainSwitch {
  on: boolean
  disabled: boolean
  /** Turning it on runs this action; turning it off opens the confirm for `offTarget` (or cancels while linking). */
  onAction: ChainActionId | null
  offTarget: ChainOffTarget | null
}

export interface ChainConnectorRow {
  kind: 'connector'
  id: string
  key: ConnectorKey
  from: EditionKey
  to: EditionKey
  state: ChainConnectorState
  tone: ChainTone
  dashed: boolean
  icon: ChainIcon
  pill: ChainMessage
  /** Null when the switch is hidden (failed alignment). */
  switch: ChainSwitch | null
  note: ChainMessage | null
  /** Literal text under the note, such as the alignment build error. */
  detail: string | null
  actions: ChainAction[]
  /** The X beside the ticks while aligning. */
  cancel: ChainAction | null
  /** Sample progress while aligning, rendered as PositionSyncTicks. */
  ticks: { samplesDone: number | null; samplesTotal: number | null } | null
  settingsLink: boolean
  /** Audiobookshelf states render SyncChainAbsDetails (hint and reconcile buttons from the live status) instead of note and actions. */
  absDetails: boolean
  /** Compact view: text only for non-success states, and at most one action. */
  mini: { text: ChainMessage | null; action: ChainAction | null }
}

export interface ChainAvailableHeaderRow {
  kind: 'availableHeader'
  id: 'available-header'
}

export type ChainAvailableVariant =
  | 'candidate'
  | 'search'
  | 'readAlongQueued'
  | 'readAlongBuilding'
  | 'readAlongFailed'
  | 'readAlongDetached'
  | 'readAlongWaitingForPair'
  | 'readAlongOutOfReach'
  | 'readAlongNeedsPair'
  | 'readAlongBlocked'
  | 'readAlongNotGenerated'
  | 'absPositionSyncOff'
  | 'absNeedsAudio'
  | 'absNeedsReview'
  | 'absPaused'

export interface ChainAvailableRow {
  kind: 'available'
  id: string
  edition: EditionKey
  variant: ChainAvailableVariant
  cover: ChainCover
  label: ChainMessage
  note: ChainMessage
  /** The one outline action; `locked` renders it disabled with the note explaining why. */
  action: ChainAction | null
  locked: boolean
  /** A text link beside the action, such as "Not this one?" or "View log". */
  secondary: ChainAction | null
  settingsLink: boolean
  /** The red X for a job in flight. */
  cancel: ChainAction | null
  job: ChainReadAlongJob | null
  /** Error text shown under the row while "View log" is open. */
  log: string | null
  /** The row can expand into the generate options block or the search. */
  expandable: boolean
  /** Counts toward the header's "{n} of {m}". */
  present: boolean
}

export type ChainRow = ChainCardRow | ChainConnectorRow | ChainAvailableHeaderRow | ChainAvailableRow

export interface SyncChainHeader {
  tone: ChainTone
  label: ChainMessage
}

export interface SyncChain {
  rows: ChainRow[]
  header: SyncChainHeader
  intro: ChainMessage
  /** A failure or a check-sync state is showing, so the panel opens in Modify. */
  needsAttention: boolean
  /** Member cards, Audiobookshelf included. */
  inSync: number
  /** Cards plus the Available rows that count as present. */
  present: number
}

const CHAIN = 'book.detail.editionLink.chain.'
const EDITION_LINK = 'book.detail.editionLink.'

const SHORT_LABEL_KEY: Record<EditionKey, string> = {
  ebook: 'short.ebook',
  readAlong: 'short.readAlong',
  audiobook: 'short.audiobook',
  abs: 'kind.abs',
}

const PANEL_CHROME_HEIGHT = 96
const HEIGHT_SLACK = 24
const MODIFY_CARD_HEIGHT = 76
const MODIFY_CARD_JOB_HEIGHT = 40
const MODIFY_CONNECTOR_HEIGHT = 52
const MODIFY_CONNECTOR_NOTE_HEIGHT = 34
const MODIFY_CONNECTOR_ACTIONS_HEIGHT = 36
const MODIFY_CONNECTOR_TICKS_HEIGHT = 20
const AVAILABLE_HEADER_HEIGHT = 34
const AVAILABLE_ROW_HEIGHT = 56
const AVAILABLE_ROW_JOB_HEIGHT = 28
const AVAILABLE_ROW_EXPANDED_HEIGHT = 150
const COMPACT_CARD_HEIGHT = 56
const COMPACT_CONNECTOR_HEIGHT = 30
const COMPACT_CONNECTOR_TEXT_HEIGHT = 34

function msg(key: string, params?: Record<string, string | number>): ChainMessage {
  return params ? { key, params } : { key }
}

function chainMsg(suffix: string, params?: Record<string, string | number>): ChainMessage {
  return msg(CHAIN + suffix, params)
}

function action(id: ChainActionId, label: ChainMessage, disabled = false): ChainAction {
  return { id, label, disabled }
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/* Membership. */

function sideIsCard(side: SyncChainSide): boolean {
  return side.book !== null && (side.isMember || side.isThisBook)
}

function readAlongIsCard(s: SyncChainSnapshot): boolean {
  return s.readAlong.member !== null || s.thisBook === 'readAlong'
}

function absIsCard(s: SyncChainSnapshot): boolean {
  return s.abs?.link?.syncing === true && sideIsCard(s.audiobook)
}

function isCard(s: SyncChainSnapshot, edition: EditionKey): boolean {
  switch (edition) {
    case 'ebook':
      return sideIsCard(s.ebook)
    case 'audiobook':
      return sideIsCard(s.audiobook)
    case 'readAlong':
      return readAlongIsCard(s)
    case 'abs':
      return absIsCard(s)
  }
}

function readAlongExists(s: SyncChainSnapshot): boolean {
  const { member, outputBook, status } = s.readAlong
  return member !== null || outputBook !== null || status === 'queued' || status === 'building' || status === 'failed'
}

/* State resolution shared by the rows and the header. */

type AlignmentState = 'linking' | 'rebuilding' | 'alignmentFailed' | 'outOfDate' | 'cantAlign' | 'alignmentBlocked' | 'notAligned' | 'ready'

function alignmentState(a: SyncChainAlignment): AlignmentState {
  if (a.running || a.status === 'pending' || a.status === 'building') return a.builtAt === null ? 'linking' : 'rebuilding'
  if (a.status === 'failed') return 'alignmentFailed'
  if (a.status === 'ready') return a.stale ? 'outOfDate' : 'ready'
  if (a.status === 'unalignable') return 'cantAlign'
  return isTerminalBlock(a.buildBlocked) ? 'alignmentBlocked' : 'notAligned'
}

type AbsState = Extract<ChainConnectorState, 'absUnreachable' | 'absDiverged' | 'absReceiving' | 'absSending' | 'absOneWay' | 'absLinked'>

function absState(link: AudiobookshelfBookSyncLink, live: AudiobookshelfBookSyncLive | null): AbsState {
  switch (live?.status) {
    case 'unreachable':
      return 'absUnreachable'
    case 'diverged':
      return 'absDiverged'
    case 'receiving':
      return 'absReceiving'
    case 'sending':
      return 'absSending'
  }
  return link.direction === 'two_way' ? 'absLinked' : 'absOneWay'
}

function hasReadAloudIssue(s: SyncChainSnapshot): boolean {
  return s.readAlong.member !== null && s.readAloudIssue !== null
}

/* Cards. */

function bookCover(id: number, coverVersion: string | null): ChainCover {
  return { kind: 'book', bookId: id, coverVersion }
}

function canCancelReadAlong(s: SyncChainSnapshot): boolean {
  if (!s.can.generate) return false
  if (s.readAlong.status === 'queued') return true
  return s.readAlong.status === 'building' && s.readAlong.phase !== 'collect' && s.readAlong.phase !== 'link'
}

function readAlongJob(s: SyncChainSnapshot, withRetry: boolean): ChainReadAlongJob | null {
  const ra = s.readAlong
  if (ra.status !== 'queued' && ra.status !== 'building' && ra.status !== 'failed') return null
  const cancel = canCancelReadAlong(s) ? action('cancelReadAlong', msg(`${EDITION_LINK}readAlong.cancelLabel`), ra.mutating) : null
  const retry =
    withRetry && ra.status === 'failed' && s.can.generate
      ? action('retryReadAlong', chainMsg('action.retry'), ra.mutating || isActionBlocked(ra.blocked))
      : null
  return {
    stage: ra.status === 'queued' ? 0 : stageIndex(ra.phase, ra.remoteTask),
    remoteProgress: ra.remoteProgress,
    failed: ra.status === 'failed',
    cancel,
    retry,
    error: ra.status === 'failed' ? ra.error : null,
  }
}

function pairChange(s: SyncChainSnapshot, side: SyncChainSide): ChainCardRow['change'] {
  if (side.isThisBook || !s.can.editLink) return 'none'
  return readAlongExists(s) ? 'blocked' : 'available'
}

function sideCard(s: SyncChainSnapshot, edition: 'ebook' | 'audiobook'): ChainCardRow | null {
  const side = s[edition]
  if (!side.book) return null
  return {
    kind: 'card',
    id: `card:${edition}`,
    edition,
    cover: bookCover(side.book.id, side.book.coverVersion),
    title: side.book.title,
    subtitle: side.book.authorName,
    routeBookId: side.isThisBook ? null : side.book.id,
    href: null,
    isThisBook: side.isThisBook,
    external: false,
    progress: side.book.progress,
    progressPending: false,
    change: pairChange(s, side),
    rebuild: null,
    job: null,
  }
}

function readAlongCard(s: SyncChainSnapshot): ChainCardRow {
  const ra = s.readAlong
  const isThisBook = s.thisBook === 'readAlong'
  const book = ra.member ?? ra.outputBook ?? ra.thisBook
  const canRebuild = s.linked && ra.member !== null && ra.status === 'ready' && s.can.generate && s.can.rebuild
  return {
    kind: 'card',
    id: 'card:readAlong',
    edition: 'readAlong',
    cover: book ? bookCover(book.id, ra.member?.coverVersion ?? ra.thisBook?.coverVersion ?? null) : { kind: 'readAlongTile' },
    title: book?.title ?? null,
    subtitle: ra.member?.authorName ?? ra.thisBook?.authorName ?? null,
    routeBookId: book && !isThisBook ? book.id : null,
    href: null,
    isThisBook,
    external: false,
    progress: ra.member?.progress?.percentage ?? null,
    progressPending: false,
    change: 'none',
    rebuild: canRebuild ? action('rebuildReadAlong', msg(`${EDITION_LINK}actions.rebuild`), ra.mutating || isActionBlocked(ra.blocked)) : null,
    job: readAlongJob(s, true),
  }
}

function absCard(abs: SyncChainAbs, link: AudiobookshelfBookSyncLink): ChainCardRow {
  const progress = abs.live?.progress
  return {
    kind: 'card',
    id: 'card:abs',
    edition: 'abs',
    cover: { kind: 'abs', absLibraryItemId: link.absLibraryItemId },
    title: link.title,
    subtitle: link.libraryName,
    routeBookId: null,
    href: link.webUrl,
    isThisBook: false,
    external: true,
    progress: progress ? displayPercentage(progress.percentage, progress.isFinished) : null,
    progressPending: abs.checking,
    change: 'available',
    rebuild: null,
    job: null,
  }
}

function card(s: SyncChainSnapshot, edition: EditionKey): ChainCardRow | null {
  switch (edition) {
    case 'ebook':
    case 'audiobook':
      return sideCard(s, edition)
    case 'readAlong':
      return readAlongCard(s)
    case 'abs':
      return s.abs?.link ? absCard(s.abs, s.abs.link) : null
  }
}

/* Connectors. */

interface ConnectorSpec {
  state: ChainConnectorState
  tone: ChainTone
  icon: ChainIcon
  pill: ChainMessage
  switch?: ChainSwitch | null
  note?: ChainMessage | null
  detail?: string | null
  actions?: ChainAction[]
  cancel?: ChainAction | null
  ticks?: ChainConnectorRow['ticks']
  settingsLink?: boolean
  absDetails?: boolean
  miniText?: ChainMessage | null
  miniAction?: ChainAction | null
}

function connectorKey(from: EditionKey, to: EditionKey): ConnectorKey {
  return `${from}-${to}` as ConnectorKey
}

function connectorRow(from: EditionKey, to: EditionKey, spec: ConnectorSpec): ChainConnectorRow {
  const key = connectorKey(from, to)
  return {
    kind: 'connector',
    id: `connector:${key}`,
    key,
    from,
    to,
    state: spec.state,
    tone: spec.tone,
    dashed: spec.tone === 'muted' || spec.tone === 'destructive',
    icon: spec.icon,
    pill: spec.pill,
    switch: spec.switch ?? null,
    note: spec.note ?? null,
    detail: spec.detail ?? null,
    actions: spec.actions ?? [],
    cancel: spec.cancel ?? null,
    ticks: spec.ticks ?? null,
    settingsLink: spec.settingsLink ?? false,
    absDetails: spec.absDetails ?? false,
    mini: {
      text: spec.tone === 'success' ? null : (spec.miniText ?? spec.pill),
      action: spec.miniAction ?? null,
    },
  }
}

function onSwitch(s: SyncChainSnapshot, from: EditionKey, to: EditionKey, disabled = !s.can.editLink): ChainSwitch {
  return { on: true, disabled, onAction: null, offTarget: offTargetFor(from, to, s.thisBook) }
}

function editAction(s: SyncChainSnapshot, id: ChainActionId, label: ChainMessage): ChainAction | null {
  return s.can.editLink ? action(id, label) : null
}

function presentActions(...actions: (ChainAction | null)[]): ChainAction[] {
  return actions.filter((a): a is ChainAction => a !== null)
}

function alignmentConnector(s: SyncChainSnapshot, from: EditionKey, to: EditionKey): ChainConnectorRow {
  const a = s.alignment
  const ticks = { samplesDone: a.samplesDone, samplesTotal: a.samplesTotal }
  switch (alignmentState(a)) {
    case 'linking':
      return connectorRow(from, to, {
        state: 'linking',
        tone: 'info',
        icon: 'spinner',
        pill: chainMsg('pill.linking'),
        switch: onSwitch(s, from, to),
        note: chainMsg('note.linking'),
        cancel: editAction(s, 'cancelLinking', chainMsg('cancelLinking')),
        ticks,
        miniText: chainMsg('mini.linking'),
      })
    case 'rebuilding':
      return connectorRow(from, to, {
        state: 'rebuilding',
        tone: 'info',
        icon: 'spinner',
        pill: chainMsg('pill.rebuilding'),
        switch: onSwitch(s, from, to),
        cancel: editAction(s, 'cancelAlignment', chainMsg('cancelAlignment')),
        ticks,
        miniText: chainMsg('mini.rebuilding'),
      })
    case 'alignmentFailed': {
      const retry = editAction(s, 'retryAlignment', chainMsg('action.retry'))
      return connectorRow(from, to, {
        state: 'alignmentFailed',
        tone: 'destructive',
        icon: 'alert',
        pill: chainMsg('pill.alignmentFailed'),
        note: chainMsg('note.alignmentFailed'),
        detail: a.buildError,
        actions: presentActions(retry, editAction(s, 'unlinkPair', msg(`${EDITION_LINK}unlink`))),
        miniAction: retry,
      })
    }
    case 'outOfDate':
      return connectorRow(from, to, {
        state: 'outOfDate',
        tone: 'warning',
        icon: 'alert',
        pill: chainMsg('pill.outOfDate'),
        switch: onSwitch(s, from, to),
        note: chainMsg('note.stale'),
        actions: presentActions(editAction(s, 'rebuildAlignment', chainMsg('action.rebuildAlignment'))),
        miniAction: editAction(s, 'rebuildAlignment', msg(`${EDITION_LINK}actions.rebuild`)),
      })
    case 'cantAlign':
      return connectorRow(from, to, {
        state: 'cantAlign',
        tone: 'muted',
        icon: 'ban',
        pill: chainMsg('pill.cantAlign'),
        switch: onSwitch(s, from, to),
        note: msg('book.detail.readingAlignment.unalignableHint'),
      })
    case 'alignmentBlocked':
      return connectorRow(from, to, {
        state: 'alignmentBlocked',
        tone: 'muted',
        icon: 'ban',
        pill: chainMsg('pill.notAligned'),
        switch: onSwitch(s, from, to),
        note: msg(`book.detail.readingAlignment.buildBlocked.${a.buildBlocked}`),
      })
    case 'notAligned': {
      const alignNow = editAction(s, 'alignNow', chainMsg('action.alignNow'))
      return connectorRow(from, to, {
        state: 'notAligned',
        tone: 'warning',
        icon: 'alert',
        pill: chainMsg('pill.notAligned'),
        switch: onSwitch(s, from, to),
        note: msg(a.buildBlocked === 'busy' ? 'book.detail.readingAlignment.buildBlocked.busy' : 'book.detail.readingAlignment.idleHint'),
        actions: presentActions(alignNow),
        miniAction: alignNow,
      })
    }
    case 'ready': {
      const viaWhisper = from === 'ebook' && to === 'audiobook'
      return connectorRow(from, to, {
        state: viaWhisper ? 'linkedViaWhisper' : 'linked',
        tone: 'success',
        icon: 'link',
        pill: chainMsg(viaWhisper ? 'pill.linkedViaWhisper' : 'pill.linked'),
        switch: onSwitch(s, from, to),
      })
    }
  }
}

function attachConnector(s: SyncChainSnapshot, from: EditionKey, to: EditionKey): ChainConnectorRow {
  return connectorRow(from, to, {
    state: 'available',
    tone: 'muted',
    icon: 'link',
    pill: chainMsg('pill.available'),
    switch: { on: false, disabled: !s.can.editLink, onAction: 'attachReadAlong', offTarget: null },
    miniText: chainMsg('mini.notLinked'),
    miniAction: editAction(s, 'attachReadAlong', chainMsg('action.link')),
  })
}

function readAlongAudiobookConnector(s: SyncChainSnapshot): ChainConnectorRow {
  if (s.readAlong.member === null) return attachConnector(s, 'readAlong', 'audiobook')
  if (s.readAloudIssue !== null) {
    const ra = s.readAlong
    const canRebuild = s.can.generate && s.can.rebuild
    const disabled = ra.mutating || isActionBlocked(ra.blocked)
    return connectorRow('readAlong', 'audiobook', {
      state: 'readAloudIssue',
      tone: 'warning',
      icon: 'alert',
      pill: msg('book.detail.details.readAloudSync.state.notSyncing'),
      switch: onSwitch(s, 'readAlong', 'audiobook'),
      note: readAloudSyncIssueMessage(s.readAloudIssue),
      actions: canRebuild ? [action('rebuildReadAlong', msg(`${EDITION_LINK}actions.rebuildReadAlong`), disabled)] : [],
      miniAction: canRebuild ? action('rebuildReadAlong', msg(`${EDITION_LINK}actions.rebuild`), disabled) : null,
    })
  }
  return connectorRow('readAlong', 'audiobook', {
    state: 'linked',
    tone: 'success',
    icon: 'link',
    pill: chainMsg('pill.linked'),
    switch: onSwitch(s, 'readAlong', 'audiobook'),
  })
}

// Receiving and diverged are described by the live hint, which carries the time or the reason.
function absNote(state: AbsState, link: AudiobookshelfBookSyncLink): ChainMessage | null {
  switch (state) {
    case 'absUnreachable':
      return chainMsg('note.absUnreachable')
    case 'absSending':
      return msg(`${EDITION_LINK}abs.status.sendingHint`)
    case 'absOneWay':
      return msg(`${EDITION_LINK}abs.${link.direction === 'from_abs' ? 'fromAbs' : 'toAbs'}`)
    case 'absDiverged':
    case 'absReceiving':
    case 'absLinked':
      return null
  }
}

function absActions(state: AbsState): ChainAction[] {
  switch (state) {
    case 'absUnreachable':
      return [action('retryAbs', msg(`${EDITION_LINK}abs.reconcile.retry`))]
    case 'absDiverged':
      return [action('absPush', msg(`${EDITION_LINK}abs.reconcile.push`)), action('absPull', msg(`${EDITION_LINK}abs.reconcile.pull`))]
    case 'absReceiving':
      return [action('absPull', msg(`${EDITION_LINK}abs.reconcile.useNow`))]
    default:
      return []
  }
}

function absConnector(s: SyncChainSnapshot, abs: SyncChainAbs, link: AudiobookshelfBookSyncLink): ChainConnectorRow {
  const state = absState(link, abs.live)
  const warns = state === 'absUnreachable' || state === 'absDiverged'
  const actions = absActions(state)
  const pill =
    state === 'absUnreachable'
      ? chainMsg('pill.cantReach')
      : state === 'absDiverged'
        ? msg(`${EDITION_LINK}abs.status.diverged`)
        : chainMsg(state === 'absOneWay' ? 'pill.oneWay' : 'pill.linked')
  return connectorRow('audiobook', 'abs', {
    state,
    tone: warns ? 'warning' : 'success',
    icon: warns ? 'alert' : 'link',
    pill,
    switch: onSwitch(s, 'audiobook', 'abs', false),
    note: absNote(state, link),
    actions,
    settingsLink: state === 'absUnreachable' || state === 'absOneWay',
    absDetails: true,
    miniText: state === 'absUnreachable' ? chainMsg('mini.cantReach') : null,
    miniAction: state === 'absUnreachable' ? actions[0] : null,
  })
}

function connector(s: SyncChainSnapshot, from: EditionKey, to: EditionKey): ChainConnectorRow | null {
  if (to === 'abs') return s.abs?.link ? absConnector(s, s.abs, s.abs.link) : null
  if (from === 'ebook' && to === 'audiobook') return alignmentConnector(s, from, to)
  if (from === 'ebook') return s.readAlong.member !== null ? alignmentConnector(s, from, to) : attachConnector(s, from, to)
  return readAlongAudiobookConnector(s)
}

/* Available rows. */

type AvailableSpec = Pick<ChainAvailableRow, 'variant' | 'note'> & Partial<Omit<ChainAvailableRow, 'kind' | 'id' | 'edition' | 'variant' | 'note'>>

function availableRow(edition: EditionKey, cover: ChainCover, spec: AvailableSpec): ChainAvailableRow {
  return {
    kind: 'available',
    id: `available:${edition}`,
    edition,
    cover,
    label: chainMsg(SHORT_LABEL_KEY[edition]),
    action: null,
    locked: false,
    secondary: null,
    settingsLink: false,
    cancel: null,
    job: null,
    log: null,
    expandable: false,
    present: false,
    ...spec,
  }
}

function candidateNote(match: EditionMatchChip | null, title: string): ChainMessage {
  if (match?.source === 'auto') return chainMsg('available.candidateAuto', { score: match.score, title })
  if (match?.source === 'pair') return chainMsg('available.candidatePair', { title })
  return chainMsg('available.candidatePicked', { title })
}

function sideRow(s: SyncChainSnapshot, edition: 'ebook' | 'audiobook'): ChainAvailableRow | null {
  const side = s[edition]
  const canEdit = s.can.editLink
  const openSearch = (label: string) => (canEdit ? action('openSearch', chainMsg(label)) : null)
  if (!side.book) {
    if (!canEdit) return null
    return availableRow(
      edition,
      { kind: 'none' },
      {
        variant: 'search',
        note: chainMsg(edition === 'ebook' ? 'available.noMatchEbook' : 'available.noMatchAudiobook'),
        action: openSearch('action.search'),
        expandable: true,
      },
    )
  }
  const secondary = side.match?.source === 'pair' ? null : openSearch('action.notThisOne')
  return availableRow(edition, bookCover(side.book.id, side.book.coverVersion), {
    variant: 'candidate',
    note: candidateNote(side.match, side.book.title ?? ''),
    action: action('linkPair', chainMsg('action.link'), !canEdit),
    locked: !canEdit,
    secondary,
    expandable: secondary !== null,
    present: true,
  })
}

function readAlongRow(s: SyncChainSnapshot): ChainAvailableRow | null {
  const ra = s.readAlong
  const tile: ChainCover = { kind: 'readAlongTile' }
  if (ra.memberPending) return null
  switch (ra.status) {
    case 'queued':
    case 'building': {
      const job = readAlongJob(s, false)
      const note =
        ra.status === 'building'
          ? chainMsg('available.readAlong.generating')
          : ra.queuePosition === null
            ? msg(`${EDITION_LINK}readAlong.body.queuedUnknown`)
            : msg(`${EDITION_LINK}readAlong.body.queued`, { position: ra.queuePosition })
      return availableRow('readAlong', tile, {
        variant: ra.status === 'queued' ? 'readAlongQueued' : 'readAlongBuilding',
        note,
        cancel: job?.cancel ?? null,
        job,
      })
    }
    case 'failed': {
      return availableRow('readAlong', tile, {
        variant: 'readAlongFailed',
        note: chainMsg('available.readAlong.failed', { step: READ_ALONG_STAGES[stageIndex(ra.phase, ra.remoteTask)]! }),
        action: s.can.generate ? action('retryReadAlong', chainMsg('action.retry'), ra.mutating || isActionBlocked(ra.blocked)) : null,
        secondary: ra.error ? action('toggleLog', chainMsg('action.viewLog')) : null,
        log: ra.error,
      })
    }
    case 'ready':
      return readyReadAlongRow(s, tile)
    case 'none':
      return idleReadAlongRow(s, tile)
  }
}

function readyReadAlongRow(s: SyncChainSnapshot, tile: ChainCover): ChainAvailableRow {
  const output = s.readAlong.outputBook
  if (!output) {
    return availableRow('readAlong', tile, { variant: 'readAlongOutOfReach', note: msg(`${EDITION_LINK}readAlong.body.outOfReach`) })
  }
  const cover = bookCover(output.id, null)
  if (s.linked) {
    const canEdit = s.can.editLink
    return availableRow('readAlong', cover, {
      variant: 'readAlongDetached',
      note: chainMsg('available.readAlong.detached'),
      action: action('attachReadAlong', chainMsg('action.link'), !canEdit || s.readAlong.mutating),
      locked: !canEdit,
      present: true,
    })
  }
  return availableRow('readAlong', cover, {
    variant: 'readAlongWaitingForPair',
    note: chainMsg('available.readAlong.waitingForPair'),
    action: action('attachReadAlong', chainMsg('action.link'), true),
    locked: true,
    present: true,
  })
}

function idleReadAlongRow(s: SyncChainSnapshot, tile: ChainCover): ChainAvailableRow | null {
  const ra = s.readAlong
  const candidateKnown = s.ebook.book !== null && s.audiobook.book !== null
  if (!s.can.generate || ra.blocked === 'not_configured' || (!s.linked && !candidateKnown)) return null
  const generate = (disabled: boolean) => action('openGenerate', chainMsg('action.generate'), disabled)
  if (!s.linked) {
    return availableRow('readAlong', tile, {
      variant: 'readAlongNeedsPair',
      note: chainMsg('available.readAlong.needsPair'),
      action: generate(true),
      locked: true,
    })
  }
  if (isActionBlocked(ra.blocked)) {
    return availableRow('readAlong', tile, {
      variant: 'readAlongBlocked',
      note: msg(`${EDITION_LINK}readAlong.blocked.${snakeToCamel(ra.blocked ?? '')}`),
      action: generate(true),
      locked: true,
    })
  }
  return availableRow('readAlong', tile, {
    variant: 'readAlongNotGenerated',
    note: chainMsg('available.readAlong.notGenerated'),
    action: generate(ra.mutating),
    expandable: true,
  })
}

function absRow(s: SyncChainSnapshot): ChainAvailableRow | null {
  const link = s.abs?.link
  if (!link) return null
  const cover: ChainCover = { kind: 'abs', absLibraryItemId: link.absLibraryItemId }
  const library = link.libraryName ?? ''
  if (link.pausedReason === 'position_sync_off') {
    return availableRow('abs', cover, {
      variant: 'absPositionSyncOff',
      note: chainMsg('available.abs.positionSyncOff'),
      locked: true,
      settingsLink: true,
      present: true,
    })
  }
  if (!sideIsCard(s.audiobook)) {
    return availableRow('abs', cover, {
      variant: 'absNeedsAudio',
      note: chainMsg('available.abs.needsAudio'),
      action: action('resumeAbs', chainMsg('action.link'), true),
      locked: true,
      present: true,
    })
  }
  if (link.pausedReason === 'needs_review') {
    return availableRow('abs', cover, {
      variant: 'absNeedsReview',
      note: chainMsg('available.abs.needsReview', { library }),
      action: action('confirmAbs', chainMsg('action.confirm')),
      present: true,
    })
  }
  return availableRow('abs', cover, {
    variant: 'absPaused',
    note: chainMsg('available.abs.paused', { library }),
    action: action('resumeAbs', chainMsg('action.link')),
    present: true,
  })
}

function available(s: SyncChainSnapshot, edition: EditionKey): ChainAvailableRow | null {
  switch (edition) {
    case 'ebook':
    case 'audiobook':
      return sideRow(s, edition)
    case 'readAlong':
      return readAlongRow(s)
    case 'abs':
      return absRow(s)
  }
}

/* Header. */

function headerPriority(s: SyncChainSnapshot): 1 | 2 | 3 | null {
  const align = alignmentState(s.alignment)
  const raStatus = s.readAlong.status
  const abs = absIsCard(s) && s.abs?.link ? absState(s.abs.link, s.abs.live) : null
  if ((s.linked && align === 'alignmentFailed') || raStatus === 'failed') return 1
  const alignWarns = align === 'outOfDate' || align === 'notAligned' || align === 'cantAlign' || align === 'alignmentBlocked'
  if ((s.linked && alignWarns) || hasReadAloudIssue(s) || abs === 'absUnreachable' || abs === 'absDiverged') return 2
  if (align === 'linking' || align === 'rebuilding' || raStatus === 'queued' || raStatus === 'building') return 3
  return null
}

function countInSync(s: SyncChainSnapshot, cards: readonly EditionKey[]): number {
  const absSyncing = cards.includes('abs')
  return cards.filter((edition) => {
    switch (edition) {
      case 'ebook':
        return s.ebook.isMember
      case 'readAlong':
        return s.readAlong.member !== null
      case 'audiobook':
        return s.audiobook.isMember || absSyncing
      case 'abs':
        return true
    }
  }).length
}

export function buildSyncChain(snapshot: SyncChainSnapshot): SyncChain {
  const cardEditions = EDITION_ORDER.filter((edition) => isCard(snapshot, edition))
  const rows: ChainRow[] = []
  const cards: EditionKey[] = []
  for (const edition of cardEditions) {
    const row = card(snapshot, edition)
    if (!row) continue
    const previous = cards.at(-1)
    const joint = previous ? connector(snapshot, previous, edition) : null
    if (joint) rows.push(joint)
    rows.push(row)
    cards.push(edition)
  }

  const availableRows = EDITION_ORDER.filter((edition) => !cards.includes(edition))
    .map((edition) => available(snapshot, edition))
    .filter((row): row is ChainAvailableRow => row !== null)
  if (availableRows.length > 0) rows.push({ kind: 'availableHeader', id: 'available-header' }, ...availableRows)

  const inSync = countInSync(snapshot, cards)
  const present = cards.length + availableRows.filter((row) => row.present).length
  const priority = headerPriority(snapshot)
  const header: SyncChainHeader =
    priority === 1
      ? { tone: 'destructive', label: chainMsg('header.needsAttention') }
      : priority === 2
        ? { tone: 'warning', label: chainMsg('header.checkSync') }
        : priority === 3
          ? { tone: 'info', label: chainMsg('header.linking') }
          : inSync >= 2
            ? { tone: 'success', label: chainMsg('header.inSync', { n: inSync, m: present }) }
            : { tone: 'muted', label: chainMsg('header.notLinked') }

  return {
    rows,
    header,
    intro: chainMsg(inSync >= 2 ? 'intro.linked' : 'intro.unlinked'),
    needsAttention: priority === 1 || priority === 2 || availableRows.some((row) => row.variant === 'absNeedsReview'),
    inSync,
    present,
  }
}

/** The side a switch turns off: the one farther from this book in EDITION_ORDER. */
export function offTargetFor(from: EditionKey, to: EditionKey, thisBook: SyncChainSnapshot['thisBook']): ChainOffTarget {
  const anchor = EDITION_ORDER.indexOf(thisBook)
  const fromDistance = Math.abs(EDITION_ORDER.indexOf(from) - anchor)
  const toDistance = Math.abs(EDITION_ORDER.indexOf(to) - anchor)
  if (fromDistance === toDistance) return 'pair'
  const farther = fromDistance > toDistance ? from : to
  if (farther === 'readAlong') return 'readAlong'
  return farther === 'abs' ? 'abs' : 'pair'
}

function rowHeight(row: ChainRow, view: ChainViewMode, expandedRowId: string | null): number {
  switch (row.kind) {
    case 'card':
      if (view === 'compact') return COMPACT_CARD_HEIGHT
      return MODIFY_CARD_HEIGHT + (row.job ? MODIFY_CARD_JOB_HEIGHT : 0)
    case 'connector':
      if (view === 'compact') return row.mini.text ? COMPACT_CONNECTOR_TEXT_HEIGHT : COMPACT_CONNECTOR_HEIGHT
      return (
        MODIFY_CONNECTOR_HEIGHT +
        (row.note ? MODIFY_CONNECTOR_NOTE_HEIGHT : 0) +
        (row.actions.length > 0 ? MODIFY_CONNECTOR_ACTIONS_HEIGHT : 0) +
        (row.ticks ? MODIFY_CONNECTOR_TICKS_HEIGHT : 0)
      )
    case 'availableHeader':
      return AVAILABLE_HEADER_HEIGHT
    case 'available':
      return AVAILABLE_ROW_HEIGHT + (row.job ? AVAILABLE_ROW_JOB_HEIGHT : 0) + (row.id === expandedRowId ? AVAILABLE_ROW_EXPANDED_HEIGHT : 0)
  }
}

export function estimateChainHeight(chain: SyncChain, view: ChainViewMode, expandedRowId: string | null = null): number {
  return chain.rows.reduce((total, row) => total + rowHeight(row, view, expandedRowId), PANEL_CHROME_HEIGHT + HEIGHT_SLACK)
}

/** Modify when something needs attention or the Modify estimate fits the space; compact otherwise. */
export function initialViewMode(chain: SyncChain, availableHeight: number): ChainViewMode {
  return chain.needsAttention || estimateChainHeight(chain, 'modify') <= availableHeight ? 'modify' : 'compact'
}

/** The taller side of the trigger, less the popover's collision padding and side offset. */
export function availableHeightFromTrigger(
  rect: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
  collisionPadding = 16,
  sideOffset = 4,
): number {
  return Math.max(viewportHeight - rect.bottom, rect.top) - collisionPadding - sideOffset
}
