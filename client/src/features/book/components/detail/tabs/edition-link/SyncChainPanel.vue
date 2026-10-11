<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Pencil } from '@lucide/vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { SyncChainDialogKind, SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainViewMode, EditionKey } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { chainViewItems, chainViewSegments, groupChromeClass, TONE_PILL_CLASS, transitionView } from '@/features/book/lib/sync-chain-view'
import SyncChainRow from './SyncChainRow.vue'
import { chainRowStyle } from './chain-ui'

const props = defineProps<{ panel: SyncChainPanelView }>()

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
const segments = computed(() => chainViewSegments(chainViewItems(props.panel.chain.rows, props.panel.changing)))
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

function bindCard(edition: EditionKey) {
  return (card: unknown) => {
    if (card) cards.set(edition, card as { focusChange: () => void })
    else cards.delete(edition)
  }
}

async function handleToggleView() {
  if (!view.value) return
  const next = NEXT_VIEW[view.value]
  await transitionView(() => props.panel.setViewMode(next), nextTick)
  viewToggle.value?.focus()
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
      <p class="mt-0.5 mb-1.5 text-xs text-pretty text-muted-foreground" data-testid="sync-chain-intro">{{ chainText(panel.chain.intro, t) }}</p>

      <div class="flex flex-col" data-testid="sync-chain-rows">
        <template v-for="segment in segments" :key="segment.kind === 'group' ? segment.id : segment.item.id">
          <div
            v-if="segment.kind === 'group'"
            class="rounded-xl border"
            :class="groupChromeClass(segment.items)"
            :style="chainRowStyle(segment.id)"
            data-testid="sync-chain-group"
          >
            <SyncChainRow v-for="item in segment.items" :key="item.id" :item="item" :view="view" :panel="panel" :bind-card="bindCard" />
          </div>
          <SyncChainRow v-else :item="segment.item" :view="view" :panel="panel" :bind-card="bindCard" />
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
