<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, RotateCw, Headphones, ListOrdered, Moon, Pause, Play, RotateCcw, X } from '@lucide/vue'
import { EPUB_NARRATION_SPEED_MAX, EPUB_NARRATION_SPEED_MIN } from '@bookorbit/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import CoverFill from '@/features/book/components/CoverFill.vue'
import { useMediaOverlay } from '../composables/useMediaOverlay'
import { useNarrationChapters } from '../composables/useNarrationChapters'
import { useNarrationDockPosition } from '../composables/useNarrationDockPosition'
import { useNarrationSleep } from '../composables/useNarrationSleep'
import MediaOverlayDetachedChips from './MediaOverlayDetachedChips.vue'

const emit = defineEmits<{ minimise: [] }>()

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].filter((speed) => speed >= EPUB_NARRATION_SPEED_MIN && speed <= EPUB_NARRATION_SPEED_MAX)

const { t } = useI18n()
const { isPlaying, isDetached, rate, currentBook, error, toggle, nextSentence, prevSentence, setRate, stop } = useMediaOverlay()
const { chapters, currentIndex, currentChapter, playChapter } = useNarrationChapters()
const sleep = useNarrationSleep()
const { mode: sleepMode, badge: sleepBadge, isActive: isSleepActive, options: sleepOptions } = sleep

const positionClass = useNarrationDockPosition()

const speedLabel = computed(() => t('reader.narration.speedValue', { speed: rate.value }))
const sleepButtonLabel = computed(() =>
  isSleepActive.value ? t('reader.narration.sleepTimerWith', { value: sleep.label.value }) : t('reader.narration.sleepTimer'),
)
const isSpeedChanged = computed(() => rate.value !== 1)

function speedOptionLabel(speed: number) {
  return speed === 1 ? t('reader.narration.normalSpeed', { speed }) : t('reader.narration.speedValue', { speed })
}

function handleMinimise() {
  emit('minimise')
}

function handleStop() {
  stop()
}

// Long books have hundreds of entries, so the list opens on the chapter being narrated.
function handleChapterMenuOpen(open: boolean) {
  if (!open) return
  requestAnimationFrame(() => {
    document.querySelector('[data-narration-chapters] [data-state="checked"]')?.scrollIntoView({ block: 'center' })
  })
}

// Fires for the chapter already playing too, which restarts it from its first sentence.
function handleChapterSelect(index: number) {
  playChapter(index)
}

function handleSpeedSelect(value: unknown) {
  setRate(Number(value))
}

function handleSleepSelect(value: unknown) {
  sleep.select(String(value))
}
</script>

<template>
  <div class="fixed z-50 left-1/2 -translate-x-1/2 w-[min(380px,calc(100vw-16px))] transition-[bottom] duration-300" :class="positionClass">
    <div v-if="isDetached" class="mb-2 flex justify-center gap-2">
      <MediaOverlayDetachedChips side="back" />
      <MediaOverlayDetachedChips side="from-here" />
    </div>

    <section
      class="flex flex-col gap-4 rounded-[20px] border border-border bg-card px-4 pt-4 pb-4 shadow-2xl"
      :aria-label="t('reader.narration.playerLabel')"
    >
      <div class="flex items-center gap-3">
        <div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted shadow-lg">
          <CoverFill v-if="currentBook?.coverUrl" :src="currentBook.coverUrl" />
          <Headphones v-else class="h-8 w-8 text-muted-foreground" />
        </div>
        <div class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
          <div class="line-clamp-2 font-serif text-lg font-semibold leading-tight text-foreground">
            {{ currentBook?.title ?? t('reader.narration.fallbackTitle') }}
          </div>
          <div v-if="currentBook?.author" class="truncate text-sm text-muted-foreground max-w-full">{{ currentBook.author }}</div>
        </div>
        <div class="flex shrink-0 items-center gap-0.5 self-start">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
            data-narration-minimise
            :aria-label="t('reader.narration.minimise')"
            @click="handleMinimise"
          >
            <ChevronDown class="h-5 w-5" />
          </button>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
            :aria-label="t('reader.narration.stop')"
            @click="handleStop"
          >
            <X class="h-5 w-5" />
          </button>
        </div>
      </div>

      <DropdownMenu v-if="chapters.length > 0" @update:open="handleChapterMenuOpen">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="group flex min-h-8 w-full items-center gap-2 rounded-lg border border-transparent bg-muted px-2.5 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
            :aria-label="t('reader.narration.chapters')"
          >
            <ListOrdered class="h-3.5 w-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-left font-semibold">{{ currentChapter?.label ?? t('reader.narration.chapters') }}</span>
            <ChevronDown class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-narration-chapters
          side="top"
          align="start"
          :side-offset="8"
          class="max-h-[min(60vh,300px)] w-(--reka-dropdown-menu-trigger-width) z-[60] rounded-xl border-border bg-card p-1.5 shadow-xl"
        >
          <DropdownMenuRadioGroup :model-value="String(currentIndex)">
            <DropdownMenuRadioItem
              v-for="(chapter, index) in chapters"
              :key="index"
              :value="String(index)"
              class="min-h-8 rounded-lg data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold data-[state=checked]:text-primary"
              :style="{ paddingLeft: `${2 + chapter.depth * 0.75}rem` }"
              @select="handleChapterSelect(index)"
            >
              <template #indicator-icon><Check class="h-4 w-4" /></template>
              <span class="truncate">{{ chapter.label }}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div class="flex items-center justify-between px-1">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-full text-xs font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
              :class="isSpeedChanged ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'"
              :aria-label="t('reader.narration.playbackSpeed')"
            >
              {{ speedLabel }}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" :side-offset="8" class="w-[180px] z-[60] rounded-xl border-border bg-card p-1.5 shadow-xl">
            <DropdownMenuLabel class="text-xs font-semibold text-muted-foreground">{{ t('reader.narration.playbackSpeed') }}</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="String(rate)" @update:model-value="handleSpeedSelect">
              <DropdownMenuRadioItem
                v-for="speed in SPEEDS"
                :key="speed"
                :value="String(speed)"
                class="min-h-8 rounded-lg data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold data-[state=checked]:text-primary"
              >
                <template #indicator-icon><Check class="h-4 w-4" /></template>
                {{ speedOptionLabel(speed) }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
          :aria-label="t('reader.narration.previousSentence')"
          @click="prevSentence"
        >
          <RotateCcw class="h-6 w-6" :stroke-width="1.8" />
        </button>
        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          :aria-label="isPlaying ? t('reader.narration.pause') : t('reader.narration.play')"
          @click="toggle"
        >
          <Pause v-if="isPlaying" class="h-6 w-6" fill="currentColor" />
          <Play v-else class="h-6 w-6" fill="currentColor" />
        </button>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
          :aria-label="t('reader.narration.nextSentence')"
          @click="nextSentence"
        >
          <RotateCw class="h-6 w-6" :stroke-width="1.8" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="relative flex h-10 w-10 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
              :class="isSleepActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'"
              :aria-label="sleepButtonLabel"
            >
              <Moon class="h-5 w-5" />
              <span
                v-if="sleepBadge"
                class="absolute -bottom-0.5 left-1/2 -translate-x-1/2 rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground tabular-nums"
                >{{ sleepBadge }}</span
              >
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" :side-offset="8" class="w-[200px] z-[60] rounded-xl border-border bg-card p-1.5 shadow-xl">
            <DropdownMenuLabel class="text-xs font-semibold text-muted-foreground">{{ t('reader.narration.stopAfter') }}</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="sleepMode" @update:model-value="handleSleepSelect">
              <DropdownMenuRadioItem
                v-for="option in sleepOptions"
                :key="option.value"
                :value="option.value"
                class="min-h-8 rounded-lg data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold data-[state=checked]:text-primary"
              >
                <template #indicator-icon><Check class="h-4 w-4" /></template>
                {{ option.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div v-if="error" role="alert" class="text-center text-xs text-destructive">{{ error }}</div>
    </section>
  </div>
</template>
