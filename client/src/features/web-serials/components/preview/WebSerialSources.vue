<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WebSerialSourceOption } from '@bookorbit/types'
import { formatRelativeFromNow } from '@/i18n/formatters'
import { Button } from '@/components/ui/button'
import type { WebSerialEntryPreviewState } from '../../composables/useWebSerialEntryPreview'
import type { WebSerialSourcesState } from '../../composables/useWebSerialSources'

/**
 * `discover`: the sheet was opened from a series search result, so there is always something to say (looking, found,
 * nothing found, failed) and a single source is still shown. `entryState` drives those words.
 */
const props = withDefaults(
  defineProps<{
    options: WebSerialSourceOption[]
    state: WebSerialSourcesState
    selectedKey: string
    disabled: boolean
    discover?: boolean
    entryState?: WebSerialEntryPreviewState
    failedSources?: string[]
    errorMessage?: string | null
  }>(),
  { discover: false, entryState: 'idle', failedSources: () => [], errorMessage: null },
)

const emit = defineEmits<{ select: [seriesKey: string]; 'search-sites': []; retry: []; 'retry-failed': [] }>()

const { t } = useI18n()
const group = ref<HTMLElement | null>(null)
const finding = computed(() => props.discover && (props.entryState === 'finding' || props.entryState === 'idle'))
const showOptions = computed(() => (props.discover ? props.options.length > 0 : props.state === 'ready' && props.options.length >= 2))
const visible = computed(() => (props.discover ? true : props.state === 'loading' || showOptions.value))
const failedNote = computed(() =>
  props.failedSources.length > 0 ? t('webSerials.preview.sources.failedNote', { count: props.failedSources.length }) : null,
)

const CONFIDENCE_LABELS: Record<Exclude<WebSerialSourceOption['confidence'], 'current'>, string> = {
  same_series: 'webSerials.preview.sources.sameSeries',
  title_match: 'webSerials.preview.sources.titleMatch',
  whole_series: 'webSerials.preview.sources.wholeSeries',
}

function confidenceLabel(option: WebSerialSourceOption): string {
  return option.confidence === 'current' ? '' : t(CONFIDENCE_LABELS[option.confidence])
}

function detailLine(option: WebSerialSourceOption): string {
  if (option.chaptersUnknown) return t('webSerials.preview.sources.chaptersUnknown')
  const chapters = t('webSerials.preview.sources.chapters', { count: option.chapterCount })
  if (!option.latestAt) return chapters
  const time = new Date(option.latestAt).getTime()
  if (!Number.isFinite(time)) return chapters
  return `${chapters} · ${t('webSerials.preview.sources.updated', { time: formatRelativeFromNow(time) })}`
}

function radios(): HTMLInputElement[] {
  return Array.from(group.value?.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)') ?? [])
}

function handleKeydown(event: KeyboardEvent) {
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
  const all = radios()
  const current = all.findIndex((radio) => radio === document.activeElement)
  if (current === -1) return
  if (step !== 0) {
    event.preventDefault()
    all[(current + step + all.length) % all.length]?.focus()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    all[current]?.click()
  }
}

watch(
  () => props.disabled,
  async (isDisabled, wasDisabled) => {
    if (!wasDisabled || isDisabled) return
    await nextTick()
    const active = document.activeElement
    if (active && active !== document.body) return
    group.value?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus()
  },
)

function handleSearchSites() {
  emit('search-sites')
}

function handleRetry() {
  emit('retry')
}

function handleRetryFailed() {
  emit('retry-failed')
}

function handleSelect(option: WebSerialSourceOption) {
  if (option.seriesKey !== props.selectedKey) emit('select', option.seriesKey)
}
</script>

<template>
  <section v-if="visible" class="space-y-2" aria-labelledby="web-serial-sources-title">
    <h3 id="web-serial-sources-title" class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {{ t('webSerials.preview.sources.title') }}
    </h3>

    <div v-if="finding" class="grid gap-2" aria-busy="true" data-testid="sources-finding">
      <div v-for="index in 2" :key="index" class="h-14 animate-pulse rounded-lg border border-border bg-muted/50" aria-hidden="true" />
      <p class="text-xs text-muted-foreground" role="status">{{ t('webSerials.preview.sources.finding') }}</p>
    </div>

    <div v-else-if="!discover && state === 'loading'" class="grid gap-2" aria-busy="true" :aria-label="t('webSerials.preview.sources.loading')">
      <div v-for="index in 2" :key="index" class="h-14 animate-pulse rounded-lg border border-border bg-muted/50" aria-hidden="true" />
    </div>

    <div v-else-if="discover && entryState === 'none'" class="space-y-2 rounded-lg border border-border bg-muted/40 p-3" data-testid="sources-none">
      <p class="text-sm font-semibold text-foreground">{{ t('webSerials.preview.sources.none') }}</p>
      <p class="text-xs text-muted-foreground">{{ t('webSerials.preview.sources.noneHint') }}</p>
      <p v-if="failedNote" class="text-xs text-muted-foreground">
        {{ failedNote }}
        <button
          type="button"
          class="rounded-md font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          @click="handleRetryFailed"
        >
          {{ t('webSerials.preview.sources.retryFailed') }}
        </button>
      </p>
      <Button variant="outline" size="sm" @click="handleSearchSites">{{ t('webSerials.preview.sources.searchSites') }}</Button>
    </div>

    <div
      v-else-if="discover && !showOptions"
      class="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
      role="alert"
      data-testid="sources-error"
    >
      <p class="text-sm text-foreground">{{ errorMessage || t('webSerials.preview.sources.checkError') }}</p>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
        <Button variant="outline" size="sm" @click="handleSearchSites">{{ t('webSerials.preview.sources.searchSites') }}</Button>
      </div>
    </div>

    <div v-else ref="group" role="radiogroup" :aria-labelledby="'web-serial-sources-title'" class="grid gap-2" @keydown="handleKeydown">
      <label
        v-for="option in options"
        :key="option.seriesKey"
        class="flex items-center gap-3 rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring"
        :class="[
          disabled ? 'cursor-wait opacity-70' : 'cursor-pointer',
          selectedKey === option.seriesKey ? 'border-primary bg-primary/7 ring-1 ring-primary' : 'border-border bg-background',
          !disabled && selectedKey !== option.seriesKey ? 'hover:bg-muted' : '',
        ]"
      >
        <input
          type="radio"
          name="web-serials-source"
          class="size-4 shrink-0 accent-primary"
          :value="option.seriesKey"
          :checked="selectedKey === option.seriesKey"
          :disabled="disabled"
          @change="handleSelect(option)"
        />
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
            {{ option.sourceName }}
            <span
              v-if="option.confidence !== 'current'"
              class="rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            >
              {{ confidenceLabel(option) }}
            </span>
            <span
              v-if="option.mtl"
              class="rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
              :title="t('webSerials.results.mtlTitle')"
              data-testid="mtl-chip"
            >
              {{ t('webSerials.results.mtl') }}
            </span>
          </span>
          <span class="mt-0.5 block text-xs text-muted-foreground tabular-nums">{{ detailLine(option) }}</span>
          <span v-if="option.confidence === 'whole_series'" class="mt-0.5 block text-xs text-muted-foreground" data-testid="whole-series-note">
            {{ t('webSerials.preview.sources.wholeSeriesNote') }}
          </span>
        </span>
        <span
          v-if="option.mostComplete"
          class="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          {{ t('webSerials.preview.sources.mostComplete') }}
        </span>
      </label>
    </div>
    <p v-if="discover && showOptions && failedNote" class="text-xs text-muted-foreground">
      {{ failedNote }}
      <button
        type="button"
        class="rounded-md font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="handleRetryFailed"
      >
        {{ t('webSerials.preview.sources.retryFailed') }}
      </button>
    </p>
  </section>
</template>
