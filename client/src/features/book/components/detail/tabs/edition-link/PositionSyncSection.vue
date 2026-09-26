<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, BookOpen, Headphones, Loader2, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/i18n/formatters'
import type { AlignmentBuildBlockReason, AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import type { EditionFormat } from '@/features/book/composables/useLinkEditionPanel'
import { isTerminalBlock, needsForce } from '@/features/book/lib/position-sync'

const MAX_TICKS = 40

const props = withDefaults(
  defineProps<{
    status: AlignmentStatus
    samplesDone: number | null
    samplesTotal: number | null
    builtAt: string | null
    buildBlocked: AlignmentBuildBlockReason | null
    mutating: boolean
    canBuild: boolean
    counterpartModality: EditionFormat | null
    counterpartTitle?: string | null
  }>(),
  { counterpartTitle: null },
)

const emit = defineEmits<{ build: [force: boolean] }>()

const { t } = useI18n()

const running = computed(() => props.status === 'pending' || props.status === 'building')

const tag = computed(() => {
  if (running.value) return { key: 'book.detail.readingAlignment.tag.building', class: 'bg-info/15 text-info' }
  switch (props.status) {
    case 'ready':
      return { key: 'book.detail.readingAlignment.tag.ready', class: 'bg-success/15 text-success' }
    case 'failed':
      return { key: 'book.detail.readingAlignment.tag.failed', class: 'bg-destructive/15 text-destructive' }
    case 'unalignable':
      return { key: 'book.detail.readingAlignment.tag.unalignable', class: 'bg-muted text-muted-foreground' }
    default:
      return { key: 'book.detail.readingAlignment.tag.none', class: 'bg-muted text-muted-foreground' }
  }
})

const showBuildButton = computed(() => props.canBuild && !running.value && !isTerminalBlock(props.buildBlocked))
const isRebuild = computed(() => props.status !== 'none')

const tickStrip = computed(() => {
  const total = props.samplesTotal
  if (typeof total !== 'number' || total <= 0) return null
  const count = Math.min(MAX_TICKS, total)
  const done = Math.min(total, Math.max(0, props.samplesDone ?? 0))
  const doneTicks = Math.floor((done / total) * count)
  const ticks = Array.from({ length: count }, (_, index) => {
    if (index < doneTicks) return 'bg-info'
    if (index === doneTicks) return 'animate-pulse bg-info/50'
    return 'bg-muted'
  })
  // With every sample done (a resumed, already complete alignment, or the final map-building pass) or
  // no count yet, there is no current tick to pulse, so the whole strip pulses to show work continues.
  return { ticks, pulsing: props.samplesDone === null || doneTicks >= count }
})

const progressPercent = computed(() => {
  const total = props.samplesTotal
  if (typeof total !== 'number' || total <= 0) return undefined
  return Math.round((Math.max(0, Math.min(total, props.samplesDone ?? 0)) / total) * 100)
})

const builtAtLabel = computed(() => {
  if (!props.builtAt) return null
  const parsed = new Date(props.builtAt)
  if (Number.isNaN(parsed.getTime())) return null
  return t('book.detail.readingAlignment.builtAt', { date: formatDate(parsed, { year: 'numeric', month: 'short', day: 'numeric' }) })
})

// Both editions usually share a title, so the line names the counterpart's format and adds the title
// only where no pair box already shows it.
const inSyncLabel = computed(() => {
  if (!props.counterpartModality) return null
  const type =
    props.counterpartModality === 'audiobook'
      ? t('book.detail.readingAlignment.counterpartType.audiobook')
      : t('book.detail.readingAlignment.counterpartType.ebook')
  return props.counterpartTitle
    ? t('book.detail.readingAlignment.inSyncWithTypeTitled', { type, title: props.counterpartTitle })
    : t('book.detail.readingAlignment.inSyncWithType', { type })
})

const blockMessage = computed(() => {
  switch (props.buildBlocked) {
    case 'disabled':
      return t('book.detail.readingAlignment.buildBlocked.disabled')
    case 'unavailable':
      return t('book.detail.readingAlignment.buildBlocked.unavailable')
    case 'busy':
      return t('book.detail.readingAlignment.buildBlocked.busy')
    default:
      return null
  }
})

function handleBuild() {
  emit('build', needsForce(props.status))
}
</script>

<template>
  <section class="mt-2.5 rounded-xl border border-border bg-background p-3" data-testid="position-sync">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Activity class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h3 class="text-sm font-semibold text-foreground">{{ t('book.detail.readingAlignment.title') }}</h3>
      <span class="ms-auto rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap" :class="tag.class" data-testid="position-sync-tag">
        {{ t(tag.key) }}
      </span>
      <Button
        v-if="showBuildButton"
        variant="ghost"
        size="sm"
        class="h-8 px-2 text-xs"
        :disabled="mutating"
        data-testid="position-sync-build"
        @click="handleBuild"
      >
        <Loader2 v-if="mutating" class="size-3.5 animate-spin" aria-hidden="true" />
        <RefreshCw v-else-if="isRebuild" class="size-3.5" aria-hidden="true" />
        {{ isRebuild ? t('book.detail.readingAlignment.rebuildButton') : t('book.detail.readingAlignment.buildButton') }}
      </Button>
    </div>

    <template v-if="running">
      <div
        v-if="tickStrip"
        class="mt-2.5 flex gap-0.5"
        :class="{ 'animate-pulse': tickStrip.pulsing }"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progressPercent"
        :aria-label="t('book.detail.readingAlignment.progressLabel')"
        data-testid="position-sync-ticks"
      >
        <div
          v-for="(tickClass, index) in tickStrip.ticks"
          :key="index"
          class="h-3.5 flex-1 rounded-[2px] transition-colors duration-500"
          :class="tickClass"
          data-testid="position-sync-tick"
        />
      </div>
      <div
        v-else
        class="mt-2.5 h-1.5 w-full animate-pulse rounded-full bg-info/40"
        role="progressbar"
        :aria-label="t('book.detail.readingAlignment.progressLabel')"
        data-testid="position-sync-indeterminate"
      />
    </template>
    <div v-else-if="status === 'ready'" class="mt-1.5 space-y-0.5 text-xs text-muted-foreground" data-testid="position-sync-done">
      <p v-if="builtAtLabel">{{ builtAtLabel }}</p>
      <p v-if="inSyncLabel" class="flex items-center gap-1.5" data-testid="position-sync-in-sync">
        <Headphones v-if="counterpartModality === 'audiobook'" class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <BookOpen v-else class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ inSyncLabel }}</span>
      </p>
    </div>
    <p v-else-if="status === 'failed'" class="mt-1.5 text-xs text-muted-foreground" data-testid="position-sync-failed">
      {{ t('book.detail.readingAlignment.failedHint') }}
    </p>
    <p v-else-if="status === 'unalignable'" class="mt-1.5 text-xs text-muted-foreground" data-testid="position-sync-unalignable">
      {{ t('book.detail.readingAlignment.unalignableHint') }}
    </p>
    <p v-else class="mt-1.5 text-xs text-pretty text-muted-foreground" data-testid="position-sync-idle">
      {{ t('book.detail.readingAlignment.idleHint') }}
    </p>

    <p v-if="blockMessage" class="mt-1.5 text-xs text-muted-foreground" data-testid="position-sync-blocked">{{ blockMessage }}</p>
  </section>
</template>
