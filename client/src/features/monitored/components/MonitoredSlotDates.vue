<script setup lang="ts">
import { BellDot, TriangleAlert } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredFormat } from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MonitoredReleaseRow } from '../composables/useReleaseRows'
import MonitoredReleaseDatePopover from './MonitoredReleaseDatePopover.vue'

/** The release date of a format card's stat line, with the alerts that sit next to it. */
defineProps<{
  format: MonitoredFormat
  row: MonitoredReleaseRow
  label: string
  open: boolean
  /** May look release dates up and change them. */
  canManage: boolean
  refreshing: boolean
}>()
const emit = defineEmits<{
  'open-change': [format: MonitoredFormat, open: boolean]
  set: [format: MonitoredFormat, releaseDate: string]
  clear: [format: MonitoredFormat]
  refresh: []
}>()

const { t } = useI18n()

function handleOpenChange(format: MonitoredFormat, open: boolean) {
  emit('open-change', format, open)
}

function handleSet(format: MonitoredFormat, releaseDate: string) {
  emit('set', format, releaseDate)
}

function handleClear(format: MonitoredFormat) {
  emit('clear', format)
}

function handleRefresh() {
  emit('refresh')
}
</script>

<template>
  <MonitoredReleaseDatePopover
    v-if="row.editable"
    :format="format"
    :open="open"
    :label="label"
    :muted="row.muted"
    :current-date="row.date"
    :source="row.source"
    :details="row.details"
    :suggestion="row.suggestion"
    :state="row.dates"
    :can-refresh="canManage"
    :refreshing="refreshing"
    @open-change="handleOpenChange"
    @set="handleSet"
    @clear="handleClear"
    @refresh="handleRefresh"
  />
  <TooltipProvider v-else>
    <Tooltip>
      <TooltipTrigger as-child>
        <span
          tabindex="0"
          class="inline-flex items-center rounded-xs text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          :class="row.muted ? 'text-muted-foreground' : 'text-foreground'"
          >{{ label }}</span
        >
      </TooltipTrigger>
      <TooltipContent v-if="row.details.length" class="max-w-64">
        <span v-for="line in row.details" :key="line" class="block">{{ line }}</span>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>

  <TooltipProvider v-if="row.suggestion && row.editable">
    <Tooltip>
      <TooltipTrigger as-child>
        <span
          tabindex="0"
          data-testid="release-date-suggestion"
          class="inline-flex items-center rounded-sm text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <BellDot :size="14" aria-hidden="true" />
          <span class="sr-only">{{ t('monitored.panel.releaseDates.suggestedLabel') }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent class="max-w-64">
        <span class="block">{{ row.suggestion.text }}</span>
        <span class="block">{{ row.suggestionHint }}</span>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <TooltipProvider v-if="row.unconfirmed">
    <Tooltip>
      <TooltipTrigger as-child>
        <span tabindex="0" class="inline-flex items-center rounded-sm text-[var(--pill-warning)]">
          <TriangleAlert :size="14" aria-hidden="true" />
          <span class="sr-only">{{ t('monitored.panel.releaseDates.notConfirmed') }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent class="max-w-64">{{ row.unconfirmedHint }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
