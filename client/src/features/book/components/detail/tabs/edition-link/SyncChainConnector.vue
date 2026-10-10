<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Ban, Link2, Loader2, TriangleAlert } from '@lucide/vue'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import type { AbsSyncBusy } from '@/features/book/composables/useAudiobookshelfSyncActions'
import type { ChainActionId, ChainConnectorRow, ChainIcon, ChainTone, ChainViewMode, ConnectorKey, EditionKey } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { TONE_PILL_CLASS } from '@/features/book/lib/sync-chain-view'
import PositionSyncTicks from './PositionSyncTicks.vue'
import SyncChainAbsDetails from './SyncChainAbsDetails.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'

const props = withDefaults(
  defineProps<{
    row: ChainConnectorRow
    view: ChainViewMode
    busy?: boolean
    cancelling?: boolean
    absLive?: AudiobookshelfBookSyncLive | null
    absBusy?: AbsSyncBusy | null
    absActionError?: string | null
  }>(),
  { busy: false, cancelling: false, absLive: null, absBusy: null, absActionError: null },
)
const emit = defineEmits<{ toggle: [key: ConnectorKey, next: boolean]; action: [id: ChainActionId, rowKey: string] }>()

const { t } = useI18n()

const SHORT_KEY: Record<EditionKey, string> = {
  ebook: 'book.detail.editionLink.chain.short.ebook',
  readAlong: 'book.detail.editionLink.chain.short.readAlong',
  audiobook: 'book.detail.editionLink.chain.short.audiobook',
  abs: 'book.detail.editionLink.chain.short.abs',
}

const LINE_CLASS: Record<ChainTone, string> = {
  success: 'border-success/60',
  info: 'border-info/60',
  warning: 'border-warning/60',
  destructive: 'border-destructive/50',
  muted: 'border-border',
}

const CIRCLE_CLASS: Record<ChainTone, string> = {
  success: 'border-success/60 bg-success/15 text-success',
  info: 'border-info/60 bg-info/15 text-info',
  warning: 'border-warning/60 bg-warning/15 text-warning',
  destructive: 'border-destructive/50 bg-destructive/10 text-destructive',
  muted: 'border-border bg-card text-muted-foreground',
}

const MINI_TEXT_CLASS: Record<ChainTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
}

const SWITCH_TONE: Record<ChainTone, 'success' | 'info' | 'warning'> = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  destructive: 'success',
  muted: 'success',
}

const ICON: Record<ChainIcon, Component> = { link: Link2, spinner: Loader2, alert: TriangleAlert, ban: Ban }
const ICON_MOTION: Record<ChainIcon, string> = { link: '', spinner: 'animate-spin', alert: '', ban: '' }

// The rail sits under the cards' cover column, which a Modify card insets by its border and padding.
const RAIL_PAD: Record<ChainViewMode, string> = { modify: 'px-[11px]', compact: 'px-px' }

const lineStyle = computed(() => (props.row.dashed ? 'border-dashed' : 'border-solid'))
const lineClass = computed(() => [LINE_CLASS[props.row.tone], lineStyle.value])
const circleClass = computed(() => [CIRCLE_CLASS[props.row.tone], lineStyle.value])
const icon = computed(() => ICON[props.row.icon])
const iconClass = computed(() => ICON_MOTION[props.row.icon])
const names = computed(() => ({ from: t(SHORT_KEY[props.row.from]), to: t(SHORT_KEY[props.row.to]) }))

function handleToggle(next: boolean) {
  emit('toggle', props.row.key, next)
}

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}
</script>

<template>
  <div
    v-if="view === 'modify'"
    class="flex min-h-[52px] items-stretch gap-2.5"
    :class="RAIL_PAD[view]"
    :data-key="row.key"
    :data-state="row.state"
    data-testid="sync-chain-connector"
  >
    <div class="flex w-10 shrink-0 flex-col items-center" aria-hidden="true" data-testid="sync-chain-rail">
      <div class="min-h-3 w-0 flex-1 border-s-2" :class="lineClass" />
      <div
        class="flex size-[30px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
        :class="circleClass"
        data-testid="sync-chain-node"
      >
        <component :is="icon" class="size-3.5" :class="iconClass" />
      </div>
      <div class="min-h-3 w-0 flex-1 border-s-2" :class="lineClass" />
    </div>

    <div class="flex min-w-0 flex-1 flex-col justify-center gap-1.5 py-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <span class="text-xs font-semibold whitespace-nowrap text-foreground">{{ t('book.detail.editionLink.chain.connectorLabel', names) }}</span>
          <span
            class="rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
            :class="TONE_PILL_CLASS[row.tone]"
            data-testid="sync-chain-pill"
          >
            {{ chainText(row.pill, t) }}
          </span>
        </div>
        <ToggleSwitch
          v-if="row.switch"
          :model-value="row.switch.on"
          :tone="SWITCH_TONE[row.tone]"
          :disabled="row.switch.disabled || busy"
          :aria-label="t('book.detail.editionLink.chain.switchLabel', names)"
          data-testid="sync-chain-switch"
          @update:model-value="handleToggle"
        />
      </div>

      <div v-if="row.ticks" class="flex items-center gap-2">
        <PositionSyncTicks class="min-w-0 flex-1" :samples-done="row.ticks.samplesDone" :samples-total="row.ticks.samplesTotal" />
        <SyncChainActionButton v-if="row.cancel" :action="row.cancel" variant="cancel" :disabled="cancelling" @action="handleAction" />
      </div>

      <SyncChainAbsDetails v-if="row.absDetails" :row="row" :live="absLive" :busy="absBusy" :action-error="absActionError" @action="handleAction" />
      <template v-else>
        <p v-if="row.note" class="text-xs text-pretty text-muted-foreground" data-testid="sync-chain-note">{{ chainText(row.note, t) }}</p>
        <p v-if="row.detail" class="text-xs break-words text-muted-foreground" data-testid="sync-chain-detail">{{ row.detail }}</p>
        <div v-if="row.actions.length" class="flex flex-wrap items-center gap-1.5">
          <SyncChainActionButton v-for="action in row.actions" :key="action.id" :action="action" :disabled="busy" @action="handleAction" />
        </div>
      </template>
    </div>
  </div>

  <div
    v-else
    class="flex min-h-[30px] items-center gap-2.5"
    :class="RAIL_PAD[view]"
    :data-key="row.key"
    :data-state="row.state"
    data-testid="sync-chain-connector"
  >
    <div class="flex w-10 shrink-0 flex-col items-center self-stretch" aria-hidden="true" data-testid="sync-chain-rail">
      <div class="w-0 flex-1 border-s-2" :class="lineClass" />
      <div class="flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px]" :class="circleClass" data-testid="sync-chain-node">
        <component :is="icon" class="size-3" :class="iconClass" />
      </div>
      <div class="w-0 flex-1 border-s-2" :class="lineClass" />
    </div>
    <span
      v-if="row.mini.text"
      class="min-w-0 truncate text-xs font-semibold whitespace-nowrap"
      :class="MINI_TEXT_CLASS[row.tone]"
      data-testid="sync-chain-mini-text"
    >
      {{ chainText(row.mini.text, t) }}
    </span>
    <span v-else class="sr-only">{{ chainText(row.pill, t) }}</span>
    <SyncChainActionButton v-if="row.mini.action" :action="row.mini.action" variant="link" :disabled="busy" @action="handleAction" />
    <div class="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
  </div>
</template>
