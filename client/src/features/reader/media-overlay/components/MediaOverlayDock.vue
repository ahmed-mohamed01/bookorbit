<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { AudioLines, Pause, Play } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useMediaOverlay } from '../composables/useMediaOverlay'
import { installNarrationSleepWatchers } from '../composables/useNarrationSleep'
import { useNarrationDockPosition } from '../composables/useNarrationDockPosition'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'
import MediaOverlayDetachedChips from './MediaOverlayDetachedChips.vue'
import MediaOverlayFullPlayer from './MediaOverlayFullPlayer.vue'

const collapsed = ref(true)

const { t } = useI18n()
const { isActive, isPlaying, isDetached, error, toggle } = useMediaOverlay()
const { isReaderFooterVisible } = useTtsMiniPlayerUi()
installNarrationSleepWatchers()

const expandedRoot = ref<HTMLElement | null>(null)
const openButton = ref<HTMLButtonElement | null>(null)

const positionClass = useNarrationDockPosition()

// While the reader's toolbars are hidden the pill stays off the page so nothing covers the text;
// it comes back with the toolbars, and on its own when the reader has moved away from the narrated
// sentence or playback failed, since those need acting on.
const surface = computed(() => {
  if (!isActive.value) return null
  if (!collapsed.value) return 'full'
  return isReaderFooterVisible.value || isDetached.value || error.value ? 'pill' : null
})

watch(isActive, (active) => {
  if (active) collapsed.value = true
})

async function expand() {
  collapsed.value = false
  await nextTick()
  expandedRoot.value?.querySelector<HTMLElement>('[data-narration-minimise]')?.focus()
}

function collapse() {
  collapsed.value = true
}

// Only an explicit minimise hands focus back to the pill; a tap elsewhere keeps focus where it landed.
async function minimise() {
  collapse()
  await nextTick()
  openButton.value?.focus()
}

// Menus opened from the full player render in a portal outside it and are modal: while one is
// open the page stops taking pointer events, so a tap anywhere else lands on the root element and
// only closes the menu.
function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Element | null
  if (expandedRoot.value?.contains(target) || document.querySelector('[role="menu"]')) return
  collapse()
}

// Capture phase runs before the open menu's own Escape handler removes it, so Escape closes the
// menu first and the player only on the next press.
function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || document.querySelector('[role="menu"]')) return
  void minimise()
}

// Taps on the book page land inside the reader iframe and never reach this document. The reader
// relays each one as a `foliate-click` message; focus moving into a newly loaded chapter frame
// sends none, so a chapter change does not read as a tap outside.
function handleReaderMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.data?.type !== 'foliate-click') return
  collapse()
}

function addOutsideListeners() {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  document.addEventListener('keydown', handleDocumentKeydown, true)
  window.addEventListener('message', handleReaderMessage)
}

function removeOutsideListeners() {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  document.removeEventListener('keydown', handleDocumentKeydown, true)
  window.removeEventListener('message', handleReaderMessage)
}

watch(
  () => isActive.value && !collapsed.value,
  (listening) => {
    if (listening) addOutsideListeners()
    else removeOutsideListeners()
  },
)

onBeforeUnmount(removeOutsideListeners)

// Both surfaces are anchored at the bottom centre, so scaling each from that point while they
// cross-fade reads as the pill stretching into the player and the player shrinking back into the pill.
const PILL_SCALE = '0.25 0.15'
const PLAYER_SCALE = '2.5 2'
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

// The full player renders its own fixed element inside the wrapper; transforming the wrapper
// would make it the containing block for that element, so the animation targets the child.
function animationTarget(el: Element): HTMLElement | null {
  const target = (el as HTMLElement).dataset.dock === 'full' ? el.firstElementChild : el
  if (!(target instanceof HTMLElement) || typeof target.animate !== 'function') return null
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null
  target.style.transformOrigin = 'bottom center'
  return target
}

function runAnimation(el: Element, keyframes: Keyframe[], duration: number, done: () => void) {
  const target = animationTarget(el)
  if (!target) return done()
  target.animate(keyframes, { duration, easing: EASING }).finished.then(done, done)
}

function handleEnter(el: Element, done: () => void) {
  const from = (el as HTMLElement).dataset.dock === 'full' ? PILL_SCALE : '0.85'
  runAnimation(
    el,
    [
      { opacity: 0, scale: from },
      { opacity: 1, scale: '1' },
    ],
    280,
    done,
  )
}

function handleLeave(el: Element, done: () => void) {
  const to = (el as HTMLElement).dataset.dock === 'full' ? PILL_SCALE : PLAYER_SCALE
  runAnimation(
    el,
    [
      { opacity: 1, scale: '1' },
      { opacity: 0, scale: to },
    ],
    200,
    done,
  )
}
</script>

<template>
  <Transition :css="false" @enter="handleEnter" @leave="handleLeave">
    <div v-if="surface === 'full'" key="full" ref="expandedRoot" data-dock="full">
      <MediaOverlayFullPlayer @minimise="minimise" />
    </div>
    <div
      v-else-if="surface === 'pill'"
      key="pill"
      data-dock="pill"
      class="fixed z-50 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 transition-[bottom] duration-300"
      :class="positionClass"
    >
      <div class="flex items-center gap-2">
        <MediaOverlayDetachedChips side="back" />
        <div class="flex items-center gap-1 rounded-full border border-border bg-card p-1.5 shadow-2xl">
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
            :aria-label="isPlaying ? t('reader.narration.pause') : t('reader.narration.play')"
            @click="toggle"
          >
            <Pause v-if="isPlaying" class="h-4 w-4" />
            <Play v-else class="h-4 w-4" />
          </button>
          <button
            ref="openButton"
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
            :aria-label="t('reader.narration.openControls')"
            @click="expand"
          >
            <AudioLines class="h-4 w-4" :class="{ 'animate-pulse': isPlaying }" />
          </button>
        </div>
        <MediaOverlayDetachedChips side="from-here" />
      </div>
      <div
        v-if="error"
        role="alert"
        class="max-w-[min(320px,calc(100vw-16px))] truncate rounded-full border border-destructive/40 bg-card px-3 py-1 text-xs font-medium text-destructive shadow-lg"
      >
        {{ error }}
      </div>
    </div>
  </Transition>
</template>
