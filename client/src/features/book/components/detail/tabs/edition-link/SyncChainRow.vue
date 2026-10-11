<script setup lang="ts">
import type { AudiobookshelfBookState, EditionLinkCandidate } from '@bookorbit/types'
import type { SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainActionId, ChainViewMode, ConnectorKey, EditionKey } from '@/features/book/lib/sync-chain'
import type { ChainViewItem } from '@/features/book/lib/sync-chain-view'
import EditionSlotSearch from './EditionSlotSearch.vue'
import SyncChainAbsSearch from './SyncChainAbsSearch.vue'
import SyncChainCard from './SyncChainCard.vue'
import SyncChainConnector from './SyncChainConnector.vue'
import SyncChainGhost from './SyncChainGhost.vue'
import SyncChainReadAlongSlot from './SyncChainReadAlongSlot.vue'
import { chainRowStyle } from './chain-ui'

const props = defineProps<{
  item: ChainViewItem
  view: ChainViewMode
  panel: SyncChainPanelView
  bindCard: (edition: EditionKey) => (card: unknown) => void
}>()

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
    <EditionSlotSearch
      v-else-if="item.kind === 'cardSearch'"
      :format="item.format"
      :frame="item.frame"
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
    <SyncChainReadAlongSlot
      v-else
      :row="item.row"
      :expanded="panel.optionsOpen"
      :log-open="panel.logOpen"
      :busy="panel.busy"
      :options="panel.readAlongOptions"
      @action="handleAction"
      @update:keep-remote-copy="handleKeepRemoteCopy"
      @update:target-library-id="handleTargetLibrary"
    />
  </div>
</template>
