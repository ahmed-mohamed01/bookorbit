import { computed, ref, watch } from 'vue'
import { i18n } from '@/i18n'
import { useMediaOverlay } from './useMediaOverlay'
import { useNarrationChapters } from './useNarrationChapters'

export const SLEEP_OFF = 'off'
export const SLEEP_END_OF_CHAPTER = 'chapter'

export interface NarrationSleepOption {
  value: string
  label: string
}

const sleepAtChapterEnd = ref(false)
// Every narration restart (a picked chapter, "Narrate from here") passes through a cleared
// fragment, so the chapter it lands in is not narration running past a chapter end.
let restartPending = false

// Called once by the always-mounted dock so the pause and the timer carry-over still happen
// while the full player is collapsed.
export function installNarrationSleepWatchers() {
  const { currentFragment, isActive, pause, sleepTimer } = useMediaOverlay()
  const { currentIndex } = useNarrationChapters()

  watch(
    isActive,
    (active, wasActive) => {
      if (active && !wasActive) restartPending = true
    },
    { flush: 'sync' },
  )
  watch(
    currentFragment,
    (fragment) => {
      if (fragment === null && isActive.value) restartPending = true
    },
    { flush: 'sync' },
  )

  watch(currentIndex, (next, previous) => {
    if (next < 0) return
    if (restartPending) {
      restartPending = false
      return
    }
    if (!sleepAtChapterEnd.value || previous === next) return
    sleepAtChapterEnd.value = false
    pause()
  })
  // Registered after the chapter watcher so a restart landing in the chapter it left, which
  // never changes the index, still ends the pending restart once the first sentence plays.
  watch(currentFragment, (fragment) => {
    if (fragment !== null) restartPending = false
  })

  watch(isActive, (active) => {
    if (!active) sleepAtChapterEnd.value = false
  })

  // A restart's stop cancels the sleep timer. A restart stops and starts in one synchronous run,
  // so a timer cancelled while narration is inactive is held until the end of that run and
  // handed back if narration came straight back; a real stop leaves it cancelled.
  let held: { minutes: number; remaining: number } | null = null
  watch(
    sleepTimer.activeMinutes,
    (minutes, previous) => {
      // cancelTimer clears the minutes first, so the seconds left are still readable here.
      const remaining = sleepTimer.remainingSeconds.value
      if (minutes !== null || previous === null || isActive.value || held) return
      held = { minutes: previous, remaining: remaining ?? previous * 60 }
      queueMicrotask(() => {
        held = null
      })
    },
    { flush: 'sync' },
  )
  watch(
    isActive,
    (active) => {
      if (!active || !held) return
      const { minutes, remaining } = held
      held = null
      sleepTimer.startTimer(minutes)
      sleepTimer.remainingSeconds.value = remaining
    },
    { flush: 'sync' },
  )
}

export function useNarrationSleep() {
  const { sleepTimer } = useMediaOverlay()
  const { chapters } = useNarrationChapters()
  const t = i18n.global.t

  const mode = computed(() => {
    if (sleepAtChapterEnd.value) return SLEEP_END_OF_CHAPTER
    const minutes = sleepTimer.activeMinutes.value
    return minutes === null ? SLEEP_OFF : String(minutes)
  })
  const isActive = computed(() => mode.value !== SLEEP_OFF)
  const minutesLeft = computed(() => {
    const remaining = sleepTimer.remainingSeconds.value
    return remaining === null ? null : Math.ceil(remaining / 60)
  })
  const label = computed(() => {
    if (sleepAtChapterEnd.value) return t('reader.narration.endOfChapter')
    return minutesLeft.value === null ? t('reader.narration.sleep') : t('reader.narration.sleepRemaining', { count: minutesLeft.value })
  })
  const badge = computed(() => {
    if (sleepAtChapterEnd.value) return t('reader.narration.sleepChapterBadge')
    return minutesLeft.value === null ? null : t('reader.narration.sleepRemainingShort', { count: minutesLeft.value })
  })
  const options = computed<NarrationSleepOption[]>(() => [
    { value: SLEEP_OFF, label: t('reader.narration.sleepOff') },
    ...sleepTimer.presets.map((minutes) => ({ value: String(minutes), label: t('reader.narration.sleepMinutes', { count: minutes }) })),
    ...(chapters.value.length > 0 ? [{ value: SLEEP_END_OF_CHAPTER, label: t('reader.narration.endOfChapter') }] : []),
  ])

  function select(value: string) {
    sleepTimer.cancelTimer()
    sleepAtChapterEnd.value = value === SLEEP_END_OF_CHAPTER
    if (value !== SLEEP_OFF && value !== SLEEP_END_OF_CHAPTER) sleepTimer.startTimer(Number(value))
  }

  return { mode, label, badge, isActive, options, select }
}
