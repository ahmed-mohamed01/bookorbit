import { computed, ref } from 'vue'
import { EPUB_NARRATION_SPEED_MAX, EPUB_NARRATION_SPEED_MIN } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { registerAudioFocusOwner, requestAudioFocus } from '@/lib/audio-focus'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import { useTtsMediaSession } from '@/features/tts/composables/useTtsMediaSession'
import { useTtsSleepTimer } from '@/features/tts/composables/useTtsSleepTimer'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'
import { startMediaOverlayWithFallback } from '../lib/media-overlay-start'
import { clearSnapshot, readSnapshot, writeSnapshot, type NarrationPosition } from '../lib/narration-snapshot'
import { traceNarration } from '../lib/narration-trace'

const MIN_RATE = EPUB_NARRATION_SPEED_MIN
const MAX_RATE = EPUB_NARRATION_SPEED_MAX
const RATE_STEP = 0.25

const isActive = ref(false)
const isPlaying = ref(false)
const rate = ref(1.0)
const volume = ref(1.0)
const currentBook = ref<TtsCurrentBook | null>(null)
const error = ref<string | null>(null)
// The SMIL text fragment of the sentence currently being narrated, e.g.
// ".../chap02.xhtml#sentence14". Used to persist + resume the exact sentence.
const currentFragment = ref<string | null>(null)
// True once the reader has scrolled or paged away from the narrated sentence.
// While detached the view stays put and the mini player offers "Narrate from here".
const isDetached = ref(false)
// True while narration is waiting for audio to arrive over the network.
const isBuffering = ref(false)
const isWaitingForAudio = computed(() => isPlaying.value && isBuffering.value)

export interface MediaOverlayDetachedActions {
  // Restarts narration at the reader's current position.
  narrateFromHere: () => void | Promise<void>
  // Brings the view back to the sentence being narrated and re-attaches.
  returnToNarration: () => void | Promise<void>
}
const currentSectionIndex = ref<number | null>(null)
const isBackground = ref(false)
const isAwaitingPlay = ref(false)

// Supplied by the reader at hand-over: its progress writer stays usable after it unmounts, so
// background narration saves through the same path the reader would.
export interface MediaOverlayBackgroundSink {
  saveProgress: (fragment: string, sectionIndex: number) => void
  flush: () => void
  release: () => void
}

export interface MediaOverlayTakeover extends NarrationPosition {
  wasPlaying: boolean
  // False when there was no engine to stop: the state only came back from a page reload.
  hasEngine: boolean
}

export interface MediaOverlayStartOptions {
  trackingEnabled?: boolean
}

let instance: FoliateMediaOverlay | null = null
let detachedActions: MediaOverlayDetachedActions | null = null
let backgroundSink: MediaOverlayBackgroundSink | null = null
let highlightListener: ((e: Event) => void) | null = null
let errorListener: ((e: Event) => void) | null = null
let bufferingListener: ((e: Event) => void) | null = null
let traceListener: ((e: Event) => void) | null = null
let snapshotUserId: number | null = null
let trackingEnabled = true
// Bumped whenever a headless engine load starts or is abandoned, so a load that finishes late can tell.
let headlessLoadId = 0
let headlessLoading = false
// Set while a reloaded reader holds the paused narration: pressing play starts it in the reader.
let pendingReaderResume: (() => Promise<void>) | null = null
let readerResumeRunning = false

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : i18n.global.t('reader.narration.error')
}

function persistSnapshot(force = false) {
  if (!isActive.value || snapshotUserId === null) return
  const book = currentBook.value
  const fragment = currentFragment.value
  const sectionIndex = currentSectionIndex.value
  if (!book || !fragment || sectionIndex === null) return
  writeSnapshot({ userId: snapshotUserId, book, fragment, sectionIndex, rate: rate.value, trackingEnabled }, force)
}

const mediaSession = useTtsMediaSession()

function detachListeners() {
  if (instance) {
    if (highlightListener) instance.removeEventListener('highlight', highlightListener)
    if (errorListener) instance.removeEventListener('error', errorListener)
    if (bufferingListener) instance.removeEventListener('buffering', bufferingListener)
    if (traceListener) instance.removeEventListener('trace', traceListener)
  }
  highlightListener = null
  errorListener = null
  bufferingListener = null
  traceListener = null
}

function releaseSink() {
  const sink = backgroundSink
  backgroundSink = null
  sink?.flush()
  sink?.release()
}

function teardownEngine() {
  if (instance) {
    instance.stop()
    detachListeners()
  }
  instance = null
  releaseSink()
}

function abortHeadlessLoad() {
  headlessLoadId++
  headlessLoading = false
  isBuffering.value = false
  teardownEngine()
}

function pause() {
  if (headlessLoading) {
    // Audio may already be starting inside the engine, so a pause during the load drops the engine;
    // pressing play builds a fresh one at the saved sentence.
    abortHeadlessLoad()
    isPlaying.value = false
    mediaSession.setPlaybackState('paused')
    persistSnapshot(true)
    return
  }
  if (!instance) return
  instance.pause()
  isPlaying.value = false
  mediaSession.setPlaybackState('paused')
  backgroundSink?.flush()
  persistSnapshot(true)
}

function resumeReaderOrLoadEngine() {
  const resumeInReader = pendingReaderResume
  if (!resumeInReader) {
    void playRestored()
    return
  }
  if (readerResumeRunning) return
  readerResumeRunning = true
  void resumeInReader().finally(() => {
    readerResumeRunning = false
  })
}

function resume() {
  if (!instance) {
    resumeReaderOrLoadEngine()
    return
  }
  requestAudioFocus('media-overlay')
  instance.resume()
  isPlaying.value = true
  mediaSession.setPlaybackState('playing')
}

function stop() {
  headlessLoadId++
  headlessLoading = false
  teardownEngine()
  isBackground.value = false
  clearSnapshot()
  pendingReaderResume = null
  readerResumeRunning = false
  isAwaitingPlay.value = false
  detachedActions = null
  isActive.value = false
  isPlaying.value = false
  isDetached.value = false
  isBuffering.value = false
  trackingEnabled = true
  currentBook.value = null
  currentFragment.value = null
  currentSectionIndex.value = null
  error.value = null
  mediaSession.clearHandlers()
  mediaSession.setPlaybackState('none')
  sleepTimer.cancelTimer()
}

const sleepTimer = useTtsSleepTimer(() => {
  traceNarration('sleep-timer')
  pause()
})

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (isActive.value) traceNarration('visibility', { playing: isPlaying.value, buffering: isBuffering.value })
  })
}

registerAudioFocusOwner('media-overlay', () => {
  if (isPlaying.value) traceNarration('focus-lost')
  if (isPlaying.value) pause()
})

function nextSentence() {
  instance?.next()
}

function prevSentence() {
  instance?.prev()
}

function bindInstance(mo: FoliateMediaOverlay, book: TtsCurrentBook, actions?: MediaOverlayDetachedActions) {
  requestAudioFocus('media-overlay')
  pendingReaderResume = null
  isAwaitingPlay.value = false
  instance = mo
  detachedActions = actions ?? null
  currentBook.value = book
  isActive.value = true
  isPlaying.value = true
  error.value = null

  instance.setRate(rate.value)
  instance.setVolume(volume.value)

  highlightListener = (e: Event) => {
    isPlaying.value = true
    const text = (e as CustomEvent).detail?.text
    const section = (e as CustomEvent).detail?.sectionIndex
    currentSectionIndex.value = Number.isInteger(section) && section >= 0 ? section : null
    if (typeof text === 'string') currentFragment.value = text
    if (backgroundSink && typeof text === 'string' && currentSectionIndex.value !== null) {
      backgroundSink.saveProgress(text, currentSectionIndex.value)
    }
    persistSnapshot()
    mediaSession.setPlaybackState('playing')
  }
  errorListener = (e: Event) => {
    error.value = errorMessage((e as CustomEvent).detail)
  }
  bufferingListener = (e: Event) => {
    isBuffering.value = (e as CustomEvent).detail === true
  }
  instance.addEventListener('highlight', highlightListener)
  instance.addEventListener('error', errorListener)
  traceListener = (e: Event) => {
    const { event, ...detail } = (e as CustomEvent<{ event: string } & Record<string, unknown>>).detail
    traceNarration(event, detail)
  }
  instance.addEventListener('buffering', bufferingListener)
  instance.addEventListener('trace', traceListener)
  traceNarration('bind', { bookFileId: book.bookFileId, background: isBackground.value, headless: !!backgroundSink })

  registerMediaSession(book)
}

function registerMediaSession(book: TtsCurrentBook) {
  mediaSession.setMetadata(book)
  mediaSession.registerHandlers({
    play: () => {
      traceNarration('session.play')
      resume()
    },
    pause: () => {
      traceNarration('session.pause')
      pause()
    },
    previoustrack: prevSentence,
    nexttrack: nextSentence,
    stop: () => {
      traceNarration('session.stop')
      stop()
    },
  })
}

// Browsers block audio that starts without a user gesture, so a restored or reloaded session shows
// its pill paused and only starts once the user presses play.
function enterPausedState(book: TtsCurrentBook, position: NarrationPosition, background: boolean) {
  currentBook.value = book
  currentFragment.value = position.fragment
  currentSectionIndex.value = position.sectionIndex
  error.value = null
  isPlaying.value = false
  isBackground.value = background
  isActive.value = true
  registerMediaSession(book)
  mediaSession.setPlaybackState('paused')
}

function restoreBackground(userId: number) {
  snapshotUserId = userId
  if (isActive.value) return
  const snapshot = readSnapshot()
  if (!snapshot) return
  if (snapshot.userId !== userId) {
    clearSnapshot()
    return
  }
  rate.value = Math.min(MAX_RATE, Math.max(MIN_RATE, snapshot.rate))
  trackingEnabled = snapshot.trackingEnabled
  enterPausedState(snapshot.book, snapshot, true)
}

async function playRestored() {
  const book = currentBook.value
  const fragment = currentFragment.value
  const sectionIndex = currentSectionIndex.value
  if (instance || headlessLoading || !isBackground.value || !book || !fragment || sectionIndex === null) return

  const loadId = ++headlessLoadId
  headlessLoading = true
  isPlaying.value = true
  isBuffering.value = true
  error.value = null
  let sink: MediaOverlayBackgroundSink | null = null
  try {
    const { openHeadlessNarration } = await import('../lib/headless-narration')
    const headless = await openHeadlessNarration(book, playSection, trackingEnabled)
    sink = headless.sink
    if (loadId !== headlessLoadId) {
      sink.release()
      return
    }
    backgroundSink = sink
    bindInstance(headless.mediaOverlay, book)
    await startMediaOverlayWithFallback(
      headless.mediaOverlay,
      sectionIndex,
      (item) => item.text === fragment,
      () => loadId === headlessLoadId,
    )
    if (loadId === headlessLoadId) headlessLoading = false
  } catch (e) {
    if (loadId !== headlessLoadId) return
    headlessLoading = false
    const unbound = sink !== null && backgroundSink !== sink
    teardownEngine()
    if (unbound) sink?.release()
    isPlaying.value = false
    isBuffering.value = false
    error.value = errorMessage(e)
  }
}

function playSection(sectionIndex: number) {
  if (!instance) return
  requestAudioFocus('media-overlay')
  currentFragment.value = null
  isPlaying.value = true
  error.value = null
  mediaSession.setPlaybackState('playing')
  void instance.start(sectionIndex).catch((e: unknown) => {
    error.value = errorMessage(e)
  })
}

export function useMediaOverlay() {
  // `mo` is the foliate MediaOverlay instance (view.mediaOverlay) and `startFn` is
  // view.startMediaOverlay, both obtained from useFoliate in the reader. `actions` are offered by
  // the mini player once the user has scrolled away from the narrated sentence.
  function start<T>(
    mo: FoliateMediaOverlay,
    startFn: () => T,
    book: TtsCurrentBook,
    actions?: MediaOverlayDetachedActions,
    options: MediaOverlayStartOptions = {},
  ): T {
    stop()
    trackingEnabled = options.trackingEnabled ?? true
    bindInstance(mo, book, actions)
    return startFn()
  }

  function toggle() {
    if (!instance && !headlessLoading) {
      resumeReaderOrLoadEngine()
      return
    }
    if (isPlaying.value) pause()
    else resume()
  }

  function setRate(newRate: number) {
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, newRate))
    rate.value = clamped
    instance?.setRate(clamped)
    persistSnapshot(true)
  }

  function setVolume(newVolume: number) {
    const clamped = Math.min(1, Math.max(0, newVolume))
    volume.value = clamped
    instance?.setVolume(clamped)
  }

  function detach() {
    if (!isActive.value) return
    isDetached.value = true
  }

  function attach() {
    isDetached.value = false
  }

  function narrateFromHere() {
    if (!isActive.value || !detachedActions) return
    void detachedActions.narrateFromHere()
  }

  function returnToNarration() {
    if (!isActive.value || !detachedActions) return
    void detachedActions.returnToNarration()
  }

  // Keeps the running narration going once its reader closes. The reader-only actions go with
  // the reader, so nothing is left detached. `released` is the reader's own engine: it is only
  // kept when it is the one playing, otherwise it is stopped so no audio element outlives the view.
  function handOff(sink: MediaOverlayBackgroundSink, released: FoliateMediaOverlay): boolean {
    if (isActive.value && !instance && pendingReaderResume) {
      released.stop()
      sink.release()
      pendingReaderResume = null
      readerResumeRunning = false
      isAwaitingPlay.value = false
      detachedActions = null
      isDetached.value = false
      isBackground.value = true
      persistSnapshot(true)
      return true
    }
    if (!isActive.value || !instance) {
      released.stop()
      sink.release()
      return false
    }
    releaseSink()
    isBackground.value = true
    detachedActions = null
    isDetached.value = false
    backgroundSink = sink
    persistSnapshot(true)
    return true
  }

  // Reads where the background narration of this file is, without disturbing it: a reader that
  // goes away before it adopts the position must leave the narration playing.
  function takeOver(bookFileId: number): MediaOverlayTakeover | null {
    if (!isActive.value && snapshotUserId !== null) restoreBackground(snapshotUserId)
    if (!isBackground.value || currentBook.value?.bookFileId !== bookFileId) return null
    const fragment = currentFragment.value
    const sectionIndex = currentSectionIndex.value
    if (!fragment || sectionIndex === null) {
      stop()
      return null
    }
    const hasEngine = !!instance
    return { fragment, sectionIndex, hasEngine, wasPlaying: hasEngine && isPlaying.value }
  }

  // The reader now owns the narration of its file, so the background session ends.
  function stopBackground() {
    if (isBackground.value) stop()
  }

  // A reloaded reader shows the saved narration paused at its sentence. `resume` runs only when
  // the user presses play.
  function adoptPaused(book: TtsCurrentBook, position: NarrationPosition, resume: () => Promise<void>, options: MediaOverlayStartOptions = {}) {
    stopBackground()
    if (isActive.value) return
    trackingEnabled = options.trackingEnabled ?? true
    enterPausedState(book, position, false)
    pendingReaderResume = resume
    isAwaitingPlay.value = true
    persistSnapshot(true)
  }

  function increaseRate() {
    setRate(Math.round((rate.value + RATE_STEP) * 100) / 100)
  }

  function decreaseRate() {
    setRate(Math.round((rate.value - RATE_STEP) * 100) / 100)
  }

  return {
    isActive,
    isPlaying,
    rate,
    volume,
    currentBook,
    currentFragment,
    isDetached,
    isBuffering,
    isWaitingForAudio,
    currentSectionIndex,
    isBackground,
    isAwaitingPlay,
    error,
    sleepTimer,
    start,
    detach,
    attach,
    narrateFromHere,
    returnToNarration,
    toggle,
    pause,
    resume,
    stop,
    handOff,
    restoreBackground,
    takeOver,
    stopBackground,
    adoptPaused,
    playSection,
    nextSentence,
    prevSentence,
    setRate,
    setVolume,
    increaseRate,
    decreaseRate,
  }
}
