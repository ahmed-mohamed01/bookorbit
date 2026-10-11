<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import type { AbsSyncBusy } from '@/features/book/composables/useAudiobookshelfSyncActions'
import { ABS_RECONCILE_ACTIONS, absConnectorHint, isAbsReconcileAction } from '@/features/book/lib/abs-sync-status'
import type { ChainActionId, ChainConnectorRow } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import SyncChainActionButton from './SyncChainActionButton.vue'
import SyncChainSettingsLink from './SyncChainSettingsLink.vue'

const props = withDefaults(
  defineProps<{
    row: ChainConnectorRow
    live: AudiobookshelfBookSyncLive | null
    busy?: AbsSyncBusy | null
    panelBusy?: boolean
    actionError?: string | null
  }>(),
  { busy: null, panelBusy: false, actionError: null },
)
const emit = defineEmits<{ action: [id: ChainActionId] }>()

const { t } = useI18n()

const hint = computed(() => absConnectorHint(props.row.state, props.live, props.row.note ? chainText(props.row.note, t) : null, t))
const showSettings = computed(() => props.row.settingsLink && !props.row.explainer)

function isBusy(id: ChainActionId): boolean {
  return isAbsReconcileAction(id) && props.busy === ABS_RECONCILE_ACTIONS[id]
}

function handleAction(id: ChainActionId) {
  emit('action', id)
}
</script>

<template>
  <div class="flex flex-col gap-1.5 text-xs text-pretty text-muted-foreground" :data-state="row.state" data-testid="sync-chain-abs-details">
    <p v-if="hint || showSettings" data-testid="sync-chain-abs-hint">
      {{ hint }}
      <SyncChainSettingsLink v-if="showSettings" :label="t('book.detail.editionLink.abs.changeInSettings')" data-testid="sync-chain-abs-settings" />
    </p>
    <p v-if="actionError" class="text-destructive" role="status" data-testid="sync-chain-abs-error">{{ actionError }}</p>
    <div v-if="row.actions.length" class="flex flex-wrap items-center gap-1.5">
      <SyncChainActionButton
        v-for="action in row.actions"
        :key="action.id"
        :action="action"
        :busy="isBusy(action.id)"
        :disabled="busy !== null || panelBusy"
        keep-focus
        @action="handleAction"
      />
    </div>
  </div>
</template>
