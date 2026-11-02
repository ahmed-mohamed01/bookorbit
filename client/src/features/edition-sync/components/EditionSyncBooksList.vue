<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Loader2, Play, RefreshCw, Search } from '@lucide/vue'
import { EDITION_SYNC_BOOK_LIST_FILTERS, type EditionSyncBookListFilter, type EditionSyncBookListItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useCoverVersions } from '@/features/book/composables/useCoverVersions'
import { formatKeyCode } from '@/features/book/lib/book-formats'
import { SYNC_STATUS_TEXT_CLASS, type SyncIssueAction, type SyncStatus } from '@/lib/sync-issue'
import { formatDate, formatNumber } from '@/i18n/formatters'
import { EDITION_SYNC_BOOKS_QUERY_MAX_LENGTH, useEditionSyncBooks } from '../composables/useEditionSyncBooks'
import { indexStatus } from '../lib/header-status'

const { t } = useI18n()
const { coverUrl } = useCoverVersions()
const books = useEditionSyncBooks()

const searchId = 'edition-sync-books-search'
const statusIdPrefix = useId()
const failedCovers = ref(new Set<number>())

onMounted(() => {
  void books.load()
})

defineExpose({ load: books.load })

interface RowView {
  item: EditionSyncBookListItem
  status: SyncStatus
  detail: string | null
  action: SyncIssueAction | null
}

function rowView(item: EditionSyncBookListItem): RowView {
  const status = indexStatus(
    {
      status: item.status,
      stage: item.stage,
      progress: item.progress,
      queuePosition: null,
      error: item.error,
      whisperFallback: item.whisperFallback,
      canRunNow: item.canRunNow,
      canRetry: item.canRetry,
      startingSoon: false,
      when: null,
    },
    books.pendingIds.value.has(item.bookId),
    t,
  )
  let detail = status.issue?.detail ?? null
  if (item.status === 'off') detail = t('editionSync.books.offDetail')
  else if (item.status === 'ready' && !item.whisperFallback && item.indexedAt) {
    detail = t('editionSync.books.indexedOn', { date: formatDate(new Date(item.indexedAt), { day: 'numeric', month: 'short', year: 'numeric' }) })
  }
  return { item, status, detail, action: status.issue?.actions[0] ?? null }
}

const rows = computed(() => books.items.value.map(rowView))

function statusId(item: EditionSyncBookListItem): string {
  return `${statusIdPrefix}-status-${item.bookId}`
}

function formatsLine(item: EditionSyncBookListItem): string {
  return item.formats.map(formatKeyCode).join(' · ')
}

function coverSrc(item: EditionSyncBookListItem): string {
  return coverUrl(item.bookId, 'thumbnail', item.coverVersion)
}

function bookRoute(item: EditionSyncBookListItem) {
  return { name: 'book-detail', params: { bookId: item.bookId } }
}

function filterLabel(filter: EditionSyncBookListFilter): string {
  return t(`editionSync.books.filters.${filter}`)
}

function filterCount(filter: EditionSyncBookListFilter): string | null {
  const count = books.counts.value?.[filter]
  return count === undefined ? null : formatNumber(count)
}

function handleFilter(filter: EditionSyncBookListFilter) {
  books.setFilter(filter)
}

function handleSearch(event: Event) {
  books.setQuery((event.target as HTMLInputElement).value)
}

function handleCoverError(item: EditionSyncBookListItem) {
  failedCovers.value = new Set(failedCovers.value).add(item.bookId)
}

function handleRowAction(row: RowView) {
  if (row.action?.id === 'retry') void books.retry(row.item.bookId)
  else if (row.action?.id === 'run') void books.runNow(row.item.bookId)
}

function handleToggle(item: EditionSyncBookListItem, value: boolean) {
  void books.setSyncEnabled(item.bookId, value)
}

function handlePrevious() {
  books.previousPage()
}

function handleNext() {
  books.nextPage()
}

function handleRetryLoad() {
  void books.load()
}
</script>

<template>
  <section class="space-y-3 border-t border-border pt-4" :aria-label="t('editionSync.books.title')" data-testid="edition-sync-books">
    <div>
      <p class="text-sm font-medium">{{ t('editionSync.books.title') }}</p>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ t('editionSync.books.description') }}</p>
    </div>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="flex flex-wrap gap-1.5" role="group" :aria-label="t('editionSync.books.filterLabel')">
        <button
          v-for="filter in EDITION_SYNC_BOOK_LIST_FILTERS"
          :key="filter"
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors"
          :class="
            books.filter.value === filter
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          "
          :aria-pressed="books.filter.value === filter"
          :data-filter="filter"
          data-testid="edition-sync-books-filter"
          @click="handleFilter(filter)"
        >
          {{ filterLabel(filter) }}
          <span v-if="filterCount(filter) !== null" class="tabular-nums">{{ filterCount(filter) }}</span>
        </button>
      </div>
      <div class="relative sm:ms-auto sm:w-60">
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

    <p v-if="books.disabledReason.value === 'user_disabled'" class="text-xs text-muted-foreground" data-testid="edition-sync-books-user-off">
      {{ t('editionSync.books.userDisabled') }}
    </p>

    <div v-if="books.error.value" class="flex items-center gap-2 text-xs text-destructive" role="alert" data-testid="edition-sync-books-error">
      <span>{{ books.error.value }}</span>
      <Button type="button" variant="outline" size="sm" class="h-7 text-xs" @click="handleRetryLoad">{{ t('editionSync.books.retryLoad') }}</Button>
    </div>

    <div class="overflow-hidden rounded-lg border border-border" :aria-busy="books.loading.value">
      <div v-if="!books.loaded.value && books.loading.value" class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
        {{ t('editionSync.books.loading') }}
      </div>
      <p v-else-if="books.items.value.length === 0" class="py-8 text-center text-xs text-muted-foreground" data-testid="edition-sync-books-empty">
        {{ t('editionSync.books.empty') }}
      </p>
      <ul v-else class="divide-y divide-border">
        <li
          v-for="row in rows"
          :key="row.item.bookId"
          class="flex items-center gap-3 px-3 py-2.5"
          :data-status="row.item.status"
          data-testid="edition-sync-books-row"
        >
          <span class="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
            <img
              v-if="!failedCovers.has(row.item.bookId)"
              :src="coverSrc(row.item)"
              alt=""
              loading="lazy"
              class="size-full object-cover"
              @error="handleCoverError(row.item)"
            />
            <BookOpen v-else class="size-4" aria-hidden="true" />
          </span>

          <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
            <div class="min-w-0 flex-1">
              <RouterLink
                :to="bookRoute(row.item)"
                class="block truncate text-sm font-medium text-foreground hover:underline"
                :title="row.item.title"
              >
                {{ row.item.title }}
              </RouterLink>
              <p class="truncate text-xs text-muted-foreground">{{ formatsLine(row.item) }}</p>
            </div>
            <div class="flex min-w-0 flex-col sm:w-56 sm:items-end sm:text-right">
              <span class="flex min-w-0 items-center gap-1 text-xs font-semibold" :class="SYNC_STATUS_TEXT_CLASS[row.status.tone]">
                <Loader2 v-if="row.status.spinner" class="size-3 shrink-0 animate-spin" aria-hidden="true" />
                <span :id="statusId(row.item)" class="truncate" data-testid="edition-sync-books-status">{{ row.status.text }}</span>
              </span>
              <span
                v-if="row.detail"
                class="max-w-full truncate text-xs text-muted-foreground"
                :title="row.detail ?? undefined"
                data-testid="edition-sync-books-detail"
              >
                {{ row.detail }}
              </span>
            </div>
          </div>

          <span class="flex size-7 shrink-0 items-center justify-center">
            <Button
              v-if="row.action"
              type="button"
              variant="outline"
              size="icon-sm"
              class="size-7"
              :disabled="books.pendingIds.value.has(row.item.bookId)"
              :aria-label="row.action.label"
              :title="row.action.label"
              :data-action="row.action.id"
              data-testid="edition-sync-books-action"
              @click="handleRowAction(row)"
            >
              <RefreshCw v-if="row.action.id === 'retry'" class="size-3.5" aria-hidden="true" />
              <Play v-else class="size-3.5" aria-hidden="true" />
            </Button>
          </span>
          <ToggleSwitch
            :model-value="books.toggleValue(row.item)"
            :disabled="!books.canToggle(row.item)"
            :aria-label="t('editionSync.books.toggle', { title: row.item.title })"
            :aria-describedby="statusId(row.item)"
            data-testid="edition-sync-books-toggle"
            @update:model-value="handleToggle(row.item, $event)"
          />
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
