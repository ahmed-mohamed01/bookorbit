<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { monitoredBulkFormats, type MonitoredBulkRequestFormat, type MonitoredWork } from '@bookorbit/types'
import { formatNumber } from '@/i18n/formatters'
import { isMissing, isReleased } from '../lib/bulk-select'
import { todayUtc } from '../lib/format-status'

const props = defineProps<{
  /** The works the viewer may pick from, as they are on screen. */
  works: MonitoredWork[]
  selectedIds: ReadonlySet<string>
  format: MonitoredBulkRequestFormat
}>()
const emit = defineEmits<{
  add: [ids: string[]]
  keep: [ids: string[]]
}>()
const { t } = useI18n()

const BUTTON =
  'inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-muted'

const today = computed(() => todayUtc())
const missingEbooks = computed(() => props.works.filter((work) => isMissing(work, 'ebook', today.value)).map((work) => work.id))
const missingAudiobooks = computed(() => props.works.filter((work) => isMissing(work, 'audiobook', today.value)).map((work) => work.id))
const releasedSelected = computed(() => {
  const formats = monitoredBulkFormats(props.format)
  return props.works
    .filter((work) => props.selectedIds.has(work.id) && formats.some((format) => isReleased(work, format, today.value)))
    .map((work) => work.id)
})
const hasSelection = computed(() => props.selectedIds.size > 0)

function handleAddEbooks() {
  emit('add', missingEbooks.value)
}

function handleAddAudiobooks() {
  emit('add', missingAudiobooks.value)
}

function handleReleasedOnly() {
  emit('keep', releasedSelected.value)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/80 px-3 py-2" data-testid="quick-select">
    <span class="text-sm text-muted-foreground">{{ t('monitored.selection.quick.label') }}</span>
    <button v-if="missingEbooks.length > 0" type="button" :class="BUTTON" data-testid="quick-missing-ebooks" @click="handleAddEbooks">
      {{ t('monitored.selection.quick.missingEbooks') }}
      <span class="text-muted-foreground tabular-nums">{{ formatNumber(missingEbooks.length) }}</span>
    </button>
    <button v-if="missingAudiobooks.length > 0" type="button" :class="BUTTON" data-testid="quick-missing-audiobooks" @click="handleAddAudiobooks">
      {{ t('monitored.selection.quick.missingAudiobooks') }}
      <span class="text-muted-foreground tabular-nums">{{ formatNumber(missingAudiobooks.length) }}</span>
    </button>
    <button
      type="button"
      :class="BUTTON"
      :disabled="!hasSelection"
      :title="t('monitored.selection.quick.releasedOnlyHint')"
      data-testid="quick-released-only"
      @click="handleReleasedOnly"
    >
      {{ t('monitored.selection.quick.releasedOnly') }}
    </button>
    <span class="ms-auto hidden text-xs text-muted-foreground sm:inline [@media(pointer:coarse)]:hidden">{{
      t('monitored.selection.quick.rangeHint')
    }}</span>
  </div>
</template>
