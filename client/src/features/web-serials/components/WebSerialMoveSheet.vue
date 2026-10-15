<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, TriangleAlert } from '@lucide/vue'
import type { MoveWebSerialJobResult, WebSerialJob, WebSerialMoveCandidate } from '@bookorbit/types'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { formatNumber } from '@/i18n/formatters'
import { moveRadioChoice } from '../lib/radioKeys'
import { useWebSerialMove } from '../composables/useWebSerialMove'
import WebSerialCover from './WebSerialCover.vue'

const props = defineProps<{ job: WebSerialJob | null; open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  moved: [result: MoveWebSerialJobResult]
}>()

const { t } = useI18n()
const move = useWebSerialMove()
const { loading, moving, error, result, selectedKey, selected, isEmpty } = move

const subtitle = computed(() =>
  result.value ? t('webSerials.queue.move.subtitle', { count: result.value.remainingTotal }) : t('webSerials.queue.move.subtitleLoading'),
)
const failedSourcesLine = computed(() => {
  const failed = result.value?.failedSources ?? []
  if (failed.length === 0) return null
  return t('webSerials.queue.move.failedSources', { sources: failed.join(', ') })
})
const confirmLabel = computed(() =>
  moving.value ? t('webSerials.queue.move.moving') : t('webSerials.queue.move.confirm', { count: selected.value?.remainingAvailable ?? 0 }),
)
const showLoadError = computed(() => error.value !== null && result.value === null && !loading.value)

watch(
  () => [props.open, props.job?.id] as const,
  ([open]) => {
    if (open && props.job) void move.load(props.job)
    else move.reset()
  },
  { immediate: true },
)

function availability(candidate: WebSerialMoveCandidate): string {
  const missing = candidate.remainingTotal - candidate.remainingAvailable
  const counts = { available: formatNumber(candidate.remainingAvailable), total: formatNumber(candidate.remainingTotal) }
  return missing > 0 ? t('webSerials.queue.move.partial', { ...counts, missing: formatNumber(missing) }) : t('webSerials.queue.move.full', counts)
}

function isSelected(candidate: WebSerialMoveCandidate): boolean {
  return candidate.seriesKey === selectedKey.value
}

function handleOpenChange(value: boolean) {
  if (!value && moving.value) return
  emit('update:open', value)
}

function handleCancel() {
  emit('update:open', false)
}

function handleSelect(candidate: WebSerialMoveCandidate) {
  move.select(candidate.seriesKey)
}

function handleCandidateKeydown(event: KeyboardEvent) {
  moveRadioChoice(event)
}

function handleRetry() {
  if (props.job) void move.load(props.job)
}

async function handleConfirm() {
  const outcome = await move.confirm()
  if (outcome) emit('moved', outcome)
}
</script>

<template>
  <Sheet :open="props.open" @update:open="handleOpenChange">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-md">
      <header class="shrink-0 border-b border-border p-5 pt-10">
        <SheetTitle class="text-lg font-bold text-foreground">{{ t('webSerials.queue.move.title') }}</SheetTitle>
        <SheetDescription class="mt-0.5 text-sm text-muted-foreground">
          <span v-if="job" class="font-medium text-foreground">{{ job.title }}</span>
          <span v-if="job"> · </span>
          {{ subtitle }}
        </SheetDescription>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <div v-if="loading" aria-busy="true" class="space-y-3">
          <p class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="size-4 animate-spin" aria-hidden="true" />
            {{ t('webSerials.queue.move.searching') }}
          </p>
          <div v-for="index in 3" :key="index" class="flex gap-3 rounded-lg border border-border p-3" aria-hidden="true">
            <Skeleton class="h-[60px] w-10 shrink-0" />
            <div class="flex-1 space-y-2 pt-1">
              <Skeleton class="h-3 w-1/3" />
              <Skeleton class="h-4 w-3/4" />
              <Skeleton class="h-3 w-1/2" />
            </div>
          </div>
        </div>

        <EmptyState v-else-if="showLoadError" icon="TriangleAlert" :title="t('webSerials.queue.move.loadErrorTitle')" :hint="error ?? ''">
          <template #actions>
            <Button variant="outline" size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
          </template>
        </EmptyState>

        <template v-else-if="result">
          <EmptyState v-if="isEmpty" icon="SearchX" :title="t('webSerials.queue.move.emptyTitle')" :hint="t('webSerials.queue.move.emptyHint')" />
          <ul v-else role="radiogroup" :aria-label="t('webSerials.queue.move.title')" class="space-y-2" @keydown="handleCandidateKeydown">
            <li v-for="candidate in result.candidates" :key="candidate.seriesKey">
              <button
                type="button"
                role="radio"
                :aria-checked="isSelected(candidate)"
                :tabindex="isSelected(candidate) || !selected ? 0 : -1"
                :disabled="moving"
                class="flex w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
                :class="isSelected(candidate) ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/50'"
                @click="handleSelect(candidate)"
              >
                <WebSerialCover :src="candidate.coverUrl" :title="candidate.title" class="h-[60px] w-10" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center justify-between gap-2">
                    <span class="truncate text-xs font-medium text-muted-foreground">{{ candidate.sourceName }}</span>
                    <span
                      class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                      :class="
                        candidate.confidence === 'same_series'
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-border bg-muted text-muted-foreground'
                      "
                    >
                      {{ t(`webSerials.queue.move.confidence.${candidate.confidence}`) }}
                    </span>
                  </div>
                  <p class="mt-0.5 line-clamp-2 text-sm font-semibold text-foreground">{{ candidate.title }}</p>
                  <p class="mt-1 text-xs" :class="candidate.remainingAvailable < candidate.remainingTotal ? 'text-warning' : 'text-muted-foreground'">
                    {{ availability(candidate) }}
                  </p>
                </div>
              </button>
            </li>
          </ul>
          <p v-if="failedSourcesLine" class="mt-3 text-xs text-muted-foreground">{{ failedSourcesLine }}</p>
        </template>

        <p v-if="error && !showLoadError" role="alert" class="mt-3 flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {{ error }}
        </p>
      </div>

      <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
        <Button variant="outline" :disabled="moving" @click="handleCancel">{{ t('common.cancel') }}</Button>
        <Button :disabled="!selected || moving || loading" @click="handleConfirm">
          <Loader2 v-if="moving" class="size-4 animate-spin" aria-hidden="true" />
          {{ confirmLabel }}
        </Button>
      </footer>
    </SheetContent>
  </Sheet>
</template>
