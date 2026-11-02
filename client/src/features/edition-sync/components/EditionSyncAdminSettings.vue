<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Eraser, Loader2, Save } from '@lucide/vue'
import type { EditionSyncFilesChangedMode } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatBytes } from '@/lib/formatting'
import { injectEditionSyncAdmin } from '../composables/useEditionSyncAdmin'
import EditionSyncScheduleField from './EditionSyncScheduleField.vue'

const { t } = useI18n()
const { status, settings, loading, saving, acting, error, saveSchedule, clearUnused } = injectEditionSyncAdmin()

const enabled = ref(false)
const cronExpression = ref<string | null>(null)
const runHours = ref(8)
const onFilesChanged = ref<EditionSyncFilesChangedMode>('next_run')
const scheduleValid = ref(true)
const filesChangedModes: EditionSyncFilesChangedMode[] = ['next_run', 'immediate']
const clearConfirmOpen = ref(false)

watch(
  settings,
  (value) => {
    if (!value) return
    enabled.value = value.enabled
    cronExpression.value = value.cronExpression
    runHours.value = value.runHours
    onFilesChanged.value = value.onFilesChanged
  },
  { immediate: true },
)

const dirty = computed(
  () =>
    !!settings.value &&
    (settings.value.enabled !== enabled.value ||
      settings.value.cronExpression !== cronExpression.value ||
      settings.value.runHours !== runHours.value ||
      settings.value.onFilesChanged !== onFilesChanged.value),
)
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

    <section v-else-if="settings" class="divide-y divide-border rounded-lg border border-border bg-card shadow-xs">
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
      <div class="flex justify-end px-4 py-3">
        <Button size="sm" type="button" :disabled="saving || !dirty || !scheduleValid" @click="handleSaveSchedule">
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          {{ t('common.save') }}
        </Button>
      </div>
      <div v-if="status" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p class="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="edition-sync-admin-unused">
          {{ t('editionSync.admin.unused.summary', { count: unusedCount, size: formatBytes(status.counts.unusedBytes) }) }}
        </p>
        <Button variant="outline" size="sm" type="button" :disabled="acting || unusedCount === 0" @click="openClearConfirm">
          <Eraser class="size-3.5" />
          {{ t('editionSync.admin.unused.clear') }}
        </Button>
      </div>
    </section>

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
