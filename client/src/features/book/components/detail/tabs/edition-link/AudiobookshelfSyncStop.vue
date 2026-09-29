<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownToLine, ExternalLink, Library, Link2, Loader2, TriangleAlert } from '@lucide/vue'
import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive } from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'

const props = defineProps<{
  link: AudiobookshelfBookSyncLink
  live: AudiobookshelfBookSyncLive | null
  checking: boolean
  merged: boolean
  connectorPlacement: string
  position: 'middle' | 'bottom'
}>()

const { t } = useI18n()

const twoWay = computed(() => props.link.direction === 'two_way')

const railClass = computed(() => {
  if (!props.merged) return 'opacity-0'
  return twoWay.value ? 'opacity-100 bg-success/40' : 'opacity-100 bg-warning/50'
})

const connectorClass = computed(() =>
  twoWay.value
    ? 'border-2 border-popover bg-success text-success-foreground ring-2 ring-success/25'
    : 'border-2 border-popover bg-warning text-warning-foreground ring-2 ring-warning/25',
)

const directionHint = computed(() => {
  if (props.link.direction === 'two_way') return t('book.detail.editionLink.abs.twoWay')
  return props.link.direction === 'from_abs' ? t('book.detail.editionLink.abs.fromAbs') : t('book.detail.editionLink.abs.toAbs')
})

const cardClass = computed(() => {
  if (!props.merged) return 'border-border bg-card px-2.5 py-2'
  return `border-transparent bg-transparent px-0 ${props.position === 'middle' ? 'py-2' : 'pt-2 pb-0.5'}`
})

const title = computed(() => props.link.title ?? t('book.detail.editionLink.unknownTitle'))
const coverSrc = computed(() => audiobookshelfCoverUrl(props.link.absLibraryItemId))
const coverFailed = ref(false)

watch(
  () => props.link.absLibraryItemId,
  () => {
    coverFailed.value = false
  },
)

function handleCoverError() {
  coverFailed.value = true
}
const settingsRoute = { name: 'settings-audiobookshelf' }
const status = computed(() => props.live?.status ?? null)
const showSettings = computed(() => !twoWay.value || status.value === 'unreachable')

const progress = computed(() => {
  const value = props.live?.progress?.percentage
  if (typeof value !== 'number') return null
  if (value <= 0) return 0
  if (props.live?.progress?.isFinished) return 100
  // Rounding alone would read 100% for an unfinished book at 99.5%.
  return Math.min(99, Math.max(1, Math.round(value)))
})

const statusHint = computed(() => {
  if (status.value === 'unreachable') return t('book.detail.editionLink.abs.status.unreachableHint')
  if (status.value === 'sending') return t('book.detail.editionLink.abs.status.sendingHint')
  if (status.value === 'receiving') return t('book.detail.editionLink.abs.status.receivingHint')
  return null
})

// Tooltips need a hover, so the connector and the status both open the same reasons inline for touch and
// keyboard users, and screen readers get them as the stop's description.
const idBase = `edition-abs-${useId()}`
const hintId = `${idBase}-hint`
const detailsId = `${idBase}-details`
const detailsOpen = ref(false)

function toggleDetails() {
  detailsOpen.value = !detailsOpen.value
}
</script>

<template>
  <div
    role="group"
    :aria-label="t('book.detail.editionLink.abs.label')"
    :aria-describedby="hintId"
    data-testid="edition-abs-stop"
    :data-direction="link.direction"
  >
    <p :id="hintId" class="sr-only" data-testid="edition-abs-hint">
      {{ directionHint }}<template v-if="statusHint"> {{ statusHint }}</template>
    </p>
    <div class="relative h-0">
      <div
        aria-hidden="true"
        class="pointer-events-none absolute -top-8 left-5 h-16 w-0.5 -translate-x-1/2 rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
        :class="railClass"
      />
      <div
        aria-hidden="true"
        class="pointer-events-none absolute top-0 right-0 left-9.5 h-px bg-border/60 transition-opacity duration-700"
        :class="merged ? 'opacity-100' : 'opacity-0'"
      />
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="absolute top-0 z-[2] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
            :class="[connectorPlacement, connectorClass]"
            :aria-label="directionHint"
            :aria-expanded="detailsOpen"
            :aria-controls="detailsId"
            data-testid="edition-connector-abs"
            @click="toggleDetails"
          >
            <Link2 class="size-3" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" class="max-w-64 text-xs">{{ directionHint }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="relative z-[1] rounded-xl border transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]" :class="cardClass">
      <div class="flex items-center gap-2.5">
        <div class="flex w-10 shrink-0 justify-center">
          <div class="size-10 shrink-0 overflow-hidden rounded bg-muted shadow-md" data-testid="edition-abs-cover">
            <img v-if="!coverFailed" :src="coverSrc" alt="" loading="lazy" class="size-full object-cover" @error="handleCoverError" />
            <div v-else class="flex size-full items-center justify-center text-muted-foreground" data-testid="edition-abs-cover-fallback">
              <Library class="size-4" aria-hidden="true" />
            </div>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <!-- The logo masks the row's text colour, so it reads as muted as the Lucide icons on the other rows in either theme. -->
            <span
              class="size-3.5 shrink-0 bg-current mask-[url(/assets/provider-icons/audiobookshelf.svg)] mask-contain mask-center mask-no-repeat"
              aria-hidden="true"
              data-testid="edition-abs-logo"
            />
            <span>{{ t('book.detail.editionLink.abs.label') }}</span>
            <a
              v-if="link.webUrl"
              :href="link.webUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground hover:text-foreground"
              data-testid="edition-abs-external"
            >
              <ExternalLink class="size-2.5" aria-hidden="true" />
              {{ t('book.detail.editionLink.abs.external') }}
              <span class="sr-only">{{ t('book.detail.editionLink.abs.opensNewTab') }}</span>
            </a>
            <RouterLink v-if="showSettings" :to="settingsRoute" class="ms-auto text-xs text-info hover:underline" data-testid="edition-abs-settings">
              {{ t('book.detail.editionLink.abs.settings') }}
            </RouterLink>
          </div>
          <p class="truncate text-sm leading-5 font-medium text-foreground">
            <a
              v-if="link.webUrl"
              :href="link.webUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:underline"
              data-testid="edition-abs-title"
            >
              {{ title }}
              <span class="sr-only">{{ t('book.detail.editionLink.abs.opensNewTab') }}</span>
            </a>
            <span v-else>{{ title }}</span>
          </p>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <p class="min-w-0 flex-1 truncate">
              <template v-if="link.libraryName">{{ t('book.detail.editionLink.abs.library', { name: link.libraryName }) }}</template>
            </p>
            <span
              v-if="checking"
              class="ms-auto h-1 w-10 shrink-0 animate-pulse rounded-sm bg-muted"
              :aria-label="t('book.detail.editionLink.abs.checking')"
              role="img"
              data-testid="edition-abs-checking"
            />
            <button
              v-else-if="statusHint"
              type="button"
              class="ms-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-[11px] whitespace-nowrap hover:underline"
              :class="status === 'unreachable' ? 'text-warning' : 'text-info'"
              :title="statusHint"
              :aria-expanded="detailsOpen"
              :aria-controls="detailsId"
              data-testid="edition-abs-status"
              :data-status="status"
              @click="toggleDetails"
            >
              <TriangleAlert v-if="status === 'unreachable'" class="size-3" aria-hidden="true" />
              <Loader2 v-else-if="status === 'sending'" class="size-3 animate-spin" aria-hidden="true" />
              <ArrowDownToLine v-else class="size-3" aria-hidden="true" />
              {{ t(`book.detail.editionLink.abs.status.${status}`) }}
            </button>
            <span v-else-if="live?.progress?.isFinished" class="ms-auto shrink-0 text-[11px] whitespace-nowrap" data-testid="edition-abs-finished">
              {{ t('book.detail.editionLink.abs.finished') }}
            </span>
            <span v-else-if="live && !progress" class="ms-auto shrink-0 text-[11px] whitespace-nowrap" data-testid="edition-abs-not-started">
              {{ t('book.detail.editionLink.notStarted') }}
            </span>
            <div
              v-else-if="progress"
              class="ms-auto flex shrink-0 items-center gap-1.5"
              :title="t('book.detail.editionLink.progressListened', { percentage: progress })"
              :aria-label="t('book.detail.editionLink.progressListened', { percentage: progress })"
              role="img"
              data-testid="edition-abs-progress"
            >
              <div class="h-1 w-10 overflow-hidden rounded-sm bg-muted">
                <div class="h-full rounded-sm bg-[var(--pill-media-audiobook)]" :style="{ width: `${progress}%` }" />
              </div>
              <span class="text-[11px] tabular-nums whitespace-nowrap" aria-hidden="true">{{ progress }}%</span>
            </div>
          </div>
          <div
            v-show="detailsOpen"
            :id="detailsId"
            class="mt-1 space-y-0.5 text-[11px] text-pretty text-muted-foreground"
            data-testid="edition-abs-details"
          >
            <p>{{ directionHint }}</p>
            <p v-if="statusHint">{{ statusHint }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
