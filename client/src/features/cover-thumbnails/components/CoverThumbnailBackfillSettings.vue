<script setup lang="ts">
// Fork: Settings › Fork › Cover thumbnails. Admin only.
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2, Play } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatRelativeTimeFromNow } from '@/i18n/formatters'
import { useCoverThumbnailBackfill } from '../composables/useCoverThumbnailBackfill'

const { t } = useI18n()
const { state, loading, acting, load, setEnabled, runNow } = useCoverThumbnailBackfill()

onMounted(() => void load())

const running = computed(() => state.value?.running ?? null)

const runningText = computed(() => (running.value ? t('coverThumbnails.running', { scanned: running.value.scanned, made: running.value.made }) : ''))

const lastRunText = computed(() => {
  const last = state.value?.lastRun
  if (!last) return t('coverThumbnails.never')
  const when = `${formatRelativeTimeFromNow(last.finishedAt, { smallestUnit: 'minute' })} (${t(`coverThumbnails.trigger.${last.trigger}`)})`
  return t(`coverThumbnails.lastRun.${last.outcome}`, { when, scanned: last.scanned, missing: last.missing, made: last.made })
})

const unresolvedText = computed(() => {
  const count = state.value?.lastRun?.unresolved ?? 0
  return count > 0 ? t('coverThumbnails.lastRun.unresolved', { count }) : ''
})

async function handleToggle(enabled: boolean): Promise<void> {
  if (!(await setEnabled(enabled))) toast.error(t('coverThumbnails.toast.saveFailed'))
}

async function handleRun(): Promise<void> {
  if (!(await runNow())) toast.error(t('coverThumbnails.toast.runFailed'))
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="fork-cover-thumbnails" data-testid="cover-thumbnail-backfill">
    <h3 id="fork-cover-thumbnails" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
      {{ t('coverThumbnails.heading') }}
    </h3>

    <div v-if="loading" class="flex justify-center py-4">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <p v-else-if="!state" class="text-sm text-destructive" role="alert">{{ t('coverThumbnails.loadFailed') }}</p>

    <div v-else class="divide-y divide-border rounded-lg border border-border bg-card shadow-xs">
      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p id="cover-thumbnails-auto-label" class="text-sm">{{ t('coverThumbnails.auto.title') }}</p>
          <p id="cover-thumbnails-auto-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('coverThumbnails.auto.help') }}</p>
        </div>
        <ToggleSwitch
          :model-value="state.enabled"
          :disabled="acting"
          aria-labelledby="cover-thumbnails-auto-label"
          aria-describedby="cover-thumbnails-auto-help"
          data-testid="cover-thumbnail-backfill-toggle"
          @update:model-value="handleToggle"
        />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 text-xs text-muted-foreground" role="status" data-testid="cover-thumbnail-backfill-status">
          <p v-if="running" class="flex items-center gap-1.5">
            <Loader2 class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <span>{{ runningText }}</span>
          </p>
          <template v-else>
            <p>{{ lastRunText }}</p>
            <p v-if="unresolvedText" class="mt-0.5">{{ unresolvedText }}</p>
          </template>
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          class="shrink-0 self-start sm:self-center"
          :disabled="acting || !!running"
          data-testid="cover-thumbnail-backfill-run"
          @click="handleRun"
        >
          <Play class="size-3.5" aria-hidden="true" />
          {{ t('coverThumbnails.runNow') }}
        </Button>
      </div>
    </div>
  </section>
</template>
