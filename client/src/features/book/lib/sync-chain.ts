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
 * The Position sync panel as a spine of the ebook, an audio group (the audiobook with Audiobookshelf linked
 * beneath it) and the read-along (or its slot until it exists), with a connector between neighbouring
 * slots carrying its own state and the switch that links them. The order follows `thisBook`: this book
 * leads, the audio group sits next to it, and the read-along comes last unless it is this book.
 * Connector keys, ends and labels do not change with position. `buildSyncChain` turns one snapshot of the
 * panel's composables into that row list; it is pure so every state can be pinned by a unit test.
 */

export type EditionFormat = 'ebook' | 'audiobook'

export type EditionKey = 'ebook' | 'readAlong' | 'audiobook' | 'abs'

export type ConnectorKey = 'readAlong-audiobook' | 'ebook-audiobook' | 'audiobook-abs'

export type ChainTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'
export type ChainIcon = 'link' | 'spinner' | 'alert' | 'ban'
/** The position flow drawn between a connector's names: both ways, towards `from` or towards `to`. */
export type ChainArrow = 'both' | 'left' | 'right'
export type ChainViewMode = 'compact' | 'modify'

/** What a connector's switch turns off: always the link that connector draws, whichever page it is on. */
type ChainOffTarget = 'pair' | 'readAlong' | 'abs'

export type ChainActionId =
  | 'linkPair'
  | 'cancelLinking'
  | 'cancelAlignment'
  | 'retryAlignment'
  | 'alignNow'
  | 'rebuildAlignment'
  | 'unlinkPair'
  | 'attachReadAlong'
  | 'openGenerate'
  | 'generate'
  | 'cancelGenerate'
  | 'importExisting'
  | 'cancelReadAlong'
  | 'retryReadAlong'
  | 'rebuildReadAlong'
  | 'toggleLog'
  | 'change'
  | 'retryAbs'
  | 'absPush'
  | 'absPull'
  | 'confirmAbs'
  | 'resumeAbs'

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

export type EditionMatchChip = { source: 'auto'; score: number } | { source: 'manual' } | { source: 'pair' } | { source: 'build' }

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
}

export interface SyncChainAbs {
  /** The integration is effectively on for this reader; without it the chain has no Audiobookshelf rows. */
  configured: boolean
  link: AudiobookshelfBookSyncLink | null
  live: AudiobookshelfBookSyncLive | null
  checking: boolean
}

interface SyncChainPermissions {
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

type ChainCover =
  { kind: 'book'; bookId: number; coverVersion: string | null } | { kind: 'abs'; absLibraryItemId: string } | { kind: 'readAlongTile' }

/** `group` rows are drawn inside the audio box: the audiobook, its Audiobookshelf connector and the Audiobookshelf row. */
export type ChainFrame = 'spine' | 'group'

interface ChainReadAlongJob {
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
  frame: ChainFrame
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
  /** A member or this book renders as a full card; any other edition that exists renders dashed, waiting for the switch above it. */
  linked: boolean
  /** The dashed card's small label: how the edition was picked, or why it is not syncing. */
  chip: ChainMessage | null
  /** Modify-only Change: offered, blocked while the read-along holds the pair (shown disabled with `changeHint`), or absent. */
  change: 'available' | 'blocked' | 'none'
  /** Why Change is blocked; null unless `change` is 'blocked'. */
  changeHint: ChainMessage | null
  /** Modify-only Confirm on an Audiobookshelf match that needs review. */
  confirm: ChainAction | null
  rebuild: ChainAction | null
  /** A read-along member being rebuilt shows its stepper and cancel or retry under the card. */
  job: ChainReadAlongJob | null
}

export interface ChainGhostRow {
  kind: 'ghost'
  id: string
  edition: EditionKey
  frame: ChainFrame
  label: ChainMessage
  note: ChainMessage
  /** At most one: Search or Match, which both open an in-place search. */
  action: ChainAction | null
  settingsLink: boolean
}

type ChainReadAlongSlotVariant = 'notGenerated' | 'needsEbook' | 'needsAudio' | 'blocked' | 'queued' | 'building' | 'failed'

export interface ChainReadAlongSlotRow {
  kind: 'readAlongSlot'
  id: 'slot:readAlong'
  variant: ChainReadAlongSlotVariant
  label: ChainMessage
  note: ChainMessage
  /** Generate while idle, Retry after a failure. */
  action: ChainAction | null
  /** The red X for a job in flight. */
  cancel: ChainAction | null
  job: ChainReadAlongJob | null
  /** A text link beside the note, such as "View log". */
  secondary: ChainAction | null
  /** Error text shown under the row while "View log" is open. */
  error: string | null
  /** Generate opens the options block in place instead of starting a build. */
  expandable: boolean
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

interface ChainSwitch {
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
  frame: ChainFrame
  from: EditionKey
  to: EditionKey
  state: ChainConnectorState
  tone: ChainTone
  dashed: boolean
  icon: ChainIcon
  arrow: ChainArrow
  pill: ChainMessage
  /** Modify view: muted text after the pair label, such as "via Whisper" when linked or "not linked" when off. */
  qualifier: ChainMessage | null
  /** Modify view: what the link does and how, shown when the chevron beside the qualifier is open. */
  explainer: ChainMessage | null
  /** Null when the switch is hidden (failed alignment). */
  switch: ChainSwitch | null
  /** Why a disabled switch cannot be turned on; null while it can. */
  disabledReason: ChainMessage | null
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

export type ChainRow = ChainCardRow | ChainGhostRow | ChainConnectorRow | ChainReadAlongSlotRow

interface SyncChainHeader {
  tone: ChainTone
  label: ChainMessage
}

export interface SyncChain {
  rows: ChainRow[]
  header: SyncChainHeader
  intro: ChainMessage
  /** A failure or a check-sync state is showing, so the panel opens in Modify. */
  needsAttention: boolean
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
const MODIFY_CARD_HEIGHT = 66
const MODIFY_CARD_JOB_HEIGHT = 40
const MODIFY_GHOST_HEIGHT = 46
const MODIFY_CONNECTOR_HEIGHT = 32
const MODIFY_INNER_CONNECTOR_HEIGHT = 28
const MODIFY_CONNECTOR_NOTE_HEIGHT = 30
const MODIFY_CONNECTOR_ACTIONS_HEIGHT = 32
const MODIFY_CONNECTOR_TICKS_HEIGHT = 20
const MODIFY_SLOT_HEIGHT = 75

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

// Audiobookshelf matches the audiobook itself, so its rows need an audiobook on screen, linked to this page or not.
function absIsCard(s: SyncChainSnapshot): boolean {
  return s.abs?.link?.syncing === true && s.audiobook.book !== null
}

/** The read-along is a book of its own (linked, detached or this page), so it gets a place on the spine. */
function readAlongBookExists(s: SyncChainSnapshot): boolean {
  const { member, outputBook, status, memberPending } = s.readAlong
  if (s.thisBook === 'readAlong' || member !== null) return true
  return !memberPending && status === 'ready' && outputBook !== null
}

function readAlongOutOfReach(s: SyncChainSnapshot): boolean {
  const { member, outputBook, status, memberPending } = s.readAlong
  return !memberPending && s.thisBook !== 'readAlong' && member === null && status === 'ready' && outputBook === null
}

function readAlongBuildRunning(s: SyncChainSnapshot): boolean {
  return s.readAlong.status === 'queued' || s.readAlong.status === 'building'
}

/** The bottom slot shows a build for the pair on screen: running, or failed and retryable by this reader. */
function slotShowsBuild(s: SyncChainSnapshot): boolean {
  if (s.readAlong.memberPending || readAlongBookExists(s)) return false
  return readAlongBuildRunning(s) || (s.readAlong.status === 'failed' && s.can.generate)
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

/* Cards and ghosts. */

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

type PairChange = Pick<ChainCardRow, 'change' | 'changeHint'>

const CHANGE_OFFERED: PairChange = { change: 'available', changeHint: null }

/**
 * Re-pointing a side would orphan what the read-along holds: its member, or a build queued for this pair.
 * An unlinked candidate also keeps a failed build's pair, so Retry still targets the same audiobook.
 */
function pairChange(s: SyncChainSnapshot, side: SyncChainSide, linked: boolean): PairChange {
  if (side.isThisBook || !s.can.editLink) return { change: 'none', changeHint: null }
  if (!linked) {
    if (side.match?.source === 'pair') return { change: 'none', changeHint: null }
    if (readAlongBuildRunning(s)) return { change: 'blocked', changeHint: chainMsg('change.building') }
    if (!slotShowsBuild(s)) return CHANGE_OFFERED
    return { change: 'blocked', changeHint: chainMsg('change.failed') }
  }
  if (s.readAlong.member !== null) return { change: 'blocked', changeHint: chainMsg('change.blocked') }
  if (readAlongBuildRunning(s)) return { change: 'blocked', changeHint: chainMsg('change.building') }
  return CHANGE_OFFERED
}

function candidateChip(match: EditionMatchChip | null, title: string): ChainMessage | null {
  switch (match?.source) {
    case 'auto':
      return chainMsg('chip.match', { score: match.score })
    case 'manual':
    case 'build':
      return chainMsg('chip.selected')
    case 'pair':
      return chainMsg('chip.generatedFrom', { title })
    default:
      return null
  }
}

function ghostRow(
  edition: EditionKey,
  frame: ChainFrame,
  note: ChainMessage,
  spec: Partial<Pick<ChainGhostRow, 'action' | 'settingsLink'>> = {},
): ChainGhostRow {
  return {
    kind: 'ghost',
    id: `card:${edition}`,
    edition,
    frame,
    label: chainMsg(SHORT_LABEL_KEY[edition]),
    note,
    action: spec.action ?? null,
    settingsLink: spec.settingsLink ?? false,
  }
}

function sideFrame(edition: 'ebook' | 'audiobook'): ChainFrame {
  return edition === 'audiobook' ? 'group' : 'spine'
}

function sideSlot(s: SyncChainSnapshot, edition: 'ebook' | 'audiobook'): ChainCardRow | ChainGhostRow {
  const side = s[edition]
  const book = side.book
  if (!book) {
    const note = chainMsg(edition === 'ebook' ? 'ghost.noMatchEbook' : 'ghost.noMatchAudiobook')
    return ghostRow(edition, sideFrame(edition), note, { action: s.can.editLink ? action('change', chainMsg('action.search')) : null })
  }
  const linked = sideIsCard(side)
  return {
    kind: 'card',
    id: `card:${edition}`,
    edition,
    frame: sideFrame(edition),
    cover: bookCover(book.id, book.coverVersion),
    title: book.title,
    subtitle: book.authorName,
    routeBookId: side.isThisBook ? null : book.id,
    href: null,
    isThisBook: side.isThisBook,
    external: false,
    progress: book.progress,
    progressPending: false,
    linked,
    chip: linked ? null : candidateChip(side.match, book.title ?? ''),
    ...pairChange(s, side, linked),
    confirm: null,
    rebuild: null,
    job: null,
  }
}

/** A rebuild replaces a ready read-along member, so it needs a real link for the new output to attach to. */
function canRebuildReadAlong(s: SyncChainSnapshot, ra: SyncChainReadAlong): boolean {
  return s.linked && ra.member !== null && ra.status === 'ready' && s.can.generate && s.can.rebuild
}

function readAlongCard(s: SyncChainSnapshot): ChainCardRow {
  const ra = s.readAlong
  const isThisBook = s.thisBook === 'readAlong'
  const linked = ra.member !== null || isThisBook
  const book = ra.member ?? ra.outputBook ?? ra.thisBook
  const canRebuild = canRebuildReadAlong(s, ra)
  return {
    kind: 'card',
    id: 'card:readAlong',
    edition: 'readAlong',
    frame: 'spine',
    cover: book ? bookCover(book.id, ra.member?.coverVersion ?? ra.thisBook?.coverVersion ?? null) : { kind: 'readAlongTile' },
    title: book?.title ?? null,
    subtitle: ra.member?.authorName ?? ra.thisBook?.authorName ?? null,
    routeBookId: book && !isThisBook ? book.id : null,
    href: null,
    isThisBook,
    external: false,
    progress: ra.member?.progress?.percentage ?? null,
    progressPending: false,
    linked,
    chip: linked ? null : chainMsg('chip.generated'),
    change: 'none',
    changeHint: null,
    confirm: null,
    rebuild: canRebuild ? action('rebuildReadAlong', msg(`${EDITION_LINK}actions.rebuild`), ra.mutating || isActionBlocked(ra.blocked)) : null,
    job: readAlongJob(s, true),
  }
}

function absCard(abs: SyncChainAbs, link: AudiobookshelfBookSyncLink): ChainCardRow {
  const progress = abs.live?.progress
  const linked = link.syncing
  const needsReview = !linked && link.pausedReason === 'needs_review'
  return {
    kind: 'card',
    id: 'card:abs',
    edition: 'abs',
    frame: 'group',
    cover: { kind: 'abs', absLibraryItemId: link.absLibraryItemId },
    title: link.title,
    subtitle: link.libraryName,
    routeBookId: null,
    href: link.webUrl,
    isThisBook: false,
    external: true,
    progress: progress ? displayPercentage(progress.percentage, progress.isFinished) : null,
    progressPending: abs.checking,
    linked,
    chip: linked ? null : chainMsg(needsReview ? 'chip.needsReview' : 'chip.paused'),
    change: 'available',
    changeHint: null,
    confirm: needsReview ? action('confirmAbs', chainMsg('action.confirm')) : null,
    rebuild: null,
    job: null,
  }
}

function absSlot(s: SyncChainSnapshot, abs: SyncChainAbs): ChainCardRow | ChainGhostRow {
  const link = abs.link
  const audioExists = s.audiobook.book !== null
  if (!link) {
    if (!audioExists) return ghostRow('abs', 'group', chainMsg('ghost.absNeedsAudio'))
    return ghostRow('abs', 'group', chainMsg('ghost.noMatchAbs'), { action: action('change', chainMsg('action.match')) })
  }
  if (link.pausedReason === 'position_sync_off') return ghostRow('abs', 'group', chainMsg('ghost.absPositionSyncOff'), { settingsLink: true })
  if (!audioExists) return ghostRow('abs', 'group', chainMsg('ghost.absNeedsAudio'))
  return absCard(abs, link)
}

/* Connectors. */

interface ConnectorSpec {
  state: ChainConnectorState
  tone: ChainTone
  icon: ChainIcon
  frame?: ChainFrame
  arrow?: ChainArrow
  pill: ChainMessage
  qualifier?: ChainMessage | null
  explainer?: ChainMessage | null
  switch?: ChainSwitch | null
  disabledReason?: ChainMessage | null
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
    frame: spec.frame ?? 'spine',
    from,
    to,
    state: spec.state,
    tone: spec.tone,
    dashed: spec.tone === 'muted' || spec.tone === 'destructive',
    icon: spec.icon,
    arrow: spec.arrow ?? 'both',
    pill: spec.pill,
    qualifier: spec.qualifier ?? null,
    explainer: spec.explainer ?? null,
    switch: spec.switch ?? null,
    disabledReason: spec.disabledReason ?? (spec.switch?.disabled ? chainMsg('disabled.noPermission') : null),
    note: spec.note ?? null,
    detail: spec.detail ?? null,
    actions: spec.actions ?? [],
    cancel: spec.cancel ?? null,
    ticks: spec.ticks ?? null,
    settingsLink: spec.settingsLink ?? false,
    absDetails: spec.absDetails ?? false,
    mini: {
      text: spec.tone === 'success' ? (spec.miniText ?? null) : (spec.miniText ?? spec.pill),
      action: spec.miniAction ?? null,
    },
  }
}

/** The read-along switch only ever detaches the read-along; the others dissolve the pair or stop Audiobookshelf. */
const OFF_TARGET: Record<ConnectorKey, ChainOffTarget> = {
  'readAlong-audiobook': 'readAlong',
  'ebook-audiobook': 'pair',
  'audiobook-abs': 'abs',
}

function onSwitch(s: SyncChainSnapshot, from: EditionKey, to: EditionKey, disabled = !s.can.editLink): ChainSwitch {
  return { on: true, disabled, onAction: null, offTarget: OFF_TARGET[connectorKey(from, to)] }
}

function editAction(s: SyncChainSnapshot, id: ChainActionId, label: ChainMessage): ChainAction | null {
  return s.can.editLink ? action(id, label) : null
}

function presentActions(...actions: (ChainAction | null)[]): ChainAction[] {
  return actions.filter((a): a is ChainAction => a !== null)
}

interface OffSpec {
  frame: ChainFrame
  arrow?: ChainArrow
  qualifier: ChainMessage
  onAction: ChainActionId | null
  disabledReason: ChainMessage | null
  explainer?: ChainMessage | null
  settingsLink?: boolean
}

/** Nothing is linked across this pair: a muted off switch that the user can turn on unless `disabledReason` says why not. */
function offConnector(from: EditionKey, to: EditionKey, spec: OffSpec): ChainConnectorRow {
  return connectorRow(from, to, {
    state: 'available',
    tone: 'muted',
    icon: 'link',
    frame: spec.frame,
    arrow: spec.arrow,
    pill: chainMsg('pill.available'),
    qualifier: spec.qualifier,
    explainer: spec.explainer,
    switch: { on: false, disabled: spec.disabledReason !== null, onAction: spec.onAction, offTarget: null },
    disabledReason: spec.disabledReason,
    settingsLink: spec.settingsLink,
    miniText: spec.qualifier,
  })
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
      return connectorRow(from, to, {
        state: 'linkedViaWhisper',
        tone: 'success',
        icon: 'link',
        pill: chainMsg('pill.linkedViaWhisper'),
        qualifier: chainMsg('qualifier.viaWhisper'),
        explainer: chainMsg('explain.whisper'),
        switch: onSwitch(s, from, to),
      })
    }
  }
}

function pairConnector(s: SyncChainSnapshot): ChainConnectorRow {
  if (s.linked && sideIsCard(s.ebook) && sideIsCard(s.audiobook)) return alignmentConnector(s, 'ebook', 'audiobook')
  const nothingToLink = s.ebook.book === null || s.audiobook.book === null
  const disabledReason = nothingToLink ? chainMsg('disabled.nothingToLink') : s.can.editLink ? null : chainMsg('disabled.noPermission')
  return offConnector('ebook', 'audiobook', {
    frame: 'spine',
    qualifier: chainMsg('off.notLinked'),
    onAction: 'linkPair',
    disabledReason,
    explainer: chainMsg('explain.whisper'),
  })
}

/** A read-along attaches to its audiobook on its own, so its switch only waits for an audiobook to exist. */
function readAlongOff(s: SyncChainSnapshot): Pick<OffSpec, 'qualifier' | 'disabledReason'> {
  if (s.audiobook.book === null) return { qualifier: chainMsg('off.pickAudiobookFirst'), disabledReason: chainMsg('off.pickAudiobookFirst') }
  return { qualifier: chainMsg('off.notLinked'), disabledReason: s.can.editLink ? null : chainMsg('disabled.noPermission') }
}

function readAlongConnector(s: SyncChainSnapshot): ChainConnectorRow {
  const ra = s.readAlong
  if (ra.member === null) {
    return offConnector('readAlong', 'audiobook', {
      frame: 'spine',
      onAction: 'attachReadAlong',
      explainer: chainMsg('explain.readAlongAudio'),
      ...readAlongOff(s),
    })
  }
  if (s.readAloudIssue !== null) {
    const canRebuild = canRebuildReadAlong(s, ra)
    const disabled = ra.mutating || isActionBlocked(ra.blocked)
    return connectorRow('readAlong', 'audiobook', {
      state: 'readAloudIssue',
      tone: 'warning',
      icon: 'alert',
      frame: 'spine',
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
    frame: 'spine',
    pill: chainMsg('pill.linked'),
    qualifier: chainMsg('qualifier.direct'),
    explainer: chainMsg('explain.readAlongAudio'),
    switch: onSwitch(s, 'readAlong', 'audiobook'),
  })
}

// Receiving and diverged are described by the live hint, which carries the time or the reason.
const ABS_EXPLAIN: Record<AudiobookshelfBookSyncLink['direction'], string> = {
  two_way: 'explain.absTwoWay',
  from_abs: 'explain.absFromAbs',
  to_abs: 'explain.absToAbs',
}

function absNote(state: AbsState): ChainMessage | null {
  switch (state) {
    case 'absUnreachable':
      return chainMsg('note.absUnreachable')
    case 'absSending':
      return msg(`${EDITION_LINK}abs.status.sendingHint`)
    case 'absOneWay':
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

function absArrow(direction: AudiobookshelfBookSyncLink['direction']): ChainArrow {
  return direction === 'from_abs' ? 'left' : direction === 'to_abs' ? 'right' : 'both'
}

function absLinkedConnector(s: SyncChainSnapshot, abs: SyncChainAbs, link: AudiobookshelfBookSyncLink): ChainConnectorRow {
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
    frame: 'group',
    tone: warns ? 'warning' : 'success',
    icon: warns ? 'alert' : 'link',
    arrow: absArrow(link.direction),
    pill,
    qualifier: warns ? null : chainMsg(link.direction === 'two_way' ? 'qualifier.twoWay' : 'qualifier.oneWay'),
    explainer: warns ? null : chainMsg(ABS_EXPLAIN[link.direction]),
    switch: onSwitch(s, 'audiobook', 'abs', false),
    note: absNote(state),
    actions,
    settingsLink: state === 'absUnreachable' || link.direction !== 'two_way',
    absDetails: true,
    miniText: warns ? (state === 'absUnreachable' ? chainMsg('mini.cantReach') : null) : chainMsg('mini.syncedWithAbs'),
    miniAction: state === 'absUnreachable' ? actions[0] : null,
  })
}

function absOffConnector(s: SyncChainSnapshot, link: AudiobookshelfBookSyncLink | null): ChainConnectorRow {
  const off = (qualifier: string, onAction: ChainActionId | null, reason: string | null) =>
    offConnector('audiobook', 'abs', {
      frame: 'group',
      qualifier: chainMsg(qualifier),
      onAction,
      disabledReason: reason ? chainMsg(reason) : null,
      explainer: link ? chainMsg(ABS_EXPLAIN[link.direction]) : null,
      arrow: link ? absArrow(link.direction) : undefined,
      settingsLink: link !== null && link.direction !== 'two_way',
    })
  if (link?.pausedReason === 'position_sync_off') return off('off.syncOffInSettings', null, 'off.syncOffInSettings')
  if (s.audiobook.book === null) return off('off.pickAudiobookFirst', null, 'off.pickAudiobookFirst')
  if (!link) return off('off.notMatched', null, 'disabled.nothingToLink')
  return link.pausedReason === 'needs_review' ? off('off.needsReview', 'confirmAbs', null) : off('off.syncPaused', 'resumeAbs', null)
}

function absConnector(s: SyncChainSnapshot, abs: SyncChainAbs): ChainConnectorRow {
  return absIsCard(s) && abs.link ? absLinkedConnector(s, abs, abs.link) : absOffConnector(s, abs.link)
}

/* Read-along slot. */

function readAlongSlotRow(spec: Pick<ChainReadAlongSlotRow, 'variant' | 'note'> & Partial<ChainReadAlongSlotRow>): ChainReadAlongSlotRow {
  return {
    kind: 'readAlongSlot',
    id: 'slot:readAlong',
    label: chainMsg(SHORT_LABEL_KEY.readAlong),
    action: null,
    cancel: null,
    job: null,
    secondary: null,
    error: null,
    expandable: false,
    ...spec,
  }
}

function idleSlot(s: SyncChainSnapshot): ChainReadAlongSlotRow | null {
  const ra = s.readAlong
  if (!s.can.generate || ra.blocked === 'not_configured') return null
  const generate = (disabled: boolean) => action('openGenerate', chainMsg('action.generate'), disabled)
  if (s.audiobook.book === null) return readAlongSlotRow({ variant: 'needsAudio', note: chainMsg('slot.needsAudio'), action: generate(true) })
  if (s.ebook.book === null) return readAlongSlotRow({ variant: 'needsEbook', note: chainMsg('slot.needsEbook'), action: generate(true) })
  const blocked = ra.blocked === 'no_pair' && !s.linked ? null : ra.blocked
  if (isActionBlocked(blocked)) {
    return readAlongSlotRow({
      variant: 'blocked',
      note: msg(`${EDITION_LINK}readAlong.blocked.${snakeToCamel(blocked ?? '')}`),
      action: generate(true),
    })
  }
  return readAlongSlotRow({
    variant: 'notGenerated',
    note: chainMsg('slot.notGenerated'),
    action: generate(ra.mutating),
    expandable: true,
  })
}

function readAlongSlot(s: SyncChainSnapshot): ChainReadAlongSlotRow | null {
  const ra = s.readAlong
  if (ra.memberPending || readAlongBookExists(s) || readAlongOutOfReach(s)) return null
  switch (ra.status) {
    case 'queued':
    case 'building': {
      const job = readAlongJob(s, false)
      const note =
        ra.status === 'building'
          ? chainMsg('slot.generating')
          : ra.queuePosition === null
            ? msg(`${EDITION_LINK}readAlong.body.queuedUnknown`)
            : msg(`${EDITION_LINK}readAlong.body.queued`, { position: ra.queuePosition })
      return readAlongSlotRow({ variant: ra.status, note, cancel: job?.cancel ?? null, job })
    }
    case 'failed':
      return readAlongSlotRow({
        variant: 'failed',
        note: chainMsg('slot.failed', { step: READ_ALONG_STAGES[stageIndex(ra.phase, ra.remoteTask)]! }),
        action: s.can.generate ? action('retryReadAlong', chainMsg('action.retry'), ra.mutating || isActionBlocked(ra.blocked)) : null,
        cancel: s.can.generate ? action('cancelReadAlong', chainMsg('slot.dismiss'), ra.mutating) : null,
        secondary: ra.error ? action('toggleLog', chainMsg('action.viewLog')) : null,
        error: ra.error,
      })
    default:
      return idleSlot(s)
  }
}

/* Read-along tail. */

/** The muted connector above a read-along that has nothing to switch: a bare node that keeps the spine rail joined. */
function mutedReadAlongConnector(qualifier: ChainMessage | null): ChainConnectorRow {
  const pill = qualifier ?? chainMsg('pill.available')
  const row = connectorRow('readAlong', 'audiobook', { state: 'available', tone: 'muted', icon: 'link', pill, qualifier })
  return { ...row, mini: { text: null, action: null } }
}

function readAlongRows(s: SyncChainSnapshot): ChainRow[] {
  if (readAlongBookExists(s)) return [readAlongConnector(s), readAlongCard(s)]
  if (readAlongOutOfReach(s)) {
    return [mutedReadAlongConnector(null), ghostRow('readAlong', 'spine', msg(`${EDITION_LINK}readAlong.body.outOfReach`))]
  }
  const slot = readAlongSlot(s)
  return slot ? [mutedReadAlongConnector(chainMsg('off.notGenerated')), slot] : []
}

function orderedRows(s: SyncChainSnapshot): ChainRow[] {
  const group: ChainRow[] = [sideSlot(s, 'audiobook'), ...(s.abs ? [absConnector(s, s.abs), absSlot(s, s.abs)] : [])]
  const ebookSlot = sideSlot(s, 'ebook')
  const ebookConnector = pairConnector(s)
  switch (s.thisBook) {
    case 'ebook':
      return [ebookSlot, ebookConnector, ...group, ...readAlongRows(s)]
    case 'audiobook':
      return [...group, ebookConnector, ebookSlot, ...readAlongRows(s)]
    case 'readAlong':
      return [readAlongCard(s), readAlongConnector(s), ...group, ebookConnector, ebookSlot]
  }
}

/* Header. */

function headerPriority(s: SyncChainSnapshot): 1 | 2 | 3 | null {
  const pairLinked = s.linked && sideIsCard(s.ebook) && sideIsCard(s.audiobook)
  const align = pairLinked ? alignmentState(s.alignment) : null
  const raStatus = s.readAlong.status
  const abs = absIsCard(s) && s.abs?.link ? absState(s.abs.link, s.abs.live) : null
  if (align === 'alignmentFailed' || raStatus === 'failed') return 1
  const alignWarns = align === 'outOfDate' || align === 'notAligned' || align === 'cantAlign' || align === 'alignmentBlocked'
  if (alignWarns || hasReadAloudIssue(s) || abs === 'absUnreachable' || abs === 'absDiverged') return 2
  if (align === 'linking' || align === 'rebuilding' || raStatus === 'queued' || raStatus === 'building') return 3
  return null
}

function countInSync(s: SyncChainSnapshot): number {
  const absSyncing = absIsCard(s)
  const ebook = sideIsCard(s.ebook) && s.ebook.isMember
  const readAlong = s.readAlong.member !== null
  // The audiobook is in sync while anything hangs off it, even when this page is not linked to it.
  const audiobook = s.audiobook.book !== null && (s.audiobook.isMember || absSyncing || readAlong)
  return [ebook, audiobook, readAlong, absSyncing].filter(Boolean).length
}

export function buildSyncChain(input: SyncChainSnapshot): SyncChain {
  const snapshot = input.abs && !input.abs.configured ? { ...input, abs: null } : input
  const rows = orderedRows(snapshot)

  const inSync = countInSync(snapshot)
  const present = rows.filter((row) => row.kind === 'card').length
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
    needsAttention: priority === 1 || priority === 2 || rows.some((row) => row.kind === 'card' && row.confirm !== null),
  }
}

// SyncChainAbsDetails renders a live hint line on receiving and diverged rows, where the model leaves `note` empty.
function hasNoteLine(row: ChainConnectorRow): boolean {
  return row.note !== null || (row.absDetails && (row.state === 'absReceiving' || row.state === 'absDiverged'))
}

function modifyRowHeight(row: ChainRow): number {
  switch (row.kind) {
    case 'card':
      return MODIFY_CARD_HEIGHT + (row.job ? MODIFY_CARD_JOB_HEIGHT : 0)
    case 'ghost':
      return MODIFY_GHOST_HEIGHT
    case 'connector':
      return (
        (row.frame === 'group' ? MODIFY_INNER_CONNECTOR_HEIGHT : MODIFY_CONNECTOR_HEIGHT) +
        (hasNoteLine(row) ? MODIFY_CONNECTOR_NOTE_HEIGHT : 0) +
        (row.actions.length > 0 ? MODIFY_CONNECTOR_ACTIONS_HEIGHT : 0) +
        (row.ticks ? MODIFY_CONNECTOR_TICKS_HEIGHT : 0)
      )
    case 'readAlongSlot':
      return MODIFY_SLOT_HEIGHT + (row.job ? MODIFY_CARD_JOB_HEIGHT : 0)
  }
}

function estimateModifyHeight(chain: SyncChain): number {
  return chain.rows.reduce((total, row) => total + modifyRowHeight(row), PANEL_CHROME_HEIGHT + HEIGHT_SLACK)
}

/** Modify when something needs attention or the Modify estimate fits the space; compact otherwise. */
export function initialViewMode(chain: SyncChain, availableHeight: number): ChainViewMode {
  return chain.needsAttention || estimateModifyHeight(chain) <= availableHeight ? 'modify' : 'compact'
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
