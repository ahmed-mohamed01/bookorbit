<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Clock, Loader2, Play, RefreshCw } from '@lucide/vue'
import type { EditionSyncBookState } from '@bookorbit/types'
import { formatPercent } from '@/i18n/formatters'
import { stageLabelKey } from '@/features/read-aloud/lib/read-aloud'
import { describeNextRun } from '../lib/next-run'

const props = defineProps<{ state: EditionSyncBookState; busy?: boolean }>()
const emit = defineEmits<{ run: []; retry: [] }>()

const { t } = useI18n()

const KEY = 'editionSync.status.'

type RowKind = 'queued' | 'running' | 'failed' | 'stale'
type RowAction = 'run' | 'retry'

const kind = computed<RowKind | null>(() => {
  if (!props.state.syncEnabled) return null
  switch (props.state.index.status) {
    case 'queued':
    case 'running':
    case 'failed':
    case 'stale':
      return props.state.index.status
    default:
      return null
  }
})

const startingSoon = computed(() => props.state.pinned || props.state.runActive)

const when = computed(() => {
  if (startingSoon.value) return t(`${KEY}startingSoon`)
  const iso = props.state.index.nextRunAt
  if (!iso) return null
  const label = describeNextRun(iso)
  return label.day === 'later' ? t(`${KEY}when.later`, { date: label.date, time: label.time }) : t(`${KEY}when.${label.day}`, { time: label.time })
})

const text = computed(() => {
  const index = props.state.index
  switch (kind.value) {
    case 'queued': {
      const head = index.queuePosition === null ? t(`${KEY}queued`) : t(`${KEY}queuedAt`, { position: index.queuePosition })
      return when.value ? `${head} · ${when.value}` : head
    }
    case 'running': {
      const stage = t(stageLabelKey(index.stage))
      return index.progress === null ? stage : `${stage} · ${formatPercent(Math.min(Math.max(index.progress, 0), 100) / 100)}`
    }
    case 'failed':
      return index.whisperFallback ? t(`${KEY}failedFallback`) : t(`${KEY}failed`)
    case 'stale':
      return t(`${KEY}stale`)
    default:
      return ''
  }
})

const announcement = computed(() => (kind.value === 'running' ? t(stageLabelKey(props.state.index.stage)) : text.value))

const tooltip = computed(() => {
  const detail = kind.value === 'failed' ? props.state.index.error : null
  return detail ? `${text.value}: ${detail}` : text.value
})

const action = computed<RowAction | null>(() => {
  if (kind.value === 'failed') return props.state.canRetry ? 'retry' : null
  if (kind.value === 'queued' || kind.value === 'stale') return props.state.canRunNow && !startingSoon.value ? 'run' : null
  return null
})

const actionLabel = computed(() => (action.value === 'retry' ? t(`${KEY}retry`) : t(`${KEY}runNow`)))

function handleAction() {
  if (action.value === 'retry') emit('retry')
  else if (action.value === 'run') emit('run')
}
</script>

<template>
  <div
    v-if="kind"
    class="mt-2.5 flex min-w-0 items-center gap-2 text-[11px]"
    :class="kind === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
  >
    <Loader2 v-if="kind === 'running'" class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    <AlertTriangle v-else-if="kind === 'failed'" class="size-3.5 shrink-0" aria-hidden="true" />
    <Clock v-else class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate" :title="tooltip">{{ text }}</span>
    <span class="sr-only" role="status">{{ announcement }}</span>
    <button
      v-if="action"
      type="button"
      class="inline-flex size-6.5 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="actionLabel"
      :title="actionLabel"
      :disabled="busy"
      @click="handleAction"
    >
      <RefreshCw v-if="action === 'retry'" class="size-3.5" aria-hidden="true" />
      <Play v-else class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
