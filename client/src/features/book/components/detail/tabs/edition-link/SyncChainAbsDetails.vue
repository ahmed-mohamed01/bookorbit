<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AudiobookshelfBookSyncLive } from '@bookorbit/types'
import type { AbsSyncBusy } from '@/features/book/composables/useAudiobookshelfSyncActions'
import { ABS_RECONCILE_ACTIONS, absConnectorHint, isAbsReconcileAction } from '@/features/book/lib/abs-sync-status'
import type { ChainActionId, ChainConnectorRow } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import SyncChainActionButton from './SyncChainActionButton.vue'

const props = withDefaults(
  defineProps<{ row: ChainConnectorRow; live: AudiobookshelfBookSyncLive | null; busy?: AbsSyncBusy | null; actionError?: string | null }>(),
  { busy: null, actionError: null },
)
const emit = defineEmits<{ action: [id: ChainActionId] }>()

const { t } = useI18n()

const settingsRoute = { name: 'settings-audiobookshelf' }

const hint = computed(() => absConnectorHint(props.row.state, props.live, props.row.note ? chainText(props.row.note, t) : null, t))

function isBusy(id: ChainActionId): boolean {
  return isAbsReconcileAction(id) && props.busy === ABS_RECONCILE_ACTIONS[id]
}

function handleAction(id: ChainActionId) {
  emit('action', id)
}
</script>

<template>
  <div class="flex flex-col gap-1.5 text-xs text-pretty text-muted-foreground" :data-state="row.state" data-testid="sync-chain-abs-details">
    <p v-if="hint" data-testid="sync-chain-abs-hint">{{ hint }}</p>
    <p v-if="actionError" class="text-destructive" role="status" data-testid="sync-chain-abs-error">{{ actionError }}</p>
    <div v-if="row.actions.length || row.settingsLink" class="flex flex-wrap items-center gap-1.5">
      <SyncChainActionButton
        v-for="action in row.actions"
        :key="action.id"
        :action="action"
        :busy="isBusy(action.id)"
        :disabled="busy !== null"
        @action="handleAction"
      />
      <RouterLink
        v-if="row.settingsLink"
        :to="settingsRoute"
        class="px-0.5 text-xs font-semibold text-info hover:underline"
        data-testid="sync-chain-abs-settings"
      >
        {{ t('book.detail.editionLink.abs.settings') }}
      </RouterLink>
    </div>
  </div>
</template>
