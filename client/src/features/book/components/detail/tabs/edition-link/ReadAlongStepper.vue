<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { readAlongPercent, readAlongSteps, type ReadAlongStepState } from '@/features/book/lib/read-along-section'

const props = withDefaults(defineProps<{ stage: number; remoteProgress?: number | null; failed?: boolean }>(), {
  remoteProgress: null,
  failed: false,
})

const { t } = useI18n()

const SEGMENT_CLASS: Record<ReadAlongStepState, string> = {
  done: 'bg-success',
  current: 'animate-pulse bg-info',
  todo: 'bg-muted',
}
const DOT_CLASS: Record<ReadAlongStepState, string> = {
  done: 'bg-success',
  current: 'bg-info',
  todo: 'bg-border',
}
const LABEL_CLASS: Record<ReadAlongStepState, string> = {
  done: 'text-muted-foreground',
  current: 'font-semibold text-foreground',
  todo: 'text-muted-foreground',
}

const FAILED_SEGMENT_CLASS = 'bg-destructive'
const FAILED_DOT_CLASS = 'bg-destructive'
const FAILED_LABEL_CLASS = 'font-semibold text-destructive'

function segmentClass(state: ReadAlongStepState): string {
  return props.failed && state === 'current' ? FAILED_SEGMENT_CLASS : SEGMENT_CLASS[state]
}

function dotClass(state: ReadAlongStepState): string {
  return props.failed && state === 'current' ? FAILED_DOT_CLASS : DOT_CLASS[state]
}

function labelClass(state: ReadAlongStepState): string {
  return props.failed && state === 'current' ? FAILED_LABEL_CLASS : LABEL_CLASS[state]
}

const steps = computed(() => readAlongSteps(props.stage))
const percent = computed(() => readAlongPercent(props.stage, props.remoteProgress))
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="read-along-stepper">
    <div class="flex items-center gap-2">
      <div
        class="flex min-w-0 flex-1 gap-[3px]"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent ?? undefined"
        :aria-label="t('book.detail.editionLink.readAlong.progressLabel')"
      >
        <div
          v-for="step in steps"
          :key="step.stage"
          class="h-1 flex-1 rounded-sm"
          :class="segmentClass(step.state)"
          data-testid="read-along-step-segment"
        />
      </div>
      <span v-if="percent !== null" class="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground" data-testid="read-along-percent">
        {{ t('book.detail.editionLink.readAlong.percent', { percent }) }}
      </span>
    </div>
    <ol class="flex flex-wrap gap-x-2.5 gap-y-1">
      <li
        v-for="step in steps"
        :key="step.stage"
        class="flex items-center gap-1.5 text-[11px]"
        :class="labelClass(step.state)"
        :data-stage-state="step.state"
        data-testid="read-along-stage"
      >
        <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(step.state)" aria-hidden="true" />
        {{ t(step.key) }}
      </li>
    </ol>
  </div>
</template>
