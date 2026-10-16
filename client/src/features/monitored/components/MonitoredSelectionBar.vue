<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Database, Download, Eye, EyeOff, Loader2, X } from '@lucide/vue'
import {
  MONITORED_BULK_REQUEST_FORMATS,
  type DownloadDelivery,
  type MonitoredBulkRequestFormat,
  type MonitoredFormat,
  type MonitoredBulkWorkPatch,
  type MonitoredWork,
} from '@bookorbit/types'
import SelectionActionBar from '@/components/SelectionActionBar.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatList, formatNumber } from '@/i18n/formatters'
import type { SourceGroup } from '../composables/useRequestSources'
import { bulkRequestPreview } from '../lib/bulk-select'
import { todayUtc } from '../lib/format-status'
import { workDisplayClass } from '../lib/work-visibility'

const props = defineProps<{
  visible: boolean
  works: MonitoredWork[]
  format: MonitoredBulkRequestFormat
  autoDownload: boolean
  running: boolean
  sourceGroups: SourceGroup[]
}>()
const emit = defineEmits<{
  'update:format': [format: MonitoredBulkRequestFormat]
  'update:autoDownload': [value: boolean]
  toggleSource: [format: MonitoredFormat, id: number]
  useAllSources: []
  request: []
  patch: [patch: MonitoredBulkWorkPatch]
  exit: []
}>()
const { t } = useI18n()

const SEGMENT =
  'inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
const BUTTON_GHOST =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground'

const preview = computed(() => bulkRequestPreview(props.works, props.format, todayUtc()))
const willRequest = computed(() => preview.value.ebooks + preview.value.audiobooks)
const count = computed(() => props.works.length)
const everyHidden = computed(() => props.works.length > 0 && props.works.every((work) => workDisplayClass(work) === 'hidden'))
const formatOptions = computed(() => MONITORED_BULK_REQUEST_FORMATS.map((value) => ({ value, label: t(`monitored.selection.bar.${value}`) })))
const getLabel = computed(() => {
  if (props.format === 'ebook') return t('monitored.selection.bar.getEbooks', { count: preview.value.ebooks })
  if (props.format === 'audiobook') return t('monitored.selection.bar.getAudiobooks', { count: preview.value.audiobooks })
  return t('monitored.selection.bar.getBoth', { ebooks: preview.value.ebooks, audiobooks: preview.value.audiobooks })
})
const skipLines = computed(() =>
  [
    { key: 'owned', count: preview.value.skipped.owned, label: 'skippedOwned', tone: 'text-[var(--pill-success)]' },
    { key: 'requested', count: preview.value.skipped.requested, label: 'skippedRequested', tone: 'text-[var(--pill-info)]' },
    { key: 'no_ebook', count: preview.value.skipped.no_ebook, label: 'skippedNoEbook', tone: 'text-muted-foreground' },
  ].filter((line) => line.count > 0),
)
const sourcesOpen = ref(false)
const sourcesOn = computed(() => props.sourceGroups.reduce((sum, group) => sum + group.ticked.size, 0))
const sourcesTotal = computed(() => props.sourceGroups.reduce((sum, group) => sum + group.rows.length, 0))
const sourcesLabel = computed(() =>
  sourcesOn.value === sourcesTotal.value
    ? t('monitored.selection.sources.labelAll')
    : t('monitored.selection.sources.labelSome', { on: sourcesOn.value, total: sourcesTotal.value }),
)
const sourceLines = computed(() =>
  props.sourceGroups
    .filter((group) => group.ticked.size < group.rows.length)
    .map((group) => ({
      format: group.format,
      text: t(`monitored.selection.sources.from.${group.format}`, {
        names: formatList(group.rows.filter((row) => group.ticked.has(row.id)).map((row) => row.name)),
      }),
    })),
)
const canRequest = computed(() => willRequest.value > 0 && !props.running)

function isFormat(value: string): value is MonitoredBulkRequestFormat {
  return (MONITORED_BULK_REQUEST_FORMATS as readonly string[]).includes(value)
}

function handleFormat(event: MouseEvent) {
  const value = (event.currentTarget as HTMLElement).dataset.format
  if (value && isFormat(value)) emit('update:format', value)
}

function deliveryLabel(delivery: DownloadDelivery): string {
  return t(`monitored.selection.sources.delivery.${delivery}`)
}

function handleToggleSource(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const { format, id } = input.dataset
  if (format && id) emit('toggleSource', format as MonitoredFormat, Number(id))
}

function handleUseAllSources() {
  emit('useAllSources')
}

function handleRequest() {
  if (canRequest.value) emit('request')
}

function handleAutoDownload(value: boolean) {
  emit('update:autoDownload', value)
}

function handleWatchEbooks() {
  emit('patch', { monitorEbook: true })
}

function handleWatchAudiobooks() {
  emit('patch', { monitorAudiobook: true })
}

function handleUnwatchEbooks() {
  emit('patch', { monitorEbook: false })
}

function handleUnwatchAudiobooks() {
  emit('patch', { monitorAudiobook: false })
}

function handleHide() {
  emit('patch', everyHidden.value ? { automaticVisibility: true } : { hidden: true })
}

function handleExit() {
  emit('exit')
}
</script>

<template>
  <SelectionActionBar :visible="visible" :count="count" @exit="handleExit">
    <template #content>
      <span
        class="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg bg-primary/10 px-2.5 text-sm font-semibold tabular-nums text-primary"
        data-testid="selected-count"
        >{{ t('monitored.selection.selectedCount', { count: formatNumber(count) }) }}</span
      >

      <div
        role="radiogroup"
        :aria-label="t('monitored.selection.bar.formatLabel')"
        class="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
      >
        <button
          v-for="option in formatOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="format === option.value"
          :data-format="option.value"
          :class="[SEGMENT, format === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']"
          @click="handleFormat"
        >
          {{ option.label }}
        </button>
      </div>

      <Popover v-if="sourceGroups.length > 0 && !running" v-model:open="sourcesOpen">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :class="sourcesOpen ? 'ring-1 ring-primary' : ''"
            aria-haspopup="dialog"
            :aria-expanded="sourcesOpen"
            data-testid="bulk-sources"
          >
            <Database :size="14" aria-hidden="true" />
            {{ sourcesLabel }}
            <component :is="sourcesOpen ? ChevronUp : ChevronDown" :size="13" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          :side-offset="12"
          class="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl p-3.5"
          role="dialog"
          :aria-label="t('monitored.selection.sources.dialogLabel')"
        >
          <div class="flex items-center gap-2">
            <span class="flex-1 text-sm font-semibold">{{ t('monitored.selection.sources.title') }}</span>
            <button
              type="button"
              class="inline-flex h-8 items-center rounded-lg px-2 text-sm font-medium text-primary transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              data-testid="sources-use-all"
              @click="handleUseAllSources"
            >
              {{ t('monitored.selection.sources.useAll') }}
            </button>
          </div>
          <fieldset v-for="group in sourceGroups" :key="group.format" class="m-0 flex flex-col gap-1 border-0 p-0" :data-sources-group="group.format">
            <legend class="mb-1.5 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t(`monitored.selection.sources.group.${group.format}`) }}
            </legend>
            <label
              v-for="row in group.rows"
              :key="row.id"
              class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 transition-colors hover:bg-muted has-[:checked]:bg-primary/10 has-[:disabled]:cursor-not-allowed"
            >
              <input
                type="checkbox"
                class="size-4 shrink-0 accent-primary"
                :checked="group.ticked.has(row.id)"
                :disabled="group.locked === row.id"
                :data-format="group.format"
                :data-id="row.id"
                @change="handleToggleSource"
              />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ row.name }}</span>
              <span class="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{{
                deliveryLabel(row.delivery)
              }}</span>
            </label>
          </fieldset>
          <p class="m-0 border-t border-border pt-2.5 text-xs leading-relaxed text-muted-foreground">
            {{ t('monitored.selection.sources.footnote') }}
          </p>
        </PopoverContent>
      </Popover>

      <button
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canRequest"
        data-testid="bulk-request"
        @click="handleRequest"
      >
        <Loader2 v-if="running" :size="14" class="animate-spin" aria-hidden="true" />
        <Download v-else :size="14" aria-hidden="true" />
        {{ getLabel }}
      </button>

      <div class="mx-1 h-5 w-px shrink-0 bg-border" />

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" :class="BUTTON_GHOST" :disabled="running || count === 0" data-testid="bulk-monitor">
            {{ t('monitored.selection.bar.monitor') }}
            <ChevronDown :size="14" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center">
          <DropdownMenuItem data-testid="bulk-watch-ebooks" @click="handleWatchEbooks">
            <Eye :size="14" />{{ t('monitored.selection.bar.watchEbooks') }}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="bulk-watch-audiobooks" @click="handleWatchAudiobooks">
            <Eye :size="14" />{{ t('monitored.selection.bar.watchAudiobooks') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="bulk-unwatch-ebooks" @click="handleUnwatchEbooks">
            <EyeOff :size="14" />{{ t('monitored.selection.bar.unwatchEbooks') }}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="bulk-unwatch-audiobooks" @click="handleUnwatchAudiobooks">
            <EyeOff :size="14" />{{ t('monitored.selection.bar.unwatchAudiobooks') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button type="button" :class="BUTTON_GHOST" :disabled="running || count === 0" data-testid="bulk-hide" @click="handleHide">
        {{ everyHidden ? t('monitored.selection.bar.unhide') : t('monitored.selection.bar.hide') }}
      </button>

      <button
        type="button"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        :aria-label="t('monitored.selection.exit')"
        data-testid="bulk-exit"
        @click="handleExit"
      >
        <X :size="17" />
      </button>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="bulk-footer">
        <span data-testid="bulk-will-request">{{ t('monitored.selection.bar.willBeRequested', { count: formatNumber(willRequest) }) }}</span>
        <span v-for="line in sourceLines" :key="line.format" class="text-foreground" :data-source-line="line.format">{{ line.text }}</span>
        <span v-for="line in skipLines" :key="line.key" :class="line.tone" :data-skip="line.key">{{
          t(`monitored.selection.bar.${line.label}`, line.key === 'no_ebook' ? { count: line.count } : { count: formatNumber(line.count) })
        }}</span>
        <label class="ms-auto inline-flex cursor-pointer items-center gap-2">
          <ToggleSwitch :model-value="autoDownload" :disabled="running" @update:model-value="handleAutoDownload" />
          <span>{{ t('monitored.selection.bar.autoGrab') }}</span>
        </label>
      </div>
    </template>
  </SelectionActionBar>
</template>
