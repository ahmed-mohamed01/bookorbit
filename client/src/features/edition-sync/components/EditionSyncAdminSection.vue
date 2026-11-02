<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Cpu, Eraser, Loader2, Play, Save, Square } from '@lucide/vue'
import type { EditionSyncFilesChangedMode } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatBytes } from '@/lib/formatting'
import { formatDate, formatNumber, formatPercent } from '@/i18n/formatters'
import { stageLabelKey } from '@/features/read-aloud/lib/read-aloud'
import { useEditionSyncAdmin } from '../composables/useEditionSyncAdmin'
import EditionSyncScheduleField from './EditionSyncScheduleField.vue'

const { t } = useI18n()
const { status, settings, loading, saving, acting, error, load, saveSchedule, runNow, stop, clearUnused } = useEditionSyncAdmin()

const enabled = ref(false)
const cronExpression = ref<string | null>(null)
const runHours = ref(8)
const onFilesChanged = ref<EditionSyncFilesChangedMode>('next_run')
const scheduleValid = ref(true)
const filesChangedModes: EditionSyncFilesChangedMode[] = ['next_run', 'immediate']
const clearConfirmOpen = ref(false)

watch(settings, (value) => {
  if (!value) return
  enabled.value = value.enabled
  cronExpression.value = value.cronExpression
  runHours.value = value.runHours
  onFilesChanged.value = value.onFilesChanged
})

onMounted(load)

const dirty = computed(
  () =>
    !!settings.value &&
    (settings.value.enabled !== enabled.value ||
      settings.value.cronExpression !== cronExpression.value ||
      settings.value.runHours !== runHours.value ||
      settings.value.onFilesChanged !== onFilesChanged.value),
)
const runActive = computed(() => status.value?.run.active === true)
const worker = computed(() => status.value?.worker ?? null)
const workerOk = computed(() => worker.value?.state === 'ok')
const current = computed(() => status.value?.run.current ?? null)
const nextRun = computed(() => {
  const iso = status.value?.schedule.nextRunAt
  return iso ? formatDate(new Date(iso), { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
})
const currentText = computed(() => {
  if (!current.value) return ''
  const stage = current.value.stage ? t(stageLabelKey(current.value.stage)) : ''
  const percent = formatPercent(Math.min(Math.max(current.value.progress, 0), 100) / 100)
  return [current.value.title, stage, percent].filter(Boolean).join(' · ')
})

const countItems = computed(() => {
  const counts = status.value?.counts
  if (!counts) return []
  return [
    { key: 'indexed', value: formatNumber(counts.indexed) },
    { key: 'queued', value: formatNumber(counts.queued) },
    { key: 'failed', value: formatNumber(counts.failed) },
    { key: 'stale', value: formatNumber(counts.stale) },
  ]
})
const backlogText = computed(() => {
  const backlog = status.value?.backlogEstimate
  if (!backlog || backlog.books <= 0) return null
  if (backlog.hoursAtRecentRate === null) return t('editionSync.admin.backlogNoRate', { count: backlog.books })
  return t('editionSync.admin.backlog', { count: backlog.books, hours: formatNumber(backlog.hoursAtRecentRate, { maximumFractionDigits: 1 }) })
})
const unusedCount = computed(() => status.value?.counts.unusedIndexes ?? 0)

function handleFilesChangedChange(event: Event) {
  onFilesChanged.value = (event.target as HTMLSelectElement).value as EditionSyncFilesChangedMode
}

function handleScheduleValid(value: boolean) {
  scheduleValid.value = value
}

async function handleSaveSchedule() {
  const ok = await saveSchedule({
    enabled: enabled.value,
    cronExpression: cronExpression.value,
    runHours: runHours.value,
    onFilesChanged: onFilesChanged.value,
  })
  if (ok) toast.success(t('editionSync.admin.toast.scheduleSaved'))
  else toast.error(t('editionSync.admin.toast.scheduleFailed'), { description: error.value ?? undefined })
}

async function handleRunNow() {
  if (!(await runNow())) toast.error(t('editionSync.admin.toast.runFailed'), { description: error.value ?? undefined })
}

async function handleStop() {
  if (!(await stop())) toast.error(t('editionSync.admin.toast.stopFailed'), { description: error.value ?? undefined })
}

function openClearConfirm() {
  clearConfirmOpen.value = true
}

function cancelClear() {
  clearConfirmOpen.value = false
}

async function confirmClear() {
  const result = await clearUnused()
  clearConfirmOpen.value = false
  if (result) toast.success(t('editionSync.admin.toast.cleared', { count: result.deleted, size: formatBytes(result.freedBytes) }))
  else toast.error(t('editionSync.admin.toast.clearFailed'), { description: error.value ?? undefined })
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="settings-loading-state">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <template v-else>
      <div v-if="!status" role="alert">
        <p class="text-sm text-destructive">{{ t('editionSync.admin.loadFailed') }}</p>
        <p v-if="error" class="mt-0.5 text-xs text-muted-foreground">{{ error }}</p>
      </div>

      <section v-if="worker" class="flex items-start gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
        <Cpu :size="17" class="mt-0.5 shrink-0 text-foreground" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-foreground">{{ t('editionSync.admin.worker.title') }}</p>
          <p class="mt-0.5 text-xs" :class="workerOk ? 'text-success' : 'text-warning'">{{ t(`editionSync.admin.worker.state.${worker.state}`) }}</p>
          <p v-if="workerOk" class="mt-0.5 truncate text-xs text-muted-foreground">
            {{ [worker.version, worker.device].filter(Boolean).join(' · ') }}
          </p>
          <p v-if="workerOk && !worker.rebuildSupported" class="mt-1 text-xs text-muted-foreground">{{ t('editionSync.admin.worker.noRebuild') }}</p>
        </div>
      </section>

      <section v-if="settings" class="divide-y divide-border rounded-xl border border-border bg-card">
        <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div class="min-w-0">
            <p id="edition-sync-enabled-label" class="text-sm">{{ t('editionSync.admin.enabled.title') }}</p>
            <p id="edition-sync-enabled-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('editionSync.admin.enabled.description') }}</p>
          </div>
          <ToggleSwitch
            v-model="enabled"
            aria-labelledby="edition-sync-enabled-label"
            aria-describedby="edition-sync-enabled-help"
            data-testid="edition-sync-admin-enabled"
          />
        </div>
        <EditionSyncScheduleField v-model:cron-expression="cronExpression" v-model:run-hours="runHours" @update:valid="handleScheduleValid" />
        <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div class="min-w-0">
            <label for="edition-sync-files-changed" class="text-sm">{{ t('editionSync.admin.filesChanged.title') }}</label>
            <p id="edition-sync-files-changed-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('editionSync.admin.filesChanged.help') }}</p>
          </div>
          <select
            id="edition-sync-files-changed"
            :value="onFilesChanged"
            class="shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            aria-describedby="edition-sync-files-changed-help"
            @change="handleFilesChangedChange"
          >
            <option v-for="mode in filesChangedModes" :key="mode" :value="mode">{{ t(`editionSync.admin.filesChanged.options.${mode}`) }}</option>
          </select>
        </div>
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <p class="min-w-0 truncate text-xs text-muted-foreground">{{ nextRun ? t('editionSync.admin.nextRun', { when: nextRun }) : '' }}</p>
          <Button size="sm" type="button" :disabled="saving || !dirty || !scheduleValid" @click="handleSaveSchedule">
            <Loader2 v-if="saving" class="size-3.5 animate-spin" />
            <Save v-else class="size-3.5" />
            {{ t('common.save') }}
          </Button>
        </div>
      </section>

      <section v-if="status" class="space-y-3 rounded-xl border border-border bg-card px-4 py-3.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-semibold text-foreground">{{ t('editionSync.admin.run.title') }}</p>
          <div class="flex items-center gap-2">
            <Button v-if="runActive" variant="outline" size="sm" type="button" :disabled="acting" @click="handleStop">
              <Square class="size-3.5" />
              {{ t('editionSync.admin.run.stop') }}
            </Button>
            <Button v-else size="sm" type="button" :disabled="acting || !workerOk || !settings?.enabled" @click="handleRunNow">
              <Play class="size-3.5" />
              {{ t('editionSync.admin.run.start') }}
            </Button>
          </div>
        </div>

        <p v-if="current" class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span class="truncate" :title="currentText">{{ currentText }}</span>
        </p>
        <p v-else-if="runActive" class="text-xs text-muted-foreground">{{ t('editionSync.admin.run.active') }}</p>
        <p v-else class="text-xs text-muted-foreground">{{ t('editionSync.admin.run.idle') }}</p>

        <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div v-for="item in countItems" :key="item.key" class="rounded-md border border-border bg-background px-3 py-2">
            <dt class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t(`editionSync.admin.counts.${item.key}`) }}</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">{{ item.value }}</dd>
          </div>
        </dl>
        <p v-if="backlogText" class="text-xs text-muted-foreground">{{ backlogText }}</p>

        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p class="min-w-0 flex-1 text-xs text-muted-foreground">
            {{ t('editionSync.admin.unused.summary', { count: unusedCount, size: formatBytes(status.counts.unusedBytes) }) }}
          </p>
          <Button variant="outline" size="sm" type="button" :disabled="acting || unusedCount === 0" @click="openClearConfirm">
            <Eraser class="size-3.5" />
            {{ t('editionSync.admin.unused.clear') }}
          </Button>
        </div>
      </section>
    </template>

    <ConfirmDialog
      :open="clearConfirmOpen"
      :title="t('editionSync.admin.unused.dialog.title')"
      :description="t('editionSync.admin.unused.dialog.description')"
      :confirm-label="t('editionSync.admin.unused.clear')"
      :busy="acting"
      @confirm="confirmClear"
      @cancel="cancelClear"
    />
  </div>
</template>
