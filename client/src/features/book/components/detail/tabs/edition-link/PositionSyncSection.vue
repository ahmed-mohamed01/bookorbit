<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, BookOpen, Headphones, Loader2, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { AlignmentBuildBlockReason, AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import type { EditionFormat } from '@/features/book/composables/useLinkEditionPanel'
import { usePositionSyncStatus } from '@/features/book/composables/usePositionSyncStatus'
import { needsForce } from '@/features/book/lib/position-sync'
import PositionSyncTicks from './PositionSyncTicks.vue'

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
    buildError?: string | null
  }>(),
  { counterpartTitle: null, buildError: null },
)

const emit = defineEmits<{ build: [force: boolean] }>()

const { t } = useI18n()

const { running, tag, showBuildButton, isRebuild, builtAtLabel, blockMessage } = usePositionSyncStatus(() => props)

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

function handleBuild() {
  emit('build', needsForce(props.status))
}
</script>

<template>
  <section class="mt-2 rounded-xl border border-border bg-card px-3 py-2.5" data-testid="position-sync">
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

    <PositionSyncTicks v-if="running" class="mt-2.5" :samples-done="samplesDone" :samples-total="samplesTotal" />
    <div v-else-if="status === 'ready'" class="mt-1.5 space-y-0.5 text-xs text-muted-foreground" data-testid="position-sync-done">
      <p v-if="builtAtLabel">{{ builtAtLabel }}</p>
      <p v-if="inSyncLabel" class="flex items-center gap-1.5" data-testid="position-sync-in-sync">
        <Headphones v-if="counterpartModality === 'audiobook'" class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <BookOpen v-else class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ inSyncLabel }}</span>
      </p>
    </div>
    <div v-else-if="status === 'failed'" class="mt-1.5 space-y-0.5" data-testid="position-sync-failed">
      <p class="text-xs text-muted-foreground">{{ t('book.detail.readingAlignment.failedHint') }}</p>
      <p v-if="buildError" class="text-xs break-words text-muted-foreground" data-testid="position-sync-build-error">{{ buildError }}</p>
    </div>
    <p v-else-if="status === 'unalignable'" class="mt-1.5 text-xs text-muted-foreground" data-testid="position-sync-unalignable">
      {{ t('book.detail.readingAlignment.unalignableHint') }}
    </p>
    <p v-else class="mt-1.5 text-xs text-pretty text-muted-foreground" data-testid="position-sync-idle">
      {{ t('book.detail.readingAlignment.idleHint') }}
    </p>

    <p v-if="blockMessage" class="mt-1.5 text-xs text-muted-foreground" data-testid="position-sync-blocked">{{ blockMessage }}</p>
  </section>
</template>
