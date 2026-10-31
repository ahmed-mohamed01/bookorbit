import type {
  AlignmentBuildBlockReason,
  AlignmentStatus,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  ReadAloudProgressSync,
} from '@bookorbit/types'
import { isTerminalBlock } from '@/features/book/lib/position-sync'
import { stageLabelKey, type ReadAloudEntryState } from '@/features/read-aloud/lib/read-aloud'
import { displayPercentage } from '@/features/book/lib/abs-sync-status'
import { formatBytes } from '@/lib/formatting'

/**
 * The Position sync panel as a spine of one book's own files: its ebook, its read-along and an audio
 * group (the audiobook with Audiobookshelf linked beneath it), with a connector between neighbouring
 * slots carrying that pair's sync state. Upstream's read-aloud sync joins the read-along to the audio and
 * to the plain EPUB; whisper joins the plain EPUB to the audio only in a book with no read-along.
 * `buildSyncChain` turns one snapshot of the panel's composables into that row list; it is pure so every
 * state can be pinned by a unit test.
 */

export type EditionKey = 'ebook' | 'readAlong' | 'audiobook' | 'abs'

export type ConnectorKey = 'readAlong-audiobook' | 'ebook-readAlong' | 'ebook-audiobook' | 'audiobook-abs'

export type ChainTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'
export type ChainIcon = 'link' | 'spinner' | 'alert' | 'ban'
/** The position flow drawn between a connector's names: both ways, towards `from` or towards `to`. */
export type ChainArrow = 'both' | 'left' | 'right'
export type ChainViewMode = 'compact' | 'modify'

export type ChainActionId =
  | 'cancelAlignment'
  | 'retryAlignment'
  | 'alignNow'
  | 'rebuildAlignment'
  | 'enableReadAloudSync'
  | 'disableReadAloudSync'
  | 'createReadAloud'
  | 'modifyReadAloud'
  | 'cancelReadAloud'
  | 'retryReadAloud'
  | 'reviewReadAloud'
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

/** One kind of file the book holds, as `bookFormatEntries` groups them. */
export interface SyncChainEdition {
  title: string | null
  /** The translated format name, such as "EPUB e-book". */
  formatName: string
  fileCount: number
  sizeBytes: number
  /** 0..100, null when nothing is recorded. */
  progress: number | null
}

export interface SyncChainAlignment {
  status: AlignmentStatus
  stale: boolean
  builtAt: string | null
  samplesDone: number | null
  samplesTotal: number | null
  buildBlocked: AlignmentBuildBlockReason | null
  buildError: string | null
  /** A build is queued or running, including the window between a request and the first 'building' read. */
  running: boolean
}

export interface SyncChainReadAloud {
  sync: ReadAloudProgressSync
  /** Upstream's duration copy, already formatted, for a duration mismatch. */
  audioDuration: string
  overlayDuration: string
}

/** A read-aloud job the slot follows: running, waiting for review, or failed and not dismissed. */
export interface SyncChainReadAloudJob {
  status: 'queued' | 'processing' | 'awaiting_review' | 'failed'
  stage: string
  /** 0..100 for the current run. */
  progress: number
  queuePosition: number | null
  /** A cancel was asked for and the worker has not stopped yet. */
  stopping: boolean
  canCancel: boolean
  canRetry: boolean
  /** Upstream's error text for a failed job. */
  errorKey: string | null
}

/** Upstream's read-aloud generator as the slot sees it, for a book with an EPUB and audio and no read-along. */
export interface SyncChainReadAloudSlot {
  entry: ReadAloudEntryState
  job: SyncChainReadAloudJob | null
  /** The job action in flight, which locks the slot's buttons. */
  pending: 'create' | 'cancel' | 'retry' | 'other' | null
  /** The last failed start or job action, shown in place of the note. */
  errorKey: string | null
}

export interface SyncChainAbs {
  /** The integration is effectively on for this reader; without it the chain has no Audiobookshelf rows. */
  configured: boolean
  link: AudiobookshelfBookSyncLink | null
  live: AudiobookshelfBookSyncLive | null
  checking: boolean
}

export interface SyncChainSnapshot {
  bookId: number
  coverVersion: string | null
  ebook: SyncChainEdition | null
  audiobook: SyncChainEdition | null
  readAlong: SyncChainEdition | null
  readAloudSlot: SyncChainReadAloudSlot
  alignment: SyncChainAlignment
  readAloud: SyncChainReadAloud
  /** Null without the Audiobookshelf sync permission. */
  abs: SyncChainAbs | null
  can: { align: boolean }
}

/* Rows. */

type ChainCover = { kind: 'book'; bookId: number; coverVersion: string | null } | { kind: 'abs'; absLibraryItemId: string }

/** `group` rows are drawn inside the audio box: the audiobook, its Audiobookshelf connector and the Audiobookshelf row. */
export type ChainFrame = 'spine' | 'group'

export interface ChainCardRow {
  kind: 'card'
  id: string
  edition: EditionKey
  frame: ChainFrame
  cover: ChainCover
  title: string | null
  /** File summary for a file, library for the Audiobookshelf item. */
  subtitle: ChainMessage | null
  /** Audiobookshelf's own page for the item, opened in a new tab. */
  href: string | null
  external: boolean
  progress: number | null
  /** The live check is still running, so the progress bar shows a shimmer. */
  progressPending: boolean
  /** A paused Audiobookshelf match renders dashed; every file of the book renders as a full card. */
  linked: boolean
  /** The dashed card's small label: why it is not syncing. */
  chip: ChainMessage | null
  /** Modify-only Change, for the Audiobookshelf match. */
  change: boolean
  /** Modify-only Confirm on an Audiobookshelf match that needs review. */
  confirm: ChainAction | null
}

export interface ChainGhostRow {
  kind: 'ghost'
  id: string
  edition: EditionKey
  frame: ChainFrame
  label: ChainMessage
  note: ChainMessage
  /** At most one: Match, Create read-along. */
  action: ChainAction | null
  settingsLink: boolean
}

export type ChainReadAloudSlotVariant = 'notCreated' | 'unavailable' | 'queued' | 'processing' | 'review' | 'failed'

export interface ChainReadAloudSlotRow {
  kind: 'readAloudSlot'
  id: 'slot:readAlong'
  edition: 'readAlong'
  frame: 'spine'
  variant: ChainReadAloudSlotVariant
  label: ChainMessage
  note: ChainMessage
  /** Create, Retry or Review. */
  action: ChainAction | null
  /** Modify beside Create, Review beside Retry. */
  secondary: ChainAction | null
  /** The red X for a job in flight. */
  cancel: ChainAction | null
  /** The action whose request is in flight, which spins. */
  pending: ChainActionId | null
  /** Queued or processing: the stepper's stage and percent. */
  progress: { stage: string; percent: number | null } | null
}

export type ChainConnectorState =
  | 'aligning'
  | 'rebuilding'
  | 'alignmentFailed'
  | 'outOfDate'
  | 'cantAlign'
  | 'alignmentBlocked'
  | 'notAligned'
  | 'linkedViaWhisper'
  | 'readAloudSynced'
  | 'readAloudPartial'
  | 'readAloudIssue'
  | 'epubCopiesSynced'
  | 'available'
  | 'absUnreachable'
  | 'absDiverged'
  | 'absReceiving'
  | 'absSending'
  | 'absOneWay'
  | 'absLinked'

interface ChainSwitch {
  on: boolean
  disabled: boolean
  /** What turning it on runs, and what turning it off runs (or the confirm it opens). */
  onAction: ChainActionId | null
  offAction: ChainActionId | null
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
  /** Modify view: muted text after the pair label, such as "via Whisper" when synced or "sync off" when off. */
  qualifier: ChainMessage | null
  /** Modify view: what the link does and how, shown when the chevron beside the qualifier is open. */
  explainer: ChainMessage | null
  /** Null when the pair has no switch, and the rail shows a node instead. */
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

export type ChainRow = ChainCardRow | ChainGhostRow | ChainConnectorRow | ChainReadAloudSlotRow

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
const READ_ALOUD_SYNC = 'book.detail.details.readAloudSync.'

const SHORT_LABEL_KEY: Record<EditionKey, string> = {
  ebook: 'short.ebook',
  readAlong: 'short.readAlong',
  audiobook: 'short.audiobook',
  abs: 'kind.abs',
}

const PANEL_CHROME_HEIGHT = 96
const HEIGHT_SLACK = 24
const MODIFY_CARD_HEIGHT = 66
const MODIFY_GHOST_HEIGHT = 46
const MODIFY_SLOT_STEPPER_HEIGHT = 36
const MODIFY_CONNECTOR_HEIGHT = 32
const MODIFY_INNER_CONNECTOR_HEIGHT = 28
const MODIFY_CONNECTOR_NOTE_HEIGHT = 30
const MODIFY_CONNECTOR_ACTIONS_HEIGHT = 32
const MODIFY_CONNECTOR_TICKS_HEIGHT = 20

function msg(key: string, params?: Record<string, string | number>): ChainMessage {
  return params ? { key, params } : { key }
}

function chainMsg(suffix: string, params?: Record<string, string | number>): ChainMessage {
  return msg(CHAIN + suffix, params)
}

function action(id: ChainActionId, label: ChainMessage, disabled = false): ChainAction {
  return { id, label, disabled }
}

/* State resolution shared by the rows and the header. */

type AlignmentState = 'aligning' | 'rebuilding' | 'alignmentFailed' | 'outOfDate' | 'cantAlign' | 'alignmentBlocked' | 'notAligned' | 'ready'

function alignmentState(a: SyncChainAlignment): AlignmentState {
  if (a.running || a.status === 'pending' || a.status === 'building') return a.builtAt === null ? 'aligning' : 'rebuilding'
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

/** Upstream's read-aloud sync owns text and audio wherever the book has a read-along, so whisper fills in only without one. */
function usesWhisper(s: SyncChainSnapshot): boolean {
  return s.ebook !== null && s.audiobook !== null && s.readAlong === null
}

function hasReadAloudPair(s: SyncChainSnapshot): boolean {
  return s.readAlong !== null && s.audiobook !== null
}

/** Upstream counts any second EPUB beside the read-along as a copy it keeps in step through the narration. */
function hasEpubCopy(s: SyncChainSnapshot): boolean {
  return s.readAlong !== null && (s.ebook !== null || s.readAlong.fileCount > 1)
}

/** Upstream's "EPUB copies only": the audiobook half is unavailable, but the EPUB copies still sync. */
function syncsEpubCopiesOnly(s: SyncChainSnapshot): boolean {
  const sync = s.readAloud.sync
  return sync.state === 'unavailable' && sync.unavailableReason !== 'no_media_overlay_epub' && hasEpubCopy(s)
}

function absIsCard(s: SyncChainSnapshot): boolean {
  return s.abs?.link?.syncing === true && s.audiobook !== null
}

/* Cards and ghosts. */

function fileSummary(edition: SyncChainEdition): ChainMessage {
  const params = { format: edition.formatName, count: edition.fileCount, size: formatBytes(edition.sizeBytes) }
  return chainMsg(edition.fileCount > 1 ? 'fileSummary' : 'fileSummarySingle', params)
}

function fileCard(s: SyncChainSnapshot, edition: Exclude<EditionKey, 'abs'>, file: SyncChainEdition): ChainCardRow {
  return {
    kind: 'card',
    id: `card:${edition}`,
    edition,
    frame: edition === 'audiobook' ? 'group' : 'spine',
    cover: { kind: 'book', bookId: s.bookId, coverVersion: s.coverVersion },
    title: file.title,
    subtitle: fileSummary(file),
    href: null,
    external: false,
    progress: file.progress,
    progressPending: false,
    linked: true,
    chip: null,
    change: false,
    confirm: null,
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
    subtitle: link.libraryName ? msg(`${EDITION_LINK}abs.library`, { name: link.libraryName }) : null,
    href: link.webUrl,
    external: true,
    progress: progress ? displayPercentage(progress.percentage, progress.isFinished) : null,
    progressPending: abs.checking,
    linked,
    chip: linked ? null : chainMsg(needsReview ? 'chip.needsReview' : 'chip.paused'),
    change: true,
    confirm: needsReview ? action('confirmAbs', chainMsg('action.confirm')) : null,
  }
}

function absSlot(abs: SyncChainAbs): ChainCardRow | ChainGhostRow {
  const link = abs.link
  if (!link) return ghostRow('abs', 'group', chainMsg('ghost.noMatchAbs'), { action: action('change', chainMsg('action.match')) })
  if (link.pausedReason === 'position_sync_off') return ghostRow('abs', 'group', chainMsg('ghost.absPositionSyncOff'), { settingsLink: true })
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

function connectorRow(from: EditionKey, to: EditionKey, spec: ConnectorSpec): ChainConnectorRow {
  const key = `${from}-${to}` as ConnectorKey
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
    disabledReason: spec.disabledReason ?? null,
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

function alignAction(s: SyncChainSnapshot, id: ChainActionId, label: ChainMessage): ChainAction | null {
  return s.can.align ? action(id, label) : null
}

function presentActions(...actions: (ChainAction | null)[]): ChainAction[] {
  return actions.filter((a): a is ChainAction => a !== null)
}

function alignmentConnector(s: SyncChainSnapshot): ChainConnectorRow {
  const a = s.alignment
  const ticks = { samplesDone: a.samplesDone, samplesTotal: a.samplesTotal }
  const whisper = { explainer: chainMsg('explain.whisper') }
  switch (alignmentState(a)) {
    case 'aligning':
      return connectorRow('ebook', 'audiobook', {
        state: 'aligning',
        tone: 'info',
        icon: 'spinner',
        pill: chainMsg('pill.aligning'),
        note: chainMsg('note.aligning'),
        cancel: alignAction(s, 'cancelAlignment', chainMsg('cancelAlignment')),
        ticks,
        miniText: chainMsg('mini.aligning'),
        ...whisper,
      })
    case 'rebuilding':
      return connectorRow('ebook', 'audiobook', {
        state: 'rebuilding',
        tone: 'info',
        icon: 'spinner',
        pill: chainMsg('pill.rebuilding'),
        cancel: alignAction(s, 'cancelAlignment', chainMsg('cancelAlignment')),
        ticks,
        miniText: chainMsg('mini.rebuilding'),
        ...whisper,
      })
    case 'alignmentFailed': {
      const retry = alignAction(s, 'retryAlignment', chainMsg('action.retry'))
      return connectorRow('ebook', 'audiobook', {
        state: 'alignmentFailed',
        tone: 'destructive',
        icon: 'alert',
        pill: chainMsg('pill.alignmentFailed'),
        note: chainMsg('note.alignmentFailed'),
        detail: a.buildError,
        actions: presentActions(retry),
        miniAction: retry,
      })
    }
    case 'outOfDate':
      return connectorRow('ebook', 'audiobook', {
        state: 'outOfDate',
        tone: 'warning',
        icon: 'alert',
        pill: chainMsg('pill.outOfDate'),
        note: chainMsg('note.stale'),
        actions: presentActions(alignAction(s, 'rebuildAlignment', chainMsg('action.rebuildAlignment'))),
        miniAction: alignAction(s, 'rebuildAlignment', msg(`${EDITION_LINK}actions.rebuild`)),
        ...whisper,
      })
    case 'cantAlign':
      return connectorRow('ebook', 'audiobook', {
        state: 'cantAlign',
        tone: 'muted',
        icon: 'ban',
        pill: chainMsg('pill.cantAlign'),
        note: msg('book.detail.readingAlignment.unalignableHint'),
      })
    case 'alignmentBlocked':
      return connectorRow('ebook', 'audiobook', {
        state: 'alignmentBlocked',
        tone: 'muted',
        icon: 'ban',
        pill: chainMsg('pill.notAligned'),
        note: msg(`book.detail.readingAlignment.buildBlocked.${a.buildBlocked}`),
      })
    case 'notAligned': {
      const alignNow = alignAction(s, 'alignNow', chainMsg('action.alignNow'))
      return connectorRow('ebook', 'audiobook', {
        state: 'notAligned',
        tone: 'muted',
        icon: 'link',
        pill: chainMsg('pill.notAligned'),
        note: msg(a.buildBlocked === 'busy' ? 'book.detail.readingAlignment.buildBlocked.busy' : 'book.detail.readingAlignment.idleHint'),
        actions: presentActions(alignNow),
        miniAction: alignNow,
        ...whisper,
      })
    }
    case 'ready':
      return connectorRow('ebook', 'audiobook', {
        state: 'linkedViaWhisper',
        tone: 'success',
        icon: 'link',
        pill: chainMsg('pill.linkedViaWhisper'),
        qualifier: chainMsg('qualifier.viaWhisper'),
        ...whisper,
      })
  }
}

function readAloudReason(r: SyncChainReadAloud): ChainMessage {
  const reason = r.sync.unavailableReason ?? 'missing_duration'
  if (reason === 'duration_mismatch') return msg(`${READ_ALOUD_SYNC}reason.durationMismatch`, { audio: r.audioDuration, overlay: r.overlayDuration })
  return msg(`${READ_ALOUD_SYNC}reason.${reason}`)
}

function readAloudToggle(sync: ReadAloudProgressSync): ChainSwitch {
  return { on: sync.mode !== 'disabled', disabled: false, onAction: 'enableReadAloudSync', offAction: 'disableReadAloudSync' }
}

/** Upstream's per-book read-aloud sync: the toggle flips its mode, whatever state the pair is in. */
function readAloudConnector(s: SyncChainSnapshot): ChainConnectorRow {
  const sync = s.readAloud.sync
  const toggle = readAloudToggle(sync)
  const explainer = chainMsg('explain.readAlongAudio')
  if (sync.state === 'disabled') {
    return connectorRow('readAlong', 'audiobook', {
      state: 'available',
      tone: 'muted',
      icon: 'link',
      pill: msg(`${READ_ALOUD_SYNC}chip.disabled`),
      qualifier: msg(`${READ_ALOUD_SYNC}chip.disabled`),
      explainer,
      switch: toggle,
    })
  }
  // With a plain EPUB on the spine its own connector shows the copies syncing; this one is then only the audio half.
  if (syncsEpubCopiesOnly(s) && s.ebook === null) {
    return connectorRow('readAlong', 'audiobook', {
      state: 'readAloudPartial',
      tone: 'warning',
      icon: 'alert',
      pill: msg(`${READ_ALOUD_SYNC}chip.partial`),
      explainer: msg(`${READ_ALOUD_SYNC}epubCopiesDescription`),
      switch: toggle,
      note: readAloudReason(s.readAloud),
    })
  }
  if (sync.state === 'unavailable') {
    return connectorRow('readAlong', 'audiobook', {
      state: 'readAloudIssue',
      tone: 'warning',
      icon: 'alert',
      pill: msg(`${READ_ALOUD_SYNC}chip.unavailable`),
      switch: toggle,
      note: readAloudReason(s.readAloud),
    })
  }
  return connectorRow('readAlong', 'audiobook', {
    state: 'readAloudSynced',
    tone: 'success',
    icon: 'link',
    pill: msg(`${READ_ALOUD_SYNC}chip.enabled`),
    qualifier: chainMsg('qualifier.direct'),
    explainer,
    switch: toggle,
  })
}

/** Upstream's read-aloud sync keeps the plain EPUB in step with the read-along through its narration, with or without audio. */
function epubCopiesConnector(s: SyncChainSnapshot): ChainConnectorRow {
  const sync = s.readAloud.sync
  const toggle = readAloudToggle(sync)
  const explainer = msg(`${READ_ALOUD_SYNC}epubCopiesDescription`)
  if (sync.state === 'disabled') {
    return connectorRow('ebook', 'readAlong', {
      state: 'available',
      tone: 'muted',
      icon: 'link',
      pill: msg(`${READ_ALOUD_SYNC}chip.disabled`),
      qualifier: msg(`${READ_ALOUD_SYNC}chip.disabled`),
      explainer,
      switch: toggle,
    })
  }
  if (sync.state === 'unavailable' && !syncsEpubCopiesOnly(s)) {
    return connectorRow('ebook', 'readAlong', {
      state: 'readAloudIssue',
      tone: 'warning',
      icon: 'alert',
      pill: msg(`${READ_ALOUD_SYNC}chip.unavailable`),
      switch: toggle,
      note: readAloudReason(s.readAloud),
    })
  }
  return connectorRow('ebook', 'readAlong', {
    state: 'epubCopiesSynced',
    tone: 'success',
    icon: 'link',
    pill: msg(`${READ_ALOUD_SYNC}chip.enabled`),
    // "EPUB copies only" is upstream's word for the copies syncing without the audio half.
    qualifier: s.audiobook && !syncsEpubCopiesOnly(s) ? chainMsg('qualifier.direct') : msg(`${READ_ALOUD_SYNC}state.epubCopiesOnly`),
    explainer,
    switch: toggle,
  })
}

/** Leads into the read-aloud slot: nothing to sync yet, so a dashed rail with no switch. */
function noReadAlongConnector(): ChainConnectorRow {
  return connectorRow('readAlong', 'audiobook', {
    state: 'available',
    tone: 'muted',
    icon: 'link',
    pill: chainMsg('off.noReadAlong'),
    qualifier: chainMsg('off.noReadAlong'),
    explainer: chainMsg('explain.readAlongAudio'),
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

function absLinkedConnector(abs: SyncChainAbs, link: AudiobookshelfBookSyncLink): ChainConnectorRow {
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
    switch: { on: true, disabled: false, onAction: null, offAction: 'pauseAbs' },
    note: absNote(state),
    actions,
    settingsLink: state === 'absUnreachable' || link.direction !== 'two_way',
    absDetails: true,
    miniText: warns ? (state === 'absUnreachable' ? chainMsg('mini.cantReach') : null) : chainMsg('mini.syncedWithAbs'),
    miniAction: state === 'absUnreachable' ? actions[0] : null,
  })
}

function absOffConnector(link: AudiobookshelfBookSyncLink | null): ChainConnectorRow {
  const off = (qualifier: string, onAction: ChainActionId | null, reason: string | null) =>
    connectorRow('audiobook', 'abs', {
      state: 'available',
      tone: 'muted',
      icon: 'link',
      frame: 'group',
      arrow: link ? absArrow(link.direction) : undefined,
      pill: chainMsg('pill.available'),
      qualifier: chainMsg(qualifier),
      explainer: link ? chainMsg(ABS_EXPLAIN[link.direction]) : null,
      switch: { on: false, disabled: reason !== null, onAction, offAction: null },
      disabledReason: reason ? chainMsg(reason) : null,
      settingsLink: link !== null && link.direction !== 'two_way',
      miniText: chainMsg(qualifier),
    })
  if (link?.pausedReason === 'position_sync_off') return off('off.syncOffInSettings', null, 'off.syncOffInSettings')
  if (!link) return off('off.notMatched', null, 'disabled.nothingToLink')
  return link.pausedReason === 'needs_review' ? off('off.needsReview', 'confirmAbs', null) : off('off.syncPaused', 'resumeAbs', null)
}

function absConnector(s: SyncChainSnapshot, abs: SyncChainAbs): ChainConnectorRow {
  return absIsCard(s) && abs.link ? absLinkedConnector(abs, abs.link) : absOffConnector(abs.link)
}

/*
 * Order: ebook, read-along, the audio group, so each upstream pair sits side by side. Without a read-along
 * the ebook meets the audio through whisper and the read-aloud slot trails the audio group.
 * A connector only joins two files that are both there.
 */

function audioGroup(s: SyncChainSnapshot, audiobook: SyncChainEdition): ChainRow[] {
  const abs = s.abs ? [absConnector(s, s.abs), absSlot(s.abs)] : []
  return [fileCard(s, 'audiobook', audiobook), ...abs]
}

/* Read-aloud slot. */

const READ_ALOUD = 'book.detail.files.readAloud.'

const PENDING_ACTION: Record<Exclude<SyncChainReadAloudSlot['pending'], null>, ChainActionId | null> = {
  create: 'createReadAloud',
  cancel: 'cancelReadAloud',
  retry: 'retryReadAloud',
  other: null,
}

function slotRow(
  slot: SyncChainReadAloudSlot,
  spec: Pick<ChainReadAloudSlotRow, 'variant' | 'note'> & Partial<Pick<ChainReadAloudSlotRow, 'action' | 'secondary' | 'cancel' | 'progress'>>,
): ChainReadAloudSlotRow {
  const locked = slot.pending !== null
  const lock = (a: ChainAction | null | undefined) => (a ? { ...a, disabled: a.disabled || locked } : null)
  return {
    kind: 'readAloudSlot',
    id: 'slot:readAlong',
    edition: 'readAlong',
    frame: 'spine',
    variant: spec.variant,
    label: chainMsg(SHORT_LABEL_KEY.readAlong),
    note: slot.errorKey ? msg(slot.errorKey) : spec.note,
    action: lock(spec.action),
    secondary: lock(spec.secondary),
    cancel: lock(spec.cancel),
    pending: slot.pending ? PENDING_ACTION[slot.pending] : null,
    progress: spec.progress ?? null,
  }
}

function jobSlot(slot: SyncChainReadAloudSlot, job: SyncChainReadAloudJob): ChainReadAloudSlotRow {
  const cancel = job.canCancel && !job.stopping ? action('cancelReadAloud', msg(`${READ_ALOUD}job.cancel`)) : null
  const review = action('reviewReadAloud', chainMsg('action.review'))
  switch (job.status) {
    case 'queued':
      return slotRow(slot, {
        variant: 'queued',
        note: job.stopping
          ? msg(`${READ_ALOUD}job.stoppingTitle`)
          : job.queuePosition === null
            ? msg(`${READ_ALOUD}job.queuedTitle`)
            : msg(`${READ_ALOUD}job.queueAhead`, { count: job.queuePosition }),
        cancel,
        progress: { stage: job.stage, percent: null },
      })
    case 'processing':
      return slotRow(slot, {
        variant: 'processing',
        note: job.stopping ? msg(`${READ_ALOUD}job.stoppingTitle`) : msg(stageLabelKey(job.stage)),
        cancel,
        progress: { stage: job.stage, percent: Math.round(Math.min(Math.max(job.progress, 0), 100)) },
      })
    case 'awaiting_review':
      return slotRow(slot, { variant: 'review', note: msg(`${READ_ALOUD}job.reviewTitle`), action: review })
    case 'failed': {
      const retry = job.canRetry ? action('retryReadAloud', msg(`${READ_ALOUD}job.retry`)) : null
      return slotRow(slot, {
        variant: 'failed',
        note: msg(job.errorKey ?? `${READ_ALOUD}errors.job.unknown`),
        action: retry ?? review,
        secondary: retry ? review : null,
      })
    }
  }
}

/** Upstream hides its entry when the generator can never run here; a job it already holds still shows. */
function readAloudSlot(s: SyncChainSnapshot): ChainReadAloudSlotRow | null {
  const slot = s.readAloudSlot
  if (slot.job) return jobSlot(slot, slot.job)
  const entry = slot.entry
  if (entry.kind === 'available') {
    return slotRow(slot, {
      variant: 'notCreated',
      note: chainMsg('slot.notCreated'),
      action: action('createReadAloud', msg(`${READ_ALOUD}action`)),
      secondary: action('modifyReadAloud', chainMsg('modify')),
    })
  }
  if (entry.kind === 'unavailable' && entry.reason !== 'job_active') {
    return slotRow(slot, { variant: 'unavailable', note: msg(entry.reasonKey) })
  }
  return null
}

function readAloudSlotRows(s: SyncChainSnapshot): ChainRow[] {
  if (!s.ebook || !s.audiobook || s.readAlong) return []
  const slot = readAloudSlot(s)
  return slot ? [noReadAlongConnector(), slot] : []
}

function withReadAlong(s: SyncChainSnapshot, readAlong: SyncChainEdition): ChainRow[] {
  const rows: ChainRow[] = []
  if (s.ebook) rows.push(fileCard(s, 'ebook', s.ebook), epubCopiesConnector(s))
  rows.push(fileCard(s, 'readAlong', readAlong))
  if (s.audiobook) rows.push(readAloudConnector(s), ...audioGroup(s, s.audiobook))
  return rows
}

function orderedRows(s: SyncChainSnapshot): ChainRow[] {
  if (s.readAlong) return withReadAlong(s, s.readAlong)
  const rows: ChainRow[] = []
  if (s.ebook) rows.push(fileCard(s, 'ebook', s.ebook))
  if (s.audiobook) {
    if (s.ebook) rows.push(alignmentConnector(s))
    rows.push(...audioGroup(s, s.audiobook))
  }
  rows.push(...readAloudSlotRows(s))
  return rows
}

/* Header. */

function headerPriority(s: SyncChainSnapshot): 1 | 2 | 3 | null {
  const align = usesWhisper(s) ? alignmentState(s.alignment) : null
  const abs = absIsCard(s) && s.abs?.link ? absState(s.abs.link, s.abs.live) : null
  const readAloudIssue =
    s.readAlong !== null && (s.audiobook !== null || s.ebook !== null) && s.readAloud.sync.state === 'unavailable' && !copiesOnlyWithoutAudio(s)
  if (align === 'alignmentFailed') return 1
  if (align === 'outOfDate' || readAloudIssue || abs === 'absUnreachable' || abs === 'absDiverged') return 2
  if (align === 'aligning' || align === 'rebuilding') return 3
  return null
}

function copiesOnlyWithoutAudio(s: SyncChainSnapshot): boolean {
  return s.audiobook === null && syncsEpubCopiesOnly(s)
}

function countInSync(s: SyncChainSnapshot): number {
  const align = usesWhisper(s) ? alignmentState(s.alignment) : null
  const pair = align === 'ready'
  const readAloudAudio = hasReadAloudPair(s) && s.readAloud.sync.state === 'enabled'
  const copies = s.ebook !== null && s.readAlong !== null && (s.readAloud.sync.state === 'enabled' || syncsEpubCopiesOnly(s))
  const abs = absIsCard(s)
  const ebook = pair || copies
  const audiobook = pair || readAloudAudio || abs
  const readAlong = readAloudAudio || copies
  return [ebook, audiobook, readAlong, abs].filter(Boolean).length
}

export function buildSyncChain(input: SyncChainSnapshot): SyncChain {
  const snapshot = input.abs && (!input.abs.configured || !input.audiobook) ? { ...input, abs: null } : input
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
          ? { tone: 'info', label: chainMsg('header.aligning') }
          : inSync >= 2
            ? { tone: 'success', label: chainMsg('header.inSync', { n: inSync, m: present }) }
            : { tone: 'muted', label: chainMsg('header.notSyncing') }

  return {
    rows,
    header,
    intro: chainMsg(inSync >= 2 ? 'intro.synced' : 'intro.notSynced'),
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
      return MODIFY_CARD_HEIGHT
    case 'ghost':
      return MODIFY_GHOST_HEIGHT
    case 'readAloudSlot':
      return MODIFY_GHOST_HEIGHT + (row.progress ? MODIFY_SLOT_STEPPER_HEIGHT : 0)
    case 'connector':
      return (
        (row.frame === 'group' ? MODIFY_INNER_CONNECTOR_HEIGHT : MODIFY_CONNECTOR_HEIGHT) +
        (hasNoteLine(row) ? MODIFY_CONNECTOR_NOTE_HEIGHT : 0) +
        (row.actions.length > 0 ? MODIFY_CONNECTOR_ACTIONS_HEIGHT : 0) +
        (row.ticks ? MODIFY_CONNECTOR_TICKS_HEIGHT : 0)
      )
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
