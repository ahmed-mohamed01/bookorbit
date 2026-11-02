<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AlertCircle, Loader2, Play, Square } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { stageLabelKey } from '@/features/read-aloud/lib/read-aloud'
import { clampPercent } from '@/lib/sync-issue'
import { formatDate, formatNumber, formatPercent, formatRelativeFromNow } from '@/i18n/formatters'
import { injectEditionSyncAdmin } from '../composables/useEditionSyncAdmin'
import { describeNextRun } from '../lib/next-run'
import EditionSyncBookCover from './EditionSyncBookCover.vue'

const { t } = useI18n()
const { status, settings, loading, acting, error, runActive, runNow, stop } = injectEditionSyncAdmin()

const worker = computed(() => status.value?.worker ?? null)
const workerOk = computed(() => worker.value?.state === 'ok')
const serverOn = computed(() => settings.value?.enabled ?? status.value?.schedule.enabled ?? false)
const current = computed(() => status.value?.run.current ?? null)
const currentPercent = computed(() => clampPercent(current.value?.progress ?? null) ?? 0)

const workerText = computed(() => {
  if (!worker.value) return ''
  if (worker.value.state !== 'ok') return t(`editionSync.indexing.worker.${worker.value.state}`)
  return worker.value.version ? t('editionSync.indexing.worker.online', { version: worker.value.version }) : t('editionSync.indexing.worker.ok')
})

function whenText(iso: string): string {
  const label = describeNextRun(iso)
  return t(`editionSync.status.when.${label.day}`, { time: label.time, date: label.date })
}

const nextRunText = computed(() => {
  const iso = status.value?.schedule.nextRunAt
  return iso ? whenText(iso) : null
})

const runningMeta = computed(() => {
  if (!current.value) return ''
  const stage = t(stageLabelKey(current.value.stage))
  const startedAt = status.value?.run.startedAt
  if (!startedAt) return stage
  return t('editionSync.indexing.running', { stage, time: formatDate(new Date(startedAt), { hour: '2-digit', minute: '2-digit' }) })
})

type BodyState = 'serverOff' | 'running' | 'active' | 'paused' | 'idle'

const bodyState = computed<BodyState>(() => {
  if (!serverOn.value) return 'serverOff'
  if (current.value) return 'running'
  if (runActive.value) return 'active'
  if (!workerOk.value) return 'paused'
  return 'idle'
})

const idleText = computed(() =>
  nextRunText.value ? t('editionSync.indexing.idle', { when: nextRunText.value }) : t('editionSync.indexing.idleUnscheduled'),
)

const queueText = computed(() => {
  const backlog = status.value?.backlogEstimate
  if (!backlog) return '-'
  if (backlog.hoursAtRecentRate === null || backlog.books === 0) return t('editionSync.indexing.summary.queueBooks', { count: backlog.books })
  return t('editionSync.indexing.summary.queueBooksHours', {
    count: backlog.books,
    hours: formatNumber(backlog.hoursAtRecentRate, { maximumFractionDigits: 1 }),
  })
})

const lastRunText = computed(() => {
  const last = status.value?.lastRun
  if (!last) return t('editionSync.indexing.summary.noRun')
  const when = formatRelativeFromNow(new Date(last.endedAt))
  if (last.stopReason === 'stopped' || last.stopReason === 'worker_unavailable' || last.stopReason === 'error') {
    return t('editionSync.indexing.summary.lastRunOutcome', { when, outcome: t(`editionSync.indexing.summary.outcome.${last.stopReason}`) })
  }
  return t('editionSync.indexing.summary.lastRunCounts', {
    when,
    indexed: formatNumber(last.booksIndexed),
    failed: formatNumber(last.booksFailed),
  })
})

const summary = computed(() => [
  { key: 'queue', label: t('editionSync.indexing.summary.queue'), value: queueText.value },
  { key: 'nextRun', label: t('editionSync.indexing.summary.nextRun'), value: nextRunText.value ?? t('editionSync.indexing.summary.notScheduled') },
  { key: 'lastRun', label: t('editionSync.indexing.summary.lastRun'), value: lastRunText.value },
])

async function handleRun() {
  if (!(await runNow())) toast.error(t('editionSync.admin.toast.runFailed'), { description: error.value ?? undefined })
}

async function handleStop() {
  if (!(await stop())) toast.error(t('editionSync.admin.toast.stopFailed'), { description: error.value ?? undefined })
}
</script>

<template>
  <section
    class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5"
    aria-labelledby="edition-sync-indexing-heading"
    data-testid="edition-sync-indexing"
  >
    <div v-if="loading" class="flex justify-center py-4">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 id="edition-sync-indexing-heading" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {{ t('editionSync.indexing.heading') }}
          </h3>
          <span v-if="worker" class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="edition-sync-indexing-worker">
            <AlertCircle v-if="!workerOk" class="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span class="truncate">{{ workerText }}</span>
          </span>
        </div>
        <template v-if="status">
          <Button
            v-if="runActive"
            variant="outline"
            size="sm"
            type="button"
            :disabled="acting"
            data-testid="edition-sync-indexing-stop"
            @click="handleStop"
          >
            <Square class="size-3.5" aria-hidden="true" />
            {{ t('editionSync.indexing.stop') }}
          </Button>
          <Button
            v-else
            size="sm"
            type="button"
            :disabled="acting || !workerOk || !serverOn"
            data-testid="edition-sync-indexing-run"
            @click="handleRun"
          >
            <Play class="size-3.5" aria-hidden="true" />
            {{ t('editionSync.indexing.run') }}
          </Button>
        </template>
      </div>

      <div v-if="!status" role="alert">
        <p class="text-sm text-destructive">{{ t('editionSync.admin.loadFailed') }}</p>
        <p v-if="error" class="mt-0.5 text-xs text-muted-foreground">{{ error }}</p>
      </div>

      <template v-else>
        <div v-if="bodyState === 'running' && current" class="flex items-center gap-3" role="status" data-testid="edition-sync-indexing-current">
          <EditionSyncBookCover :book-id="current.bookId" size="md" />
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex items-baseline justify-between gap-3">
              <p class="truncate text-sm" :title="current.title">{{ current.title }}</p>
              <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ formatPercent(currentPercent / 100) }}</span>
            </div>
            <div
              class="h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              :aria-valuenow="currentPercent"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="current.title"
            >
              <div class="h-full rounded-full bg-primary transition-[width]" :style="{ width: `${currentPercent}%` }" />
            </div>
            <p class="truncate text-xs text-muted-foreground">{{ runningMeta }}</p>
          </div>
        </div>
        <p
          v-else-if="bodyState === 'paused' && worker"
          class="flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="edition-sync-indexing-body"
        >
          <AlertCircle class="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
          {{ t(`editionSync.indexing.paused.${worker.state}`) }}
        </p>
        <p v-else class="text-xs text-muted-foreground" data-testid="edition-sync-indexing-body">
          <template v-if="bodyState === 'serverOff'">{{ t('editionSync.indexing.serverOff') }}</template>
          <template v-else-if="bodyState === 'active'">{{ t('editionSync.indexing.active') }}</template>
          <template v-else>{{ idleText }}</template>
        </p>

        <dl class="grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <div v-for="entry in summary" :key="entry.key" class="min-w-0" :data-summary="entry.key">
            <dt class="text-[11px] text-muted-foreground">{{ entry.label }}</dt>
            <dd class="mt-0.5 truncate text-sm" :title="entry.value">{{ entry.value }}</dd>
          </div>
        </dl>
      </template>
    </template>
  </section>
</template>
