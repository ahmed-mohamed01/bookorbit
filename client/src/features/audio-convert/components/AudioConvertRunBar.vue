<script setup lang="ts">
// Fork: Convert to M4B. Non-blocking progress bar across the top of the tool while jobs run.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Clock, Loader2, Square, X, XCircle } from '@lucide/vue'
import type { AudioConvertJob } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { stageKey } from '../lib/audio-convert'

const props = defineProps<{
  jobs: AudioConvertJob[]
  stopping: boolean
  /** Saved backup window, or `null` when the viewer cannot read settings. */
  backupDays: number | null
}>()

const emit = defineEmits<{ stop: []; dismiss: [] }>()

const { t } = useI18n()

const current = computed(() => props.jobs.find((job) => job.status === 'running') ?? null)
const queued = computed(() => props.jobs.filter((job) => job.status === 'queued').length)
const inFlight = computed(() => current.value !== null || queued.value > 0)
const succeeded = computed(() => props.jobs.filter((job) => job.status === 'success').length)
const failed = computed(() => props.jobs.filter((job) => job.status === 'failed').length)

/** 1-based position of the running book among the jobs on the bar. */
const position = computed(() => {
  const index = current.value ? props.jobs.indexOf(current.value) : props.jobs.findIndex((job) => job.status === 'queued')
  return index < 0 ? props.jobs.length : index + 1
})

const title = computed(() =>
  inFlight.value
    ? t('audioConvert.run.converting', { index: position.value, total: props.jobs.length })
    : t('audioConvert.run.done', { done: succeeded.value, total: props.jobs.length }),
)

const detail = computed(() => {
  const job = current.value
  if (job) {
    const parts = [job.title, t(stageKey(job.stage))]
    if (job.progress != null) parts.push(`${Math.round(job.progress)}%`)
    return parts.join(' · ')
  }
  if (inFlight.value) return t('audioConvert.run.starting')
  const notes: string[] = []
  if (failed.value) notes.push(t('audioConvert.run.failed', { count: failed.value }))
  if (succeeded.value) {
    if (props.backupDays === null) notes.push(t('audioConvert.run.backupsUnknown'))
    else if (props.backupDays > 0) notes.push(t('audioConvert.run.backups', { days: props.backupDays }))
  }
  return notes.join(' · ')
})

/** Finished books count whole; the running one counts its share. */
const percent = computed(() => {
  if (props.jobs.length === 0) return 0
  const finished = props.jobs.filter((job) => job.status !== 'queued' && job.status !== 'running').length
  const partial = current.value?.progress != null ? current.value.progress / 100 : 0
  return Math.min(100, Math.round(((finished + partial) / props.jobs.length) * 100))
})

function iconFor(job: AudioConvertJob) {
  if (job.status === 'success') return Check
  if (job.status === 'running') return Loader2
  if (job.status === 'failed') return XCircle
  if (job.status === 'cancelled' || job.status === 'skipped') return X
  return Clock
}

function handleStop(): void {
  emit('stop')
}

function handleDismiss(): void {
  emit('dismiss')
}
</script>

<template>
  <div class="flex-none border-b border-border bg-muted/40 px-5 py-2.5" role="status" data-testid="audio-convert-run-bar">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span class="font-semibold tabular-nums">{{ title }}</span>
      <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ detail }}</span>
      <Button v-if="inFlight" variant="outline" size="sm" :disabled="stopping || queued === 0" @click="handleStop">
        <Loader2 v-if="stopping" class="size-3.5 animate-spin" aria-hidden="true" />
        <Square v-else class="size-3.5" aria-hidden="true" />
        {{ t('audioConvert.run.stop') }}
      </Button>
      <Button v-else variant="ghost" size="sm" @click="handleDismiss">
        <X class="size-3.5" aria-hidden="true" />
        {{ t('audioConvert.run.dismiss') }}
      </Button>
    </div>
    <div
      class="mt-2 h-1 overflow-hidden rounded-xs bg-border"
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="title"
    >
      <div
        class="h-full transition-[width] duration-300"
        :class="inFlight ? 'bg-primary' : failed ? 'bg-warning' : 'bg-success'"
        :style="{ width: `${percent}%` }"
      />
    </div>
    <ul class="mt-2 flex max-h-14 flex-wrap gap-x-3.5 gap-y-1 overflow-y-auto text-xs">
      <li
        v-for="job in jobs"
        :key="job.id"
        class="inline-flex max-w-56 items-center gap-1"
        :class="{
          'text-muted-foreground': job.status === 'queued' || job.status === 'cancelled' || job.status === 'skipped',
          'text-destructive': job.status === 'failed',
        }"
      >
        <component
          :is="iconFor(job)"
          class="size-3 shrink-0"
          :class="{ 'animate-spin': job.status === 'running', 'text-success': job.status === 'success' }"
          aria-hidden="true"
        />
        <span class="truncate">{{ job.title }}</span>
      </li>
    </ul>
  </div>
</template>
