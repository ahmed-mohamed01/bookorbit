<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import type { BookDetail, EditionSyncBookState } from '@bookorbit/types'
import SyncIssueMenu from '@/components/sync/SyncIssueMenu.vue'
import { SYNC_STATUS_TEXT_CLASS } from '@/lib/sync-issue'
import { headerStatus, type EditionSyncStatusActionId } from '../lib/header-status'
import { describeNextRun } from '../lib/next-run'
import { readAlongEditions, type EditionSyncToggleKind } from '../lib/toggle-plan'

const props = withDefaults(
  defineProps<{
    book: BookDetail
    kind: EditionSyncToggleKind
    state: EditionSyncBookState | null
    checked: boolean
    acting?: boolean
    /** Put on whichever element names the status, for the switch's aria-describedby. */
    describedById?: string
  }>(),
  { acting: false, describedById: undefined },
)
const emit = defineEmits<{ run: []; retry: [] }>()

const { t } = useI18n()

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '-'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? t('book.detail.details.durationHm', { hours, minutes }) : t('book.detail.details.durationM', { minutes })
}

function nextRunText(iso: string | null): string | null {
  if (!iso) return null
  const label = describeNextRun(iso)
  return label.day === 'later'
    ? t('editionSync.status.when.later', { date: label.date, time: label.time })
    : t(`editionSync.status.when.${label.day}`, { time: label.time })
}

const editions = computed(() => readAlongEditions(props.book.files, props.book.formatPriority))

const status = computed(() => {
  const state = props.state
  const sync = props.book.readAloudSync
  return headerStatus(
    {
      kind: props.kind,
      checked: props.checked,
      acting: props.acting,
      index: state
        ? {
            status: state.index.status,
            stage: state.index.stage,
            progress: state.index.progress,
            queuePosition: state.index.queuePosition,
            error: state.index.error,
            whisperFallback: state.index.whisperFallback,
            canRunNow: state.canRunNow,
            canRetry: state.canRetry,
            startingSoon: state.pinned || state.runActive,
            when: nextRunText(state.index.nextRunAt),
          }
        : null,
      readAlong: {
        sync,
        audioDuration: formatDuration(sync.audioDurationSeconds),
        overlayDuration: formatDuration(sync.overlayDurationSeconds),
        hasEpubCopy: editions.value.hasEpubCopy,
        hasAudio: editions.value.hasAudio,
      },
    },
    t,
  )
})

function handleAction(id: EditionSyncStatusActionId) {
  if (id === 'retry') emit('retry')
  else emit('run')
}
</script>

<template>
  <div v-if="status" class="flex min-w-0 items-center gap-1.5" data-testid="edition-sync-header-status">
    <Loader2 v-if="status.spinner" class="size-3 shrink-0 animate-spin" :class="SYNC_STATUS_TEXT_CLASS[status.tone]" aria-hidden="true" />
    <span
      :id="describedById"
      class="min-w-0 truncate text-xs font-semibold whitespace-nowrap"
      :class="SYNC_STATUS_TEXT_CLASS[status.tone]"
      :title="status.text"
      data-testid="edition-sync-header-text"
    >
      {{ status.text }}
    </span>
    <SyncIssueMenu
      v-if="status.issue"
      :tone="status.issue.tone"
      :icon="status.issue.icon"
      :title="status.issue.title"
      :detail="status.issue.detail"
      :actions="status.issue.actions"
      :busy="acting"
      @action="handleAction"
    />
  </div>
</template>
