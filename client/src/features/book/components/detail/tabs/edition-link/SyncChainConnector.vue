<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ArrowLeftRight, ArrowRight } from '@lucide/vue'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import type { AbsSyncBusy } from '@/features/book/composables/useAudiobookshelfSyncActions'
import type {
  ChainActionId,
  ChainArrow,
  ChainConnectorRow,
  ChainFrame,
  ChainViewMode,
  ConnectorKey,
  EditionKey,
} from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { TONE_LINE_CLASS, TONE_PILL_CLASS } from '@/features/book/lib/sync-chain-view'
import PositionSyncTicks from './PositionSyncTicks.vue'
import SyncChainAbsDetails from './SyncChainAbsDetails.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'
import SyncChainChevron from './SyncChainChevron.vue'
import SyncChainRailSwitch from './SyncChainRailSwitch.vue'
import SyncChainSettingsLink from './SyncChainSettingsLink.vue'
import { CHAIN_ICON, CHAIN_ICON_MOTION, CHAIN_NODE_CLASS, CHAIN_TONE_TEXT_CLASS } from './chain-ui'

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

const ARROW_ICON: Record<ChainArrow, Component> = { both: ArrowLeftRight, left: ArrowLeft, right: ArrowRight }
const ARROW_KEY: Record<ChainArrow, string> = {
  both: 'book.detail.editionLink.chain.arrow.both',
  left: 'book.detail.editionLink.chain.arrow.left',
  right: 'book.detail.editionLink.chain.arrow.right',
}

interface ConnectorSize {
  inset: string
  row: string
  body: string
  node: string
  nodeIcon: string
  compactRow: string
  compactNode: string
  compactIcon: string
}

const SIZE: Record<ChainFrame, ConnectorSize> = {
  spine: {
    inset: 'ps-[9px]',
    row: 'min-h-8',
    body: 'py-1.5',
    node: 'size-7',
    nodeIcon: 'size-3.5',
    compactRow: 'min-h-[30px]',
    compactNode: 'size-5',
    compactIcon: 'size-3',
  },
  group: {
    inset: 'ps-2',
    row: 'min-h-7',
    body: 'py-1',
    node: 'size-5',
    nodeIcon: 'size-3',
    compactRow: 'min-h-[26px]',
    compactNode: 'size-4',
    compactIcon: 'size-2.5',
  },
}

const size = computed(() => SIZE[props.row.frame])
const miniTextClass = computed(() => CHAIN_TONE_TEXT_CLASS[props.row.tone === 'success' ? 'muted' : props.row.tone])
const disabledText = computed(() => (props.row.switch?.disabled && props.row.disabledReason ? chainText(props.row.disabledReason, t) : undefined))
const lineStyle = computed(() => (props.row.dashed ? 'border-dashed' : 'border-solid'))
const lineClass = computed(() => [TONE_LINE_CLASS[props.row.tone], lineStyle.value])
const circleClass = computed(() => [CHAIN_NODE_CLASS[props.row.tone], lineStyle.value])
const icon = computed(() => CHAIN_ICON[props.row.icon])
const iconClass = computed(() => CHAIN_ICON_MOTION[props.row.icon])
const names = computed(() => ({ from: t(SHORT_KEY[props.row.from]), to: t(SHORT_KEY[props.row.to]) }))
const switchLabel = computed(() => t('book.detail.editionLink.chain.switchLabel', names.value))
const explained = ref(false)
const detailsOpen = ref(false)
// Compact rows stay one line, except an out-of-sync Audiobookshelf row: its reconcile buttons open under it on demand.
const compactDetails = computed(() => props.row.absDetails && props.row.state === 'absDiverged')
const explainerId = `sync-chain-explainer-${useId()}`
const detailsId = `sync-chain-details-${useId()}`
const rootEl = ref<HTMLElement | null>(null)
const chevronEl = ref<{ $el: HTMLButtonElement } | null>(null)

watch(
  () => props.row.state,
  () => {
    explained.value = false
    detailsOpen.value = false
  },
)

// A landed reconcile removes the button that ran it, which would drop focus to the page.
watch(
  () => props.row,
  async () => {
    if (!rootEl.value?.contains(document.activeElement)) return
    await nextTick()
    if (rootEl.value?.contains(document.activeElement)) return
    ;(chevronEl.value?.$el ?? rootEl.value)?.focus()
  },
)
const reasonId = `sync-chain-switch-reason-${useId()}`

function handleToggle(next: boolean) {
  emit('toggle', props.row.key, next)
}

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}

function handleToggleExplainer() {
  explained.value = !explained.value
}

function handleToggleDetails() {
  detailsOpen.value = !detailsOpen.value
}
</script>

<template>
  <div
    v-if="view === 'modify'"
    ref="rootEl"
    tabindex="-1"
    class="flex items-stretch gap-2.5"
    :class="[size.inset, size.row]"
    :data-key="row.key"
    :data-state="row.state"
    data-testid="sync-chain-connector"
  >
    <div class="flex w-9 shrink-0 flex-col items-center" data-testid="sync-chain-rail">
      <div class="min-h-1.5 w-0 flex-1 border-s-2" :class="lineClass" aria-hidden="true" data-testid="sync-chain-rail-line" />
      <SyncChainRailSwitch
        v-if="row.switch"
        :model-value="row.switch.on"
        :tone="row.tone"
        :icon="row.icon"
        :disabled="row.switch.disabled || busy"
        :label="switchLabel"
        :size="row.frame"
        :title="disabledText"
        :aria-describedby="disabledText ? reasonId : undefined"
        @update:model-value="handleToggle"
      />
      <div
        v-else
        class="flex shrink-0 items-center justify-center rounded-full border-[1.5px]"
        :class="[size.node, circleClass]"
        aria-hidden="true"
        data-testid="sync-chain-node"
      >
        <component :is="icon" :class="[size.nodeIcon, iconClass]" />
      </div>
      <span v-if="disabledText" :id="reasonId" class="sr-only" data-testid="sync-chain-disabled-reason">{{ disabledText }}</span>
      <div class="min-h-1.5 w-0 flex-1 border-s-2" :class="lineClass" aria-hidden="true" data-testid="sync-chain-rail-line" />
    </div>

    <div class="flex min-w-0 flex-1 flex-col justify-center gap-1" :class="size.body">
      <div class="flex items-center gap-2">
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <span class="inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap text-foreground" data-testid="sync-chain-label">
            {{ names.from }}
            <component
              :is="ARROW_ICON[row.arrow]"
              class="size-3 shrink-0 text-muted-foreground"
              role="img"
              :aria-label="t(ARROW_KEY[row.arrow])"
              :data-arrow="row.arrow"
              data-testid="sync-chain-arrow"
            />
            {{ names.to }}
          </span>
          <span
            v-if="row.qualifier"
            class="rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
            :class="TONE_PILL_CLASS[row.tone]"
            data-testid="sync-chain-qualifier"
          >
            {{ chainText(row.qualifier, t) }}
          </span>
          <span v-if="row.tone === 'success'" class="sr-only" data-testid="sync-chain-state">{{ chainText(row.pill, t) }}</span>
          <span
            v-else-if="row.state !== 'available'"
            class="rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
            :class="TONE_PILL_CLASS[row.tone]"
            data-testid="sync-chain-pill"
          >
            {{ chainText(row.pill, t) }}
          </span>
          <SyncChainChevron
            v-if="row.explainer"
            :expanded="explained"
            :controls="explainerId"
            :label="t('book.detail.editionLink.chain.explainToggle')"
            @toggle="handleToggleExplainer"
          />
        </div>
      </div>

      <p v-if="row.explainer && explained" :id="explainerId" class="text-xs text-pretty text-muted-foreground" data-testid="sync-chain-explainer">
        {{ chainText(row.explainer, t) }}
        <SyncChainSettingsLink
          v-if="row.settingsLink"
          :label="t('book.detail.editionLink.abs.settings')"
          data-testid="sync-chain-explainer-settings"
        />
      </p>

      <div v-if="row.ticks" class="flex items-center gap-2">
        <PositionSyncTicks class="min-w-0 flex-1" :samples-done="row.ticks.samplesDone" :samples-total="row.ticks.samplesTotal" />
        <SyncChainActionButton v-if="row.cancel" :action="row.cancel" variant="cancel" :disabled="cancelling" @action="handleAction" />
      </div>

      <SyncChainAbsDetails
        v-if="row.absDetails"
        :row="row"
        :live="absLive"
        :busy="absBusy"
        :panel-busy="busy"
        :action-error="absActionError"
        @action="handleAction"
      />
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
    ref="rootEl"
    tabindex="-1"
    class="flex items-stretch gap-2.5"
    :class="size.inset"
    :data-key="row.key"
    :data-state="row.state"
    data-testid="sync-chain-connector"
  >
    <div class="flex w-9 shrink-0 flex-col items-center" aria-hidden="true" data-testid="sync-chain-rail">
      <div class="h-[5px] w-0 shrink-0 border-s-2" :class="lineClass" />
      <div
        class="flex shrink-0 items-center justify-center rounded-full border-[1.5px]"
        :class="[size.compactNode, circleClass]"
        data-testid="sync-chain-node"
      >
        <component :is="icon" :class="[size.compactIcon, iconClass]" />
      </div>
      <div class="w-0 flex-1 border-s-2" :class="lineClass" />
    </div>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex items-center gap-2.5" :class="size.compactRow">
        <span
          v-if="row.mini.text"
          class="min-w-0 truncate text-xs font-semibold whitespace-nowrap first-letter:uppercase"
          :class="miniTextClass"
          data-testid="sync-chain-mini-text"
        >
          {{ chainText(row.mini.text, t) }}
        </span>
        <span v-else class="sr-only">{{ chainText(row.pill, t) }}</span>
        <SyncChainChevron
          v-if="compactDetails"
          ref="chevronEl"
          :expanded="detailsOpen"
          :controls="detailsId"
          :label="t('book.detail.editionLink.chain.reconcileToggle')"
          @toggle="handleToggleDetails"
        />
        <SyncChainActionButton v-if="row.mini.action" :action="row.mini.action" variant="link" :disabled="busy" @action="handleAction" />
        <div class="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
      </div>
      <SyncChainAbsDetails
        v-if="compactDetails && detailsOpen"
        :id="detailsId"
        class="pb-1.5"
        :row="row"
        :live="absLive"
        :busy="absBusy"
        :panel-busy="busy"
        :action-error="absActionError"
        @action="handleAction"
      />
    </div>
  </div>
</template>
