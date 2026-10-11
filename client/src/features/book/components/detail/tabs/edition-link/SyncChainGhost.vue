<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChainActionId, ChainFrame, ChainGhostRow, ChainViewMode } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import SyncChainActionButton from './SyncChainActionButton.vue'
import SyncChainPlaceholder from './SyncChainPlaceholder.vue'
import SyncChainSettingsLink from './SyncChainSettingsLink.vue'

const props = withDefaults(defineProps<{ row: ChainGhostRow; view: ChainViewMode; busy?: boolean; frame?: ChainFrame }>(), {
  busy: false,
  frame: 'spine',
})
const emit = defineEmits<{ action: [id: ChainActionId, rowKey: string] }>()

const { t } = useI18n()

const noteId = `sync-chain-ghost-note-${useId()}`
const actionEl = ref<{ $el: HTMLElement } | null>(null)

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}

function focusChange() {
  actionEl.value?.$el.focus()
}

defineExpose({ focusChange })
</script>

<template>
  <SyncChainPlaceholder
    :view="view"
    :frame="frame"
    :label="chainText(row.label, t)"
    :note="chainText(row.note, t)"
    :note-id="noteId"
    :data-edition="row.edition"
    data-testid="sync-chain-ghost"
  >
    <template #tile="{ tileClass }">
      <div class="rounded border border-dashed border-border bg-muted/40" :class="tileClass" />
    </template>
    <template v-if="row.settingsLink" #note>
      <SyncChainSettingsLink :label="t('book.detail.editionLink.abs.settings')" data-testid="sync-chain-ghost-settings" />
    </template>
    <template #actions="{ compact }">
      <SyncChainActionButton
        v-if="row.action"
        ref="actionEl"
        :action="row.action"
        :variant="compact ? 'link' : 'outline'"
        :class="compact ? '-my-1' : ''"
        :disabled="busy"
        :aria-describedby="noteId"
        @action="handleAction"
      />
    </template>
  </SyncChainPlaceholder>
</template>
