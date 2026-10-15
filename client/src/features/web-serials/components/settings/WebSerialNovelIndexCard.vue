<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DatabaseZap, Loader2, RefreshCw, RotateCcw, TriangleAlert } from '@lucide/vue'
import type { WebSerialNovelIndexSource } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { formatDateTime, formatNumber, formatRelativeFromNow } from '@/i18n/formatters'
import { useWebSerialNovelIndex } from '../../composables/useWebSerialNovelIndex'
import { MAX_INDEX_DAILY_BUDGET, MIN_INDEX_DAILY_BUDGET } from '../../lib/settingsDraft'
import { useWebSerialSettingsContext } from './settingsContext'

const { t } = useI18n()
const { draft, indexBudgetInvalid } = useWebSerialSettingsContext()
const index = useWebSerialNovelIndex()
const { status, loading, error, busy } = index

const TONES: Record<WebSerialNovelIndexSource['fillState'], string> = {
  done: 'border-success/40 bg-success/10 text-success',
  filling: 'border-primary/40 bg-primary/10 text-primary',
  paused: 'border-warning/40 bg-warning/10 text-warning',
  pending: 'border-border bg-muted text-muted-foreground',
}

const sources = computed(() => status.value?.sources ?? [])
const budget = computed(() => status.value?.dailyBudget ?? draft.novel.indexDailyBudget)

onMounted(() => {
  void index.load()
})

function handleBudget(event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber
  draft.novel.indexDailyBudget = Number.isFinite(value) ? value : 0
}

function handleFill(source: WebSerialNovelIndexSource) {
  void index.act(source.sourceId, 'fill')
}

const pendingRebuild = ref<WebSerialNovelIndexSource | null>(null)

function handleRebuild(source: WebSerialNovelIndexSource) {
  pendingRebuild.value = source
}

async function handleConfirmRebuild() {
  const source = pendingRebuild.value
  if (!source) return
  await index.act(source.sourceId, 'rebuild')
  pendingRebuild.value = null
}

function handleCancelRebuild() {
  pendingRebuild.value = null
}

const rebuildDescription = computed(() =>
  pendingRebuild.value
    ? t('webSerials.settings.novelIndex.rebuildConfirm.description', {
        name: pendingRebuild.value.name,
        count: pendingRebuild.value.entries,
        entries: formatNumber(pendingRebuild.value.entries),
      })
    : '',
)

function handleReload() {
  void index.load()
}

function stateLabel(source: WebSerialNovelIndexSource): string {
  if (source.running) return t('webSerials.settings.novelIndex.state.running')
  return t(`webSerials.settings.novelIndex.state.${source.fillState}`)
}

function topupLabel(source: WebSerialNovelIndexSource): string {
  return source.lastTopupAt
    ? t('webSerials.settings.novelIndex.lastTopup', { time: formatRelativeFromNow(new Date(source.lastTopupAt)) })
    : t('webSerials.settings.novelIndex.noTopup')
}

function topupTitle(source: WebSerialNovelIndexSource): string | undefined {
  return source.lastTopupAt ? formatDateTime(new Date(source.lastTopupAt)) : undefined
}

function requestsLabel(source: WebSerialNovelIndexSource): string {
  return t('webSerials.settings.novelIndex.requests', { used: formatNumber(source.requestsToday), budget: formatNumber(budget.value) })
}

function entriesLabel(source: WebSerialNovelIndexSource): string {
  return t('webSerials.settings.novelIndex.entries', { count: source.entries })
}
</script>

<template>
  <section class="settings-card" aria-labelledby="web-serials-novel-index-title" data-testid="novel-index-card">
    <div class="bg-card px-4 py-3.5 md:px-5 md:py-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 basis-72 gap-3">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
            <DatabaseZap :size="17" />
          </span>
          <div class="min-w-0">
            <h3 id="web-serials-novel-index-title" class="settings-label">{{ t('webSerials.settings.novelIndex.title') }}</h3>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('webSerials.settings.novelIndex.subtitle') }}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" :disabled="loading" @click="handleReload">
          <Loader2 v-if="loading" class="animate-spin" aria-hidden="true" />
          <RefreshCw v-else :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.novelIndex.reload') }}
        </Button>
      </div>

      <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <label for="web-serials-index-budget" class="settings-label block">{{ t('webSerials.settings.novelIndex.budget.label') }}</label>
          <p id="web-serials-index-budget-hint" class="settings-hint">
            {{ t('webSerials.settings.novelIndex.budget.hint', { min: MIN_INDEX_DAILY_BUDGET, max: formatNumber(MAX_INDEX_DAILY_BUDGET) }) }}
          </p>
        </div>
        <input
          id="web-serials-index-budget"
          type="number"
          inputmode="numeric"
          class="input-field w-full shrink-0 sm:w-40"
          :min="MIN_INDEX_DAILY_BUDGET"
          :max="MAX_INDEX_DAILY_BUDGET"
          step="10"
          :value="draft.novel.indexDailyBudget"
          :aria-invalid="indexBudgetInvalid"
          aria-describedby="web-serials-index-budget-hint"
          @input="handleBudget"
        />
      </div>

      <p v-if="error" role="alert" class="mt-3 flex items-center gap-2 text-sm text-destructive">
        <TriangleAlert class="size-4 shrink-0" aria-hidden="true" />
        {{ error }}
      </p>
      <p v-if="status?.unavailable" class="mt-3 text-xs text-warning">{{ t('webSerials.settings.novelIndex.unavailable') }}</p>
      <p v-if="status && sources.length === 0" class="mt-3 text-sm text-muted-foreground">{{ t('webSerials.settings.novelIndex.empty') }}</p>

      <ul
        v-if="sources.length > 0"
        class="mt-3 divide-y divide-border rounded-lg border border-border"
        :aria-label="t('webSerials.settings.novelIndex.title')"
      >
        <li
          v-for="source in sources"
          :key="source.sourceId"
          class="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
          data-testid="novel-index-source"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-sm font-medium text-foreground">{{ source.name }}</span>
              <span
                class="inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap"
                :class="TONES[source.fillState]"
                data-testid="novel-index-state"
              >
                <Loader2 v-if="source.running" :size="12" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {{ stateLabel(source) }}
              </span>
              <span v-if="!source.enabled" class="text-xs text-muted-foreground">{{ t('webSerials.settings.novelIndex.disabled') }}</span>
            </div>
            <p class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>{{ entriesLabel(source) }}</span>
              <span :title="topupTitle(source)">{{ topupLabel(source) }}</span>
              <span>{{ requestsLabel(source) }}</span>
            </p>
            <p v-if="source.lastError" class="mt-0.5 text-xs break-words text-destructive">{{ source.lastError }}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              :disabled="Boolean(busy[source.sourceId]) || !source.enabled"
              :aria-label="t('webSerials.settings.novelIndex.fillNowFor', { name: source.name })"
              @click="handleFill(source)"
            >
              <Loader2 v-if="busy[source.sourceId] === 'fill'" class="animate-spin" aria-hidden="true" />
              <DatabaseZap v-else :size="14" aria-hidden="true" />
              {{ t('webSerials.settings.novelIndex.fillNow') }}
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="Boolean(busy[source.sourceId]) || source.running"
              :aria-label="t('webSerials.settings.novelIndex.rebuildFor', { name: source.name })"
              @click="handleRebuild(source)"
            >
              <Loader2 v-if="busy[source.sourceId] === 'rebuild'" class="animate-spin" aria-hidden="true" />
              <RotateCcw v-else :size="14" aria-hidden="true" />
              {{ t('webSerials.settings.novelIndex.rebuild') }}
            </Button>
          </div>
        </li>
      </ul>
    </div>
    <ConfirmDialog
      :open="pendingRebuild !== null"
      :title="t('webSerials.settings.novelIndex.rebuildConfirm.title', { name: pendingRebuild?.name ?? '' })"
      :description="rebuildDescription"
      :confirm-label="t('webSerials.settings.novelIndex.rebuild')"
      :busy="pendingRebuild !== null && Boolean(busy[pendingRebuild.sourceId])"
      @confirm="handleConfirmRebuild"
      @cancel="handleCancelRebuild"
    />
  </section>
</template>
