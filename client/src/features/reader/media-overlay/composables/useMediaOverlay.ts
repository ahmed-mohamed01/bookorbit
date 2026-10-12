import { computed, ref } from 'vue'
import { EPUB_NARRATION_SPEED_MAX, EPUB_NARRATION_SPEED_MIN } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { registerAudioFocusOwner, requestAudioFocus } from '@/lib/audio-focus'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import { useTtsMediaSession } from '@/features/tts/composables/useTtsMediaSession'
import { useTtsSleepTimer } from '@/features/tts/composables/useTtsSleepTimer'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'

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
// True once the reader that started narration has closed and handed it over, so it keeps
// playing while the rest of the app is browsed.
const isBackground = ref(false)

// Supplied by the reader at hand-over: its progress writer stays usable after it unmounts, so
// background narration saves through the same path the reader would.
export interface MediaOverlayBackgroundSink {
  saveProgress: (fragment: string, sectionIndex: number) => void
  flush: () => void
  release: () => void
}

export interface MediaOverlayTakeover {
  fragment: string
  sectionIndex: number
  wasPlaying: boolean
}

let instance: FoliateMediaOverlay | null = null
let detachedActions: MediaOverlayDetachedActions | null = null
let backgroundSink: MediaOverlayBackgroundSink | null = null
let highlightListener: ((e: Event) => void) | null = null
let errorListener: ((e: Event) => void) | null = null
let bufferingListener: ((e: Event) => void) | null = null

const mediaSession = useTtsMediaSession()

function detachListeners() {
  if (instance) {
    if (highlightListener) instance.removeEventListener('highlight', highlightListener)
    if (errorListener) instance.removeEventListener('error', errorListener)
    if (bufferingListener) instance.removeEventListener('buffering', bufferingListener)
  }
  highlightListener = null
  errorListener = null
  bufferingListener = null
}

function pause() {
  if (!instance) return
  instance.pause()
  isPlaying.value = false
  mediaSession.setPlaybackState('paused')
  backgroundSink?.flush()
}

function resume() {
  if (!instance) return
  requestAudioFocus('media-overlay')
  instance.resume()
  isPlaying.value = true
  mediaSession.setPlaybackState('playing')
}

function endBackground() {
  const sink = backgroundSink
  backgroundSink = null
  isBackground.value = false
  sink?.flush()
  sink?.release()
}

function stop() {
  if (instance) {
    instance.stop()
    detachListeners()
  }
  endBackground()
  instance = null
  detachedActions = null
  isActive.value = false
  isPlaying.value = false
  isDetached.value = false
  isBuffering.value = false
  currentBook.value = null
  currentFragment.value = null
  currentSectionIndex.value = null
  error.value = null
  mediaSession.clearHandlers()
  mediaSession.setPlaybackState('none')
  sleepTimer.cancelTimer()
}

const sleepTimer = useTtsSleepTimer(pause)

registerAudioFocusOwner('media-overlay', () => {
  if (isPlaying.value) pause()
})

export function useMediaOverlay() {
  function nextSentence() {
    instance?.next()
  }

  function prevSentence() {
    instance?.prev()
  }

  // `mo` is the foliate MediaOverlay instance (view.mediaOverlay) and `startFn`
  // is view.startMediaOverlay - both obtained from useFoliate in the reader.
  // `actions` are offered by the mini player once the user has scrolled away
  // from the narrated sentence.
  function start<T>(mo: FoliateMediaOverlay, startFn: () => T, book: TtsCurrentBook, actions?: MediaOverlayDetachedActions): T {
    stop()
    requestAudioFocus('media-overlay')
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
      mediaSession.setPlaybackState('playing')
    }
    errorListener = (e: Event) => {
      const detail = (e as CustomEvent).detail
      error.value = detail instanceof Error ? detail.message : i18n.global.t('reader.narration.error')
    }
    bufferingListener = (e: Event) => {
      isBuffering.value = (e as CustomEvent).detail === true
    }
    instance.addEventListener('highlight', highlightListener)
    instance.addEventListener('error', errorListener)
    instance.addEventListener('buffering', bufferingListener)

    mediaSession.setMetadata(book)
    mediaSession.registerHandlers({
      play: resume,
      pause,
      previoustrack: prevSentence,
      nexttrack: nextSentence,
      stop,
    })

    return startFn()
  }

  function toggle() {
    if (!instance) return
    if (isPlaying.value) pause()
    else resume()
  }

  function setRate(newRate: number) {
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, newRate))
    rate.value = clamped
    instance?.setRate(clamped)
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
  // the reader, so nothing is left detached.
  function handoff(sink: MediaOverlayBackgroundSink): boolean {
    if (!isActive.value || !instance) {
      sink.release()
      return false
    }
    endBackground()
    detachedActions = null
    isDetached.value = false
    backgroundSink = sink
    isBackground.value = true
    return true
  }

  // A reader opening the book that is narrating in the background takes narration back: the
  // background engine belongs to a view that no longer exists, so it is stopped and the reader
  // restarts from the returned sentence in its own view.
  function takeOver(bookFileId: number): MediaOverlayTakeover | null {
    if (!isBackground.value || currentBook.value?.bookFileId !== bookFileId) return null
    const fragment = currentFragment.value
    const sectionIndex = currentSectionIndex.value
    const wasPlaying = isPlaying.value
    stop()
    if (!fragment || sectionIndex === null) return null
    return { fragment, sectionIndex, wasPlaying }
  }

  // Plays a section from its first sentence; used by the chapter list while no reader is open.
  function playSection(sectionIndex: number) {
    if (!instance) return
    requestAudioFocus('media-overlay')
    currentFragment.value = null
    isPlaying.value = true
    error.value = null
    mediaSession.setPlaybackState('playing')
    void instance.start(sectionIndex).catch((e: unknown) => {
      error.value = e instanceof Error ? e.message : i18n.global.t('reader.narration.error')
    })
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
    handoff,
    takeOver,
    playSection,
    nextSentence,
    prevSentence,
    setRate,
    setVolume,
    increaseRate,
    decreaseRate,
  }
}
