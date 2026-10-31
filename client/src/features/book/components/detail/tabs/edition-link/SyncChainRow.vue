<script setup lang="ts">
import type { AudiobookshelfBookState } from '@bookorbit/types'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainActionId, ChainViewMode, ConnectorKey, EditionKey } from '@/features/book/lib/sync-chain'
import type { ChainViewItem } from '@/features/book/lib/sync-chain-view'
import SyncChainAbsSearch from './SyncChainAbsSearch.vue'
import SyncChainCard from './SyncChainCard.vue'
import SyncChainConnector from './SyncChainConnector.vue'
import SyncChainGhost from './SyncChainGhost.vue'
import SyncChainReadAloudSlot from './SyncChainReadAloudSlot.vue'
import { chainRowStyle } from './chain-ui'

const props = defineProps<{
  item: ChainViewItem
  view: ChainViewMode
  panel: SyncChainPanelView
  bindCard: (edition: EditionKey) => (card: unknown) => void
}>()

function handleAction(id: ChainActionId) {
  props.panel.runAction(id)
}

function handleToggle(key: ConnectorKey, next: boolean) {
  props.panel.switchConnector(key, next)
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
</script>

<template>
  <div :style="chainRowStyle(item.id)" :data-row="item.id" :data-frame="item.frame">
    <SyncChainCard
      v-if="item.kind === 'card'"
      :ref="bindCard(item.row.edition)"
      :row="item.row"
      :view="view"
      :frame="item.frame"
      :busy="panel.busy"
      @action="handleAction"
    />
    <SyncChainGhost
      v-else-if="item.kind === 'ghost'"
      :ref="bindCard(item.row.edition)"
      :row="item.row"
      :view="view"
      :frame="item.frame"
      :busy="panel.busy"
      @action="handleAction"
    />
    <SyncChainAbsSearch
      v-else-if="item.kind === 'absSearch'"
      :frame="item.frame"
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
    <SyncChainReadAloudSlot v-else-if="item.kind === 'readAloudSlot'" :row="item.row" :busy="panel.busy" @action="handleAction" />
    <SyncChainConnector
      v-else
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
  </div>
</template>
