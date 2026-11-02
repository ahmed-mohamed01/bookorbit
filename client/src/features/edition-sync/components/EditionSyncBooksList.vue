<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ChevronDown, ChevronUp, Loader2, RefreshCw, Search } from '@lucide/vue'
import type { EditionSyncBookListFilter, EditionSyncBookListItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatKeyCode } from '@/features/book/lib/book-formats'
import { SYNC_STATUS_TEXT_CLASS } from '@/lib/sync-issue'
import { formatNumber } from '@/i18n/formatters'
import { EDITION_SYNC_BOOKS_QUERY_MAX_LENGTH, useEditionSyncBooks } from '../composables/useEditionSyncBooks'
import { useEditionSyncSettings } from '../composables/useEditionSyncSettings'
import { bookRowView, type BookRowAction } from '../lib/book-row'
import EditionSyncBookCover from './EditionSyncBookCover.vue'

const props = defineProps<{ runActive?: boolean }>()

const { t } = useI18n()
const { settings } = useEditionSyncSettings()
const books = useEditionSyncBooks({ runActive: () => props.runActive === true })

const TABS: EditionSyncBookListFilter[] = ['problems', 'queued', 'synced', 'off', 'all']
const searchId = 'edition-sync-books-search'
const idPrefix = useId()
const expandedId = ref<number | null>(null)

onMounted(() => {
  void books.load()
})

defineExpose({ load: books.load })

const onQueueTab = computed(() => books.filter.value === 'queued')
const problemsCount = computed(() => books.counts.value?.problems ?? 0)
const showRetryAll = computed(
  () =>
    books.filter.value === 'problems' &&
    problemsCount.value > 0 &&
    books.disabledReason.value !== 'user_disabled' &&
    books.disabledReason.value !== 'server_disabled',
)

const rows = computed(() =>
  books.items.value.map((item) =>
    bookRowView(
      item,
      {
        bookSyncMode: settings.value?.bookSyncMode ?? 'all_eligible',
        disabledReason: books.disabledReason.value,
        onQueueTab: onQueueTab.value,
        pending: books.pendingIds.value.has(item.bookId),
        detailsPending: books.detailsPendingIds.value.has(item.bookId),
        toggleOn: books.toggleValue(item),
        canToggle: books.canToggle(item),
      },
      t,
    ),
  ),
)

function panelId(item: EditionSyncBookListItem): string {
  return `${idPrefix}-panel-${item.bookId}`
}

function formatsLine(item: EditionSyncBookListItem): string {
  return item.formats.map(formatKeyCode).join(' · ')
}

function bookRoute(item: EditionSyncBookListItem) {
  return { name: 'book-detail', params: { bookId: item.bookId } }
}

function queueNumber(item: EditionSyncBookListItem): string {
  return item.status !== 'running' && item.queuePosition !== null ? formatNumber(item.queuePosition) : ''
}

function tabCount(filter: EditionSyncBookListFilter): string | null {
  const count = books.counts.value?.[filter]
  return count === undefined ? null : formatNumber(count)
}

function handleTab(filter: EditionSyncBookListFilter) {
  expandedId.value = null
  books.setFilter(filter)
}

function handleSearch(event: Event) {
  books.setQuery((event.target as HTMLInputElement).value)
}

function handleToggleExpanded(item: EditionSyncBookListItem) {
  expandedId.value = expandedId.value === item.bookId ? null : item.bookId
}

function handleRowAction(item: EditionSyncBookListItem, action: BookRowAction) {
  if (action.id === 'retry') void books.retry(item.bookId)
  else if (action.id === 'run') void books.runNow(item.bookId)
  else void books.setSyncEnabled(item.bookId, !books.toggleValue(item))
}

function handleRetryAllFailed() {
  void books.retryAllFailed()
}

function handlePrevious() {
  expandedId.value = null
  books.previousPage()
}

function handleNext() {
  expandedId.value = null
  books.nextPage()
}

function handleRetryLoad() {
  void books.load()
}
</script>

<template>
  <section
    class="space-y-3 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5"
    :aria-label="t('editionSync.books.title')"
    data-testid="edition-sync-books"
  >
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm font-medium">{{ t('editionSync.books.title') }}</p>
      <div class="relative sm:w-60">
        <label :for="searchId" class="sr-only">{{ t('editionSync.books.search') }}</label>
        <Search class="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          :id="searchId"
          type="search"
          :value="books.query.value"
          :placeholder="t('editionSync.books.search')"
          :maxlength="EDITION_SYNC_BOOKS_QUERY_MAX_LENGTH"
          class="h-8 w-full rounded-md border border-input bg-background ps-8 pe-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="edition-sync-books-search"
          @input="handleSearch"
        />
      </div>
    </div>

    <div class="-mx-1 flex gap-4 overflow-x-auto border-b border-border px-1" role="tablist" :aria-label="t('editionSync.books.filterLabel')">
      <button
        v-for="tab in TABS"
        :key="tab"
        type="button"
        role="tab"
        class="-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 pb-2 pt-1 text-xs font-medium transition-colors"
        :class="books.filter.value === tab ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        :aria-selected="books.filter.value === tab"
        :data-filter="tab"
        data-testid="edition-sync-books-filter"
        @click="handleTab(tab)"
      >
        {{ t(`editionSync.books.filters.${tab}`) }}
        <span v-if="tabCount(tab) !== null" class="tabular-nums text-muted-foreground">{{ tabCount(tab) }}</span>
      </button>
    </div>

    <p v-if="books.disabledReason.value === 'user_disabled'" class="text-xs text-muted-foreground" data-testid="edition-sync-books-user-off">
      {{ t('editionSync.books.userDisabled') }}
    </p>

    <div
      v-if="showRetryAll"
      class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid="edition-sync-books-problems-hint"
    >
      <p class="text-xs text-muted-foreground">{{ t('editionSync.books.problemsHint', { count: problemsCount }) }}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 shrink-0 text-xs"
        :disabled="books.retryingFailed.value"
        data-testid="edition-sync-books-retry-all"
        @click="handleRetryAllFailed"
      >
        <Loader2 v-if="books.retryingFailed.value" class="size-3.5 animate-spin" aria-hidden="true" />
        <RefreshCw v-else class="size-3.5" aria-hidden="true" />
        {{ t('editionSync.books.retryAllFailed') }}
      </Button>
    </div>
    <p v-else-if="onQueueTab && books.items.value.length > 0" class="text-xs text-muted-foreground" data-testid="edition-sync-books-queue-hint">
      {{ t('editionSync.books.queueHint') }}
    </p>

    <div v-if="books.error.value" class="flex items-center gap-2 text-xs text-destructive" role="alert" data-testid="edition-sync-books-error">
      <span>{{ books.error.value }}</span>
      <Button type="button" variant="outline" size="sm" class="h-7 text-xs" @click="handleRetryLoad">{{ t('editionSync.books.retryLoad') }}</Button>
    </div>

    <div :aria-busy="books.loading.value">
      <div v-if="!books.loaded.value && books.loading.value" class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
        {{ t('editionSync.books.loading') }}
      </div>
      <p v-else-if="books.items.value.length === 0" class="py-8 text-center text-xs text-muted-foreground" data-testid="edition-sync-books-empty">
        {{ t('editionSync.books.empty') }}
      </p>
      <ul v-else class="divide-y divide-border/60">
        <li v-for="row in rows" :key="row.item.bookId" class="py-2.5" :data-status="row.item.status" data-testid="edition-sync-books-row">
          <button
            type="button"
            class="flex w-full items-center gap-3 text-left"
            :aria-expanded="expandedId === row.item.bookId"
            :aria-controls="panelId(row.item)"
            data-testid="edition-sync-books-row-header"
            @click="handleToggleExpanded(row.item)"
          >
            <span
              v-if="onQueueTab"
              class="w-6 shrink-0 text-end text-xs tabular-nums text-muted-foreground"
              data-testid="edition-sync-books-position"
              >{{ queueNumber(row.item) }}</span
            >
            <EditionSyncBookCover :book-id="row.item.bookId" :cover-version="row.item.coverVersion" lazy />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm" :title="row.item.title">{{ row.item.title }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ formatsLine(row.item) }}</span>
            </span>
            <span class="flex max-w-[45%] shrink-0 items-center gap-2">
              <span class="flex min-w-0 items-center gap-1 text-xs" :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]">
                <Loader2 v-if="row.status.spinner" class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                <AlertCircle v-else-if="row.problem" class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="truncate" data-testid="edition-sync-books-status">{{ row.status.text }}</span>
              </span>
              <ChevronUp v-if="expandedId === row.item.bookId" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <ChevronDown v-else class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </span>
          </button>

          <div v-if="expandedId === row.item.bookId" :id="panelId(row.item)" class="mt-3 space-y-3 sm:ps-10" data-testid="edition-sync-books-panel">
            <dl v-if="row.details.length" class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <div v-for="entry in row.details" :key="entry.key" class="min-w-0" :data-detail="entry.key">
                <dt class="text-[11px] text-muted-foreground">{{ entry.label }}</dt>
                <dd class="break-words text-xs">{{ entry.value }}</dd>
              </div>
            </dl>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                v-for="action in row.actions"
                :key="action.id"
                type="button"
                :variant="action.primary ? 'default' : 'outline'"
                size="sm"
                class="h-7 text-xs"
                :disabled="action.disabled"
                :data-action="action.id"
                data-testid="edition-sync-books-action"
                @click="handleRowAction(row.item, action)"
              >
                {{ action.label }}
              </Button>
              <RouterLink
                :to="bookRoute(row.item)"
                class="ms-auto text-xs text-muted-foreground hover:text-foreground hover:underline"
                data-testid="edition-sync-books-open"
              >
                {{ t('editionSync.books.openBook') }}
              </RouterLink>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="books.range.value" class="flex items-center gap-2 text-xs text-muted-foreground">
      <span class="tabular-nums" data-testid="edition-sync-books-range">
        {{
          t('editionSync.books.range', {
            from: formatNumber(books.range.value.from),
            to: formatNumber(books.range.value.to),
            total: formatNumber(books.range.value.total),
          })
        }}
      </span>
      <div class="ms-auto flex gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="h-7 text-xs"
          :disabled="!books.hasPrevious.value || books.loading.value"
          data-testid="edition-sync-books-previous"
          @click="handlePrevious"
        >
          {{ t('editionSync.books.previous') }}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="h-7 text-xs"
          :disabled="!books.hasNext.value || books.loading.value"
          data-testid="edition-sync-books-next"
          @click="handleNext"
        >
          {{ t('editionSync.books.next') }}
        </Button>
      </div>
    </div>
  </section>
</template>
