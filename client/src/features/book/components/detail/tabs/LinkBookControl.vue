<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link2 } from '@lucide/vue'
import type { AudiobookshelfBookSyncLive, BookDetail } from '@bookorbit/types'
import { canRebuildReadAlong } from '@/features/book/lib/read-along-section'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAudiobookshelfSyncLink } from '@/features/book/composables/useAudiobookshelfSyncLink'
import { useLinkEditionPanel, type EditionFilledSlot } from '@/features/book/composables/useLinkEditionPanel'
import LinkEditionPanel from './edition-link/LinkEditionPanel.vue'

const props = withDefaults(defineProps<{ book: BookDetail; triggerClass?: string }>(), {
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})

const { t } = useI18n()

const panel = reactive(useLinkEditionPanel(() => props.book))

// Looked up with the page rather than when the popover opens, so the Audiobookshelf stop renders
// together with the other editions; opening only refreshes its live status.
const audioBookId = computed(
  () => panel.slots.find((slot): slot is EditionFilledSlot => slot.kind === 'filled' && slot.format === 'audiobook')?.bookId ?? null,
)
const abs = useAudiobookshelfSyncLink(audioBookId)

onMounted(() => {
  if (panel.isEligible) void panel.loadInitial()
})

const open = ref(false)

const readAlongRebuildRequested = ref(false)

function handleOpenChange(next: boolean) {
  open.value = next
  if (!next) {
    readAlongRebuildRequested.value = false
    return
  }
  void panel.handleOpen()
  abs.refreshLive()
}

function handleRefreshAbsLive(live?: AudiobookshelfBookSyncLive) {
  if (live) abs.applyLive(live)
  else abs.refreshLive()
}

function handleReadAlongRebuildRequestHandled() {
  readAlongRebuildRequested.value = false
}

// The same check the panel's own rebuild button uses, so the page never offers a rebuild the panel refuses.
const canRequestReadAlongRebuild = computed(() => panel.isEligible && canRebuildReadAlong(panel))

/** Opens the panel on its read-along rebuild confirm, for a rebuild offered elsewhere on the page. */
function requestReadAlongRebuild() {
  if (!canRequestReadAlongRebuild.value) return
  readAlongRebuildRequested.value = true
  if (!open.value) handleOpenChange(true)
}

defineExpose({ canRequestReadAlongRebuild, requestReadAlongRebuild })

// The header's first control rebuilds position sync, so opening the panel keeps focus off it: a stray
// Enter right after opening must not start an alignment.
function handleOpenAutoFocus(event: Event) {
  event.preventDefault()
}
</script>

<template>
  <Popover v-if="panel.isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button type="button" :class="triggerClass" :title="panel.triggerTooltip" :aria-label="t('book.detail.editionLink.trigger')">
        <Link2 class="size-3.5" :class="panel.triggerIconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="max-h-(--reka-popover-content-available-height) w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-2 sm:w-[20rem]"
      @open-auto-focus="handleOpenAutoFocus"
    >
      <LinkEditionPanel
        :panel="panel"
        :abs-link="abs.link.value"
        :abs-live="abs.live.value"
        :abs-checking="abs.checking.value"
        :read-aloud-sync="book.readAloudSync"
        :read-along-rebuild-requested="readAlongRebuildRequested"
        @refresh-abs-live="handleRefreshAbsLive"
        @read-along-rebuild-request-handled="handleReadAlongRebuildRequestHandled"
      />
    </PopoverContent>
  </Popover>
</template>
