<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Loader2, SlidersHorizontal, Sparkles } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { buildReadAloudRow, type ReadAloudCreateSlot, type ReadAloudRowActionId } from '@/features/book/lib/read-aloud-row'
import SyncIssueMenu from '@/components/sync/SyncIssueMenu.vue'
import { SYNC_STATUS_TEXT_CLASS } from '@/lib/sync-issue'

// Fork: `viaIndex` when the book has no read-along EPUB but its timing index reads along anyway.
const props = defineProps<{ state: ReadAloudCreateSlot; viaIndex?: boolean }>()
/** `create` starts with the default settings; `options` opens the dialog to change them first. */
const emit = defineEmits<{ create: []; options: []; cancel: []; retry: []; review: [] }>()

const { t } = useI18n()

const row = computed(() => buildReadAloudRow(props.state, t))
const locked = computed(() => row.value?.pending != null)
// Fork: says the read-along works from the index, unless a job or an error has more to say.
const indexStatus = computed(() => {
  const current = row.value
  if (!props.viaIndex) return false
  if (!current) return true
  if (current.variant !== 'notCreated' && current.variant !== 'unavailable') return false
  return current.status.tone !== 'destructive' && current.status.issue?.tone !== 'destructive'
})
// The chip already says what is missing, so an untouched row shows only its Create link.
const showStatus = computed(() => !indexStatus.value && row.value !== null && (row.value.variant !== 'notCreated' || row.value.status.issue !== null))

function handleCreate() {
  emit('create')
}

function handleOptions() {
  emit('options')
}

function handleReview() {
  emit('review')
}

function handleMenuAction(id: ReadAloudRowActionId) {
  if (id === 'cancel') emit('cancel')
  else if (id === 'retry') emit('retry')
  else emit('review')
}
</script>

<template>
  <li
    v-if="row || indexStatus"
    class="flex min-h-7 items-center gap-2.5"
    :data-variant="indexStatus ? 'viaIndex' : row?.variant"
    data-testid="editions-read-aloud-row"
  >
    <span
      class="inline-flex h-5 min-w-13 shrink-0 items-center justify-center rounded-md border border-dashed border-primary px-1.5 text-[10px] leading-none font-bold tracking-wider text-primary uppercase"
      :class="indexStatus ? 'bg-primary/15' : 'bg-transparent'"
      data-testid="editions-read-aloud-chip"
    >
      {{ t('book.detail.editionLink.readAloud.chip') }}
    </span>

    <span class="flex min-w-0 flex-1 items-center gap-1.5">
      <span
        v-if="indexStatus"
        class="min-w-0 truncate text-[11px] text-muted-foreground"
        :title="t('book.detail.editionLink.readAloud.viaIndexHint')"
        data-testid="editions-read-aloud-via-index"
      >
        {{ t('book.detail.editionLink.readAloud.viaIndex') }}
      </span>
      <template v-if="row && showStatus">
        <Loader2 v-if="row.status.spinner" class="size-3 shrink-0 animate-spin" :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]" aria-hidden="true" />
        <span
          class="min-w-0 truncate text-[11px]"
          :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]"
          :title="row.status.text"
          data-testid="editions-read-aloud-status"
        >
          {{ row.status.text }}
        </span>
        <SyncIssueMenu
          v-if="row.status.issue"
          :tone="row.status.issue.tone"
          :icon="row.status.issue.icon"
          :title="row.status.issue.title"
          :detail="row.status.issue.detail"
          :actions="row.status.issue.actions"
          :busy="locked"
          @action="handleMenuAction"
        />
      </template>
    </span>

    <div
      v-if="row?.create"
      class="inline-flex h-6 shrink-0 items-stretch rounded-md border border-border text-[11px] font-medium text-muted-foreground"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-l-md px-1.5 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        :disabled="locked"
        data-testid="editions-read-aloud-create"
        @click="handleCreate"
      >
        <Loader2 v-if="row?.pending === 'create'" class="size-3 animate-spin" aria-hidden="true" />
        <Sparkles v-else class="size-3 text-primary" aria-hidden="true" />
        {{ t('book.detail.editionLink.readAloud.create') }}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="inline-flex items-center rounded-r-md border-l border-border px-1 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            :disabled="locked"
            :aria-label="t('book.detail.editionLink.readAloud.moreOptions')"
            data-testid="editions-read-aloud-more"
          >
            <ChevronDown class="size-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="editions-read-aloud-options" @select="handleOptions">
            <SlidersHorizontal class="size-3.5" aria-hidden="true" />
            {{ t('book.detail.editionLink.readAloud.options') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <Button
      v-if="row?.review"
      type="button"
      variant="outline"
      size="sm"
      class="h-7 px-2 text-xs"
      :disabled="locked"
      data-testid="editions-read-aloud-review"
      @click="handleReview"
    >
      {{ t('book.detail.editionLink.readAloud.review') }}
    </Button>
  </li>
</template>
