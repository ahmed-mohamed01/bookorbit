<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Library } from '@lucide/vue'
import { Permission, type AudiobookshelfBookState, type BookDetail } from '@bookorbit/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'
import { useAudiobookshelfSyncActions } from '@/features/book/composables/useAudiobookshelfSyncActions'
import { useAudiobookshelfSyncLink } from '@/features/book/composables/useAudiobookshelfSyncLink'
import { absDirectionExplain, buildAbsSyncRow, type AbsRowActionId } from '@/features/book/lib/abs-sync-row'
import { displayPercentage } from '@/features/book/lib/abs-sync-status'
import { bookFormatEntries } from '@/features/book/lib/book-formats'
import { SYNC_STATUS_TEXT_CLASS, type SyncIssueAction } from '@/lib/sync-issue'
import AudiobookshelfMatchSearch from './AudiobookshelfMatchSearch.vue'
import SyncIssueMenu from '@/components/sync/SyncIssueMenu.vue'

const props = defineProps<{ book: BookDetail }>()

const ROW = 'book.detail.editionLink.abs.row.'
const ABS_SETTINGS_ROUTE = { name: 'settings-audiobookshelf' }

const { t } = useI18n()
const { hasPermission } = usePermissions()

const canSync = computed(() => hasPermission(Permission.AudiobookshelfSync))
const hasAudio = computed(() => bookFormatEntries(props.book.files, props.book.formatPriority).some((entry) => entry.audio))
// The match is read only once the integration is known to be on, so an unconfigured server costs no request.
const configuredKnown = ref(false)
const audioBookId = computed(() => (configuredKnown.value && canSync.value && hasAudio.value ? props.book.id : null))

const abs = useAudiobookshelfSyncLink(audioBookId)
const actions = useAudiobookshelfSyncActions(abs, () => audioBookId.value)

const visible = computed(() => audioBookId.value !== null && abs.configured.value)
const row = computed(() => buildAbsSyncRow({ link: abs.link.value, live: abs.live.value }, t))
const busy = computed(() => actions.busy.value !== null)

let configuredRequested = false

async function loadConfiguredOnce(): Promise<void> {
  if (configuredRequested) return
  configuredRequested = true
  await abs.loadConfigured()
  configuredKnown.value = abs.configured.value
}

function handleGateChange([allowed, audio]: [boolean, boolean]) {
  if (allowed && audio) void loadConfiguredOnce()
}

watch([canSync, hasAudio], handleGateChange, { immediate: true })

const statusId = useId()

watch(actions.actionError, (message) => {
  if (message) toast.error(message)
})

/* The dropdown: the problem, the matched item's details, or the match search. */

const menuOpen = ref(false)
const searching = ref(false)

const menuTitle = computed(() => {
  if (searching.value || row.value.state === 'notMatched') return t(`${ROW}search.title`)
  return row.value.status.issue?.title ?? row.value.status.text
})

const menuDetail = computed(() => {
  if (searching.value || row.value.state === 'notMatched') return null
  if (row.value.status.issue) return row.value.status.issue.detail
  const hint = row.value.state === 'receiving' ? row.value.statusTitle : null
  return hint ?? (abs.link.value ? absDirectionExplain(abs.link.value, t) : null)
})

const menuActions = computed<SyncIssueAction<AbsRowActionId>[]>(() => {
  if (searching.value || row.value.state === 'notMatched') return []
  if (row.value.status.issue) return row.value.status.issue.actions
  return [...row.value.detailActions, { id: 'change', label: t(`${ROW}action.change`), keepOpen: true }]
})

const showSearch = computed(() => searching.value || row.value.state === 'notMatched')
const showItem = computed(() => !showSearch.value && row.value.details && abs.link.value !== null)

const linkedItem = computed(() => {
  const link = abs.link.value
  if (!link) return null
  const progress = abs.live.value?.progress
  return {
    title: link.title || t('book.detail.editionLink.unknownTitle'),
    library: link.libraryName ? t('book.detail.editionLink.abs.library', { name: link.libraryName }) : null,
    href: link.webUrl,
    cover: audiobookshelfCoverUrl(link.absLibraryItemId),
    progress: progress ? displayPercentage(progress.percentage, progress.isFinished) : null,
  }
})
const itemCoverFailed = ref(false)
watch(
  () => abs.link.value?.absLibraryItemId,
  () => {
    itemCoverFailed.value = false
  },
)

function handleItemCoverError() {
  itemCoverFailed.value = true
}

function startSearch() {
  searching.value = true
  actions.search.reset()
  actions.search.setQuery('')
}

function handleMenuOpen(value: boolean) {
  menuOpen.value = value
  if (value) {
    if (row.value.state === 'notMatched') startSearch()
    return
  }
  searching.value = false
  actions.search.reset()
}

const ACTIONS: Record<AbsRowActionId, () => void> = {
  confirm: () => void actions.confirm(),
  change: startSearch,
  pull: () => void actions.reconcile('pull'),
  push: () => void actions.reconcile('push'),
  retry: () => void actions.retry(),
}

function handleMenuAction(id: AbsRowActionId) {
  ACTIONS[id]()
}

function handleSearchQuery(value: string) {
  actions.search.setQuery(value)
}

async function handlePick(item: AudiobookshelfBookState) {
  if (await actions.change(item)) handleMenuOpen(false)
}

/* The switch. */

const pauseOpen = ref(false)
const pausing = ref(false)

function handleToggle(next: boolean) {
  const toggle = row.value.toggle
  if (toggle.disabled || busy.value || next === toggle.on) return
  switch (toggle.action) {
    case 'match':
      handleMenuOpen(true)
      return
    case 'resume':
      void actions.resume()
      return
    case 'confirm':
      void actions.confirm()
      return
    case 'pause':
      pauseOpen.value = true
      return
  }
}

async function handleConfirmPause() {
  if (pausing.value) return
  pausing.value = true
  try {
    await actions.pause()
  } finally {
    pausing.value = false
    pauseOpen.value = false
  }
}

function handleCancelPause() {
  if (!pausing.value) pauseOpen.value = false
}
</script>

<template>
  <div v-if="visible" class="min-w-0 border-b border-border py-[6px] last:border-b-0" :data-state="row.state" data-testid="abs-sync-row">
    <dt class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{{ t(`${ROW}label`) }}</dt>
    <dd class="mt-0.5 flex min-w-0 items-center gap-2">
      <ToggleSwitch
        :model-value="row.toggle.on"
        :disabled="row.toggle.disabled || busy"
        :aria-label="t(`${ROW}toggle`)"
        :aria-describedby="statusId"
        data-testid="abs-sync-toggle"
        @update:model-value="handleToggle"
      />
      <span
        v-if="row.status.issue"
        :id="statusId"
        class="min-w-0 truncate text-sm"
        :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]"
        data-testid="abs-sync-status-text"
      >
        {{ row.status.text }}
      </span>
      <SyncIssueMenu
        :open="menuOpen"
        :tone="row.status.issue?.tone ?? 'info'"
        :icon="row.status.issue?.icon ?? 'alert'"
        :title="menuTitle"
        :detail="menuDetail"
        :actions="menuActions"
        :busy="busy"
        :label="row.status.issue?.title ?? row.status.text"
        @update:open="handleMenuOpen"
        @action="handleMenuAction"
      >
        <template v-if="!row.status.issue" #trigger>
          <button
            :id="statusId"
            type="button"
            class="min-w-0 truncate rounded-xs text-sm hover:underline"
            :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]"
            :title="row.statusTitle ?? undefined"
            data-testid="abs-sync-status"
          >
            {{ row.status.text }}
          </button>
        </template>

        <div v-if="showItem && linkedItem" class="mt-2.5 flex items-center gap-2.5 rounded-lg border border-border p-2" data-testid="abs-sync-item">
          <span class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
            <img v-if="!itemCoverFailed" :src="linkedItem.cover" alt="" loading="lazy" class="size-full object-cover" @error="handleItemCoverError" />
            <Library v-else class="size-4" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <a
              v-if="linkedItem.href"
              :href="linkedItem.href"
              target="_blank"
              rel="noopener noreferrer"
              class="block truncate text-sm font-medium text-foreground hover:underline"
              data-testid="abs-sync-item-link"
            >
              {{ linkedItem.title }}
              <span class="sr-only">{{ t('book.detail.editionLink.abs.opensNewTab') }}</span>
            </a>
            <span v-else class="block truncate text-sm font-medium text-foreground">{{ linkedItem.title }}</span>
            <span class="flex items-center gap-2 text-xs text-muted-foreground">
              <span v-if="linkedItem.library" class="min-w-0 truncate">{{ linkedItem.library }}</span>
              <span v-if="linkedItem.progress !== null" class="ms-auto shrink-0 tabular-nums" data-testid="abs-sync-item-progress">
                {{ t('book.detail.editionLink.progressListened', { percentage: linkedItem.progress }) }}
              </span>
            </span>
          </span>
        </div>

        <AudiobookshelfMatchSearch
          v-if="showSearch"
          :query="actions.search.query.value"
          :results="actions.search.results.value"
          :searching="actions.search.searching.value"
          :search-error="actions.search.searchError.value"
          :has-searched="actions.search.hasSearched.value"
          :disabled="busy"
          @update:query="handleSearchQuery"
          @pick="handlePick"
        />

        <p v-if="row.settingsLink" class="mt-2 text-xs">
          <RouterLink :to="ABS_SETTINGS_ROUTE" class="font-semibold text-info hover:underline" data-testid="abs-sync-settings">
            {{ t(`${ROW}settings`) }}
          </RouterLink>
        </p>
      </SyncIssueMenu>
    </dd>
    <ConfirmDialog
      :open="pauseOpen"
      :title="t(`${ROW}confirmPause.title`)"
      :description="t(`${ROW}confirmPause.description`)"
      :confirm-label="t(`${ROW}confirmPause.confirm`)"
      :destructive="true"
      :busy="pausing"
      @confirm="handleConfirmPause"
      @cancel="handleCancelPause"
    />
  </div>
</template>
