<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Pencil } from '@lucide/vue'
import type { AudiobookshelfBookState, EditionLinkCandidate } from '@bookorbit/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { SyncChainDialogKind, SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainActionId, ChainViewMode, ConnectorKey, EditionKey } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { chainViewItems, TONE_PILL_CLASS } from '@/features/book/lib/sync-chain-view'
import EditionSlotSearch from './EditionSlotSearch.vue'
import SyncChainAbsSearch from './SyncChainAbsSearch.vue'
import SyncChainAvailableRow from './SyncChainAvailableRow.vue'
import SyncChainCard from './SyncChainCard.vue'
import SyncChainConnector from './SyncChainConnector.vue'

const props = withDefaults(defineProps<{ panel: SyncChainPanelView; readAlongRebuildRequested?: boolean }>(), { readAlongRebuildRequested: false })
const emit = defineEmits<{ 'read-along-rebuild-request-handled': [] }>()

const { t } = useI18n()

const NEXT_VIEW: Record<ChainViewMode, ChainViewMode> = { compact: 'modify', modify: 'compact' }
const VIEW_TOGGLE_KEY: Record<ChainViewMode, string> = {
  compact: 'book.detail.editionLink.chain.modify',
  modify: 'book.detail.editionLink.chain.done',
}
// Only the confirms that take something away are styled as destructive.
const DESTRUCTIVE_DIALOG: Record<SyncChainDialogKind, boolean> = {
  unlinkPair: true,
  detachReadAlong: true,
  pauseAbs: true,
  change: false,
  rebuildReadAlong: true,
}

const viewToggle = ref<HTMLButtonElement | null>(null)
const cards = new Map<EditionKey, { focusChange: () => void }>()

const view = computed(() => props.panel.viewMode)
const ready = computed(() => !props.panel.initialLoading && view.value !== null)
const items = computed(() => chainViewItems(props.panel.chain.rows, props.panel.changing))
const dialogText = computed(() => {
  const dialog = props.panel.dialog
  if (!dialog) return null
  return {
    title: chainText(dialog.title, t),
    description: chainText(dialog.description, t),
    confirmLabel: chainText(dialog.confirmLabel, t),
    destructive: DESTRUCTIVE_DIALOG[dialog.kind],
  }
})

// The search replaces the card, so closing it leaves focus on nothing until the card is back.
watch(
  () => props.panel.changing,
  async (next, previous) => {
    if (next !== null || previous === null) return
    await nextTick()
    cards.get(previous)?.focusChange()
  },
)

// A rebuild asked for from outside the panel waits for the read-along status to load, then goes
// through the same confirm as the panel's own button.
watch(
  () => props.readAlongRebuildRequested && props.panel.canRequestReadAlongRebuild,
  (requested) => {
    if (!requested) return
    props.panel.openReadAlongRebuildConfirm()
    emit('read-along-rebuild-request-handled')
  },
  { immediate: true },
)

function bindCard(edition: EditionKey) {
  return (card: unknown) => {
    if (card) cards.set(edition, card as { focusChange: () => void })
    else cards.delete(edition)
  }
}

async function handleToggleView() {
  if (!view.value) return
  props.panel.setViewMode(NEXT_VIEW[view.value])
  await nextTick()
  viewToggle.value?.focus()
}

function handleAction(id: ChainActionId, rowKey: string) {
  props.panel.runAction(id, rowKey)
}

function handleToggle(key: ConnectorKey, next: boolean) {
  props.panel.switchConnector(key, next)
}

function handleQuery(value: string) {
  props.panel.search.setQuery(value)
}

function handlePick(candidate: EditionLinkCandidate) {
  props.panel.search.pick(candidate)
}

function handleCloseSearch() {
  props.panel.search.close()
}

function handleAbsQuery(value: string) {
  props.panel.absActions.search.setQuery(value)
}

function handleAbsPick(item: AudiobookshelfBookState) {
  void props.panel.search.pickAbsItem(item)
}

function handleKeepRemoteCopy(value: boolean) {
  props.panel.readAlongOptions.setKeepRemoteCopy(value)
}

function handleTargetLibrary(value: number | null) {
  props.panel.readAlongOptions.setTargetLibrary(value)
}

function handleConfirm() {
  void props.panel.confirmDialog()
}

function handleCancelDialog() {
  props.panel.cancelDialog()
}
</script>

<template>
  <div data-testid="sync-chain-panel" :data-view="view ?? undefined">
    <div class="flex items-center gap-2">
      <Activity class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 class="min-w-0 truncate text-base font-semibold text-foreground">{{ t('book.detail.readingAlignment.title') }}</h2>
      <span class="shrink-0" aria-live="polite" data-testid="sync-chain-header-live">
        <span
          v-if="ready"
          class="block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
          :class="TONE_PILL_CLASS[panel.chain.header.tone]"
          :data-tone="panel.chain.header.tone"
          data-testid="sync-chain-header-pill"
        >
          {{ chainText(panel.chain.header.label, t) }}
        </span>
      </span>
      <button
        v-if="ready && view"
        ref="viewToggle"
        type="button"
        class="ms-auto inline-flex h-7 shrink-0 items-center gap-1 px-0.5 text-xs font-semibold text-info hover:underline"
        :data-view="view"
        data-testid="sync-chain-view-toggle"
        @click="handleToggleView"
      >
        <Pencil v-if="view === 'compact'" class="size-3" aria-hidden="true" />
        {{ t(VIEW_TOGGLE_KEY[view]) }}
      </button>
    </div>

    <div v-if="!ready" class="mt-3 space-y-2" data-testid="sync-chain-skeleton">
      <div class="h-4 w-3/4 animate-shimmer rounded bg-muted" />
      <div class="h-24 w-full animate-shimmer rounded-xl bg-muted" />
    </div>

    <template v-else-if="view">
      <p class="mt-0.5 mb-2 text-xs text-pretty text-muted-foreground" data-testid="sync-chain-intro">{{ chainText(panel.chain.intro, t) }}</p>

      <div class="flex flex-col" data-testid="sync-chain-rows">
        <template v-for="item in items" :key="item.id">
          <SyncChainCard v-if="item.kind === 'card'" :ref="bindCard(item.row.edition)" :row="item.row" :view="view" @action="handleAction" />
          <EditionSlotSearch
            v-else-if="item.kind === 'cardSearch'"
            :format="item.format"
            can-search
            cancellable
            :query="panel.search.query"
            :candidates="panel.search.candidates"
            :searching="panel.search.searching"
            :search-error="panel.search.searchError"
            :has-searched="panel.search.hasSearched"
            :autofocus="panel.search.autofocus"
            :disabled="panel.busy"
            @update:query="handleQuery"
            @pick="handlePick"
            @cancel="handleCloseSearch"
          />
          <SyncChainAbsSearch
            v-else-if="item.kind === 'absSearch'"
            :query="panel.absActions.search.query"
            :results="panel.absActions.search.results"
            :searching="panel.absActions.search.searching"
            :search-error="panel.absActions.search.searchError"
            :has-searched="panel.absActions.search.hasSearched"
            :disabled="panel.busy"
            @update:query="handleAbsQuery"
            @pick="handleAbsPick"
            @cancel="handleCloseSearch"
          />
          <SyncChainConnector
            v-else-if="item.kind === 'connector'"
            :row="item.row"
            :view="view"
            :busy="panel.busy"
            :cancelling="panel.cancelling"
            :abs-live="panel.abs.live"
            :abs-busy="panel.absActions.busy"
            :abs-action-error="panel.absActions.actionError"
            @toggle="handleToggle"
            @action="handleAction"
          />
          <div
            v-else-if="item.kind === 'availableHeader'"
            class="flex items-center gap-2.5 px-0.5 pt-3 pb-1"
            data-testid="sync-chain-available-header"
          >
            <span class="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{{
              t('book.detail.editionLink.chain.availableHeader')
            }}</span>
            <div class="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
          <SyncChainAvailableRow
            v-else
            :row="item.row"
            :expanded="panel.expandedRowId === item.id"
            :log-open="panel.logOpen"
            :busy="panel.busy"
            :options="panel.readAlongOptions"
            @action="handleAction"
            @update:keep-remote-copy="handleKeepRemoteCopy"
            @update:target-library-id="handleTargetLibrary"
          >
            <EditionSlotSearch
              v-if="item.searchFormat"
              :format="item.searchFormat"
              can-search
              cancellable
              :query="panel.search.query"
              :candidates="panel.search.candidates"
              :searching="panel.search.searching"
              :search-error="panel.search.searchError"
              :has-searched="panel.search.hasSearched"
              :autofocus="panel.search.autofocus"
              :disabled="panel.busy"
              @update:query="handleQuery"
              @pick="handlePick"
              @cancel="handleCloseSearch"
            />
          </SyncChainAvailableRow>
        </template>
      </div>
    </template>

    <ConfirmDialog
      :open="dialogText !== null"
      :title="dialogText?.title ?? ''"
      :description="dialogText?.description ?? ''"
      :confirm-label="dialogText?.confirmLabel ?? ''"
      :destructive="dialogText?.destructive ?? true"
      :busy="panel.dialogBusy"
      @confirm="handleConfirm"
      @cancel="handleCancelDialog"
    />
  </div>
</template>
