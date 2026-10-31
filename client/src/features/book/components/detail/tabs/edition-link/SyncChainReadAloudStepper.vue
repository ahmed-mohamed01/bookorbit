<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatPercent } from '@/i18n/formatters'
import { READ_ALOUD_STEPS, stepIndexOf } from '@/features/read-aloud/lib/read-aloud'

type StepState = 'done' | 'current' | 'todo'

const props = defineProps<{ stage: string; percent: number | null }>()

const { t } = useI18n()

const SEGMENT_CLASS: Record<StepState, string> = {
  done: 'bg-success',
  current: 'animate-pulse bg-info motion-reduce:animate-none',
  todo: 'bg-muted',
}
const DOT_CLASS: Record<StepState, string> = {
  done: 'bg-success',
  current: 'bg-info',
  todo: 'bg-border',
}
const LABEL_CLASS: Record<StepState, string> = {
  done: 'text-muted-foreground',
  current: 'font-semibold text-foreground',
  todo: 'text-muted-foreground',
}

const steps = computed(() => {
  const current = stepIndexOf(props.stage)
  return READ_ALOUD_STEPS.map((step, index) => {
    const state: StepState = current < 0 || index > current ? 'todo' : index < current ? 'done' : 'current'
    return { key: step.key, label: t(`book.detail.files.readAloud.steps.${step.key}`), state }
  })
})

const percentLabel = computed(() => (props.percent === null ? null : formatPercent(props.percent / 100)))
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="read-aloud-stepper">
    <div class="flex items-center gap-2">
      <div
        class="flex min-w-0 flex-1 gap-[3px]"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent ?? undefined"
        :aria-label="t('book.detail.files.readAloud.job.progress')"
      >
        <div
          v-for="step in steps"
          :key="step.key"
          class="h-1 flex-1 rounded-sm"
          :class="SEGMENT_CLASS[step.state]"
          data-testid="read-aloud-step-segment"
        />
      </div>
      <span
        v-if="percentLabel !== null"
        class="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground"
        data-testid="read-aloud-percent"
      >
        {{ percentLabel }}
      </span>
    </div>
    <ol class="flex flex-wrap gap-x-2 gap-y-1">
      <li
        v-for="step in steps"
        :key="step.key"
        class="flex items-center gap-1.5 text-[11px]"
        :class="LABEL_CLASS[step.state]"
        :data-stage-state="step.state"
        :aria-current="step.state === 'current' ? 'step' : undefined"
        data-testid="read-aloud-stage"
      >
        <span class="size-1.5 shrink-0 rounded-full" :class="DOT_CLASS[step.state]" aria-hidden="true" />
        {{ step.label }}
      </li>
    </ol>
  </div>
</template>
