<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { AlertCircle, Ban, BookOpen, Check, ChevronLeft, ChevronRight, Link2, Loader2, RefreshCw, Search, Unlink } from '@lucide/vue'
import { toast } from 'vue-sonner'
import {
  searchAudiobookshelfLinkCandidates,
  type AudiobookshelfBookState,
  type AudiobookshelfBookStateBucket,
  type BookSearchOption,
} from '../api/audiobookshelf.api'
import { useAudiobookshelfLinkedBooks } from '../composables/useAudiobookshelfLinkedBooks'

const {
  pages,
  searchQuery: persistedFilterQuery,
  loading,
  bucketLoading,
  rescanning,
  error,
  bucketErrors,
  actionId,
  loadBucket,
  loadAllBuckets,
  setSearchQuery,
  confirmMatch,
  linkBook,
  unlinkBook,
  setExcluded,
  rescan,
} = useAudiobookshelfLinkedBooks()

const FILTER_DEBOUNCE_MS = 300

const activeBucket = ref<AudiobookshelfBookStateBucket>('linked')
const pickerItemId = ref<string | null>(null)
const searchQuery = ref('')
const searchResults = ref<BookSearchOption[]>([])
const selectedBook = ref<BookSearchOption | null>(null)
const searching = ref(false)
const searchError = ref<string | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchRequestId = 0

const filterQuery = ref(persistedFilterQuery.value)
let filterTimer: ReturnType<typeof setTimeout> | null = null

const buckets: Array<{ id: AudiobookshelfBookStateBucket; label: string }> = [
  { id: 'linked', label: 'Linked' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'unmatched', label: 'Unmatched' },
]

const activePage = computed(() => pages[activeBucket.value])
const activeBucketLoading = computed(() => bucketLoading[activeBucket.value])
const activeBucketError = computed(() => bucketErrors[activeBucket.value])
const totalPages = computed(() => Math.max(1, Math.ceil(activePage.value.total / activePage.value.pageSize)))
const rangeStart = computed(() => (activePage.value.total === 0 ? 0 : activePage.value.page * activePage.value.pageSize + 1))
const rangeEnd = computed(() => Math.min((activePage.value.page + 1) * activePage.value.pageSize, activePage.value.total))

onMounted(async () => {
  await loadAllBuckets()
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  searchRequestId++
  if (filterTimer) clearTimeout(filterTimer)
})

function selectBucket(bucket: AudiobookshelfBookStateBucket): void {
  activeBucket.value = bucket
  closePicker()
}

function handleFilterInput(event: Event): void {
  filterQuery.value = (event.target as HTMLInputElement).value
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => void setSearchQuery(filterQuery.value), FILTER_DEBOUNCE_MS)
}

function matchMethodLabel(method: AudiobookshelfBookState['matchMethod']): string {
  switch (method) {
    case 'asin':
      return 'ASIN'
    case 'isbn':
      return 'ISBN'
    case 'title_author_series':
      return 'Title, author, and series'
    case 'manual':
      return 'Manual'
    default:
      return 'Unknown'
  }
}

function confidenceLabel(confidence: number | null): string | null {
  if (confidence === null) return null
  const percentage = confidence <= 1 ? confidence * 100 : confidence
  return `${Math.round(percentage)}% confidence`
}

function beginManualLink(item: AudiobookshelfBookState): void {
  pickerItemId.value = item.absLibraryItemId
  searchQuery.value = ''
  searchResults.value = []
  selectedBook.value = null
  searchError.value = null
}

function closePicker(): void {
  pickerItemId.value = null
  searchQuery.value = ''
  searchResults.value = []
  selectedBook.value = null
  searchError.value = null
}

async function runSearch(query: string): Promise<void> {
  if (!query.trim()) {
    searchResults.value = []
    return
  }
  const requestId = ++searchRequestId
  searching.value = true
  searchError.value = null
  try {
    const results = await searchAudiobookshelfLinkCandidates(query.trim())
    if (requestId === searchRequestId) searchResults.value = results
  } catch (err) {
    if (requestId === searchRequestId) searchError.value = err instanceof Error ? err.message : 'Failed to search books'
  } finally {
    if (requestId === searchRequestId) searching.value = false
  }
}

function handleSearchInput(event: Event): void {
  searchQuery.value = (event.target as HTMLInputElement).value
  selectedBook.value = null
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void runSearch(searchQuery.value), 250)
}

function selectSearchResult(option: BookSearchOption): void {
  selectedBook.value = option
  searchQuery.value = option.title ?? 'Untitled'
  searchResults.value = []
}

async function handleLinkSelected(): Promise<void> {
  if (!pickerItemId.value || !selectedBook.value) {
    toast.error('Choose a BookOrbit book first')
    return
  }
  if (await linkBook(pickerItemId.value, selectedBook.value.id)) {
    toast.success('Audiobookshelf book linked')
    closePicker()
  } else {
    toast.error(error.value ?? 'Failed to link Audiobookshelf book')
  }
}

async function handleConfirm(item: AudiobookshelfBookState): Promise<void> {
  if (await confirmMatch(item.absLibraryItemId)) toast.success('Audiobookshelf match confirmed')
  else toast.error(error.value ?? 'Failed to confirm Audiobookshelf match')
}

async function handleUnlink(item: AudiobookshelfBookState): Promise<void> {
  if (await unlinkBook(item.absLibraryItemId)) toast.success('Audiobookshelf book unlinked')
  else toast.error(error.value ?? 'Failed to unlink Audiobookshelf book')
}

async function handleToggleExcluded(item: AudiobookshelfBookState): Promise<void> {
  if (await setExcluded(item.absLibraryItemId, !item.syncExcluded)) {
    toast.success(item.syncExcluded ? 'Book included in sync' : 'Book excluded from sync')
  } else {
    toast.error(error.value ?? 'Failed to update Audiobookshelf book')
  }
}

async function handleRescan(): Promise<void> {
  if (await rescan()) toast.success('Audiobookshelf match rescan completed')
  else toast.error(error.value ?? 'Failed to rescan Audiobookshelf matches')
}

async function handleRetry(): Promise<void> {
  await loadBucket(activeBucket.value)
}

async function handlePreviousPage(): Promise<void> {
  if (activePage.value.page > 0) await loadBucket(activeBucket.value, activePage.value.page - 1)
}

async function handleNextPage(): Promise<void> {
  if (activePage.value.page + 1 < totalPages.value) await loadBucket(activeBucket.value, activePage.value.page + 1)
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="text-sm font-medium">Linked books</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Review automatic matches and connect books that could not be matched.</p>
      </div>
      <button
        type="button"
        :disabled="rescanning || loading"
        class="flex items-center justify-center gap-1.5 self-start rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
        @click="handleRescan"
      >
        <Loader2 v-if="rescanning" class="size-3 animate-spin" />
        <RefreshCw v-else class="size-3" />
        Rescan matches
      </button>
    </div>

    <div class="relative">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        :value="filterQuery"
        type="search"
        placeholder="Search Audiobookshelf or BookOrbit titles and authors"
        class="w-full rounded-md border border-border bg-background py-2 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        @input="handleFilterInput"
      />
    </div>

    <div class="flex gap-1 overflow-x-auto border-b border-border">
      <button
        v-for="bucket in buckets"
        :key="bucket.id"
        type="button"
        class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors"
        :class="activeBucket === bucket.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="selectBucket(bucket.id)"
      >
        {{ bucket.label }}
        <span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ pages[bucket.id].total }}</span>
      </button>
    </div>

    <div v-if="activeBucketLoading" class="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      Loading {{ activeBucket }} books...
    </div>

    <div v-else-if="activeBucketError" class="flex flex-wrap items-center gap-2 py-3 text-xs text-destructive">
      <AlertCircle class="size-3.5" />
      {{ activeBucketError }}
      <button type="button" class="underline underline-offset-2" @click="handleRetry">Retry</button>
    </div>

    <div
      v-else-if="activePage.items.length === 0"
      class="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
    >
      No books in this bucket.
    </div>

    <div v-else class="divide-y divide-border">
      <article v-for="item in activePage.items" :key="item.absLibraryItemId" class="space-y-3 py-4 first:pt-0 last:pb-0">
        <div class="flex gap-3">
          <div
            data-testid="abs-cover-placeholder"
            class="flex h-14 w-10 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground"
          >
            <BookOpen class="size-4" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="truncate text-sm font-medium">{{ item.absTitle }}</p>
              <span v-if="item.syncExcluded" class="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Excluded</span>
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">{{ item.absAuthorName ?? 'Unknown Audiobookshelf author' }}</p>
          </div>
          <div v-if="actionId === item.absLibraryItemId" class="flex shrink-0 items-center text-muted-foreground">
            <Loader2 class="size-4 animate-spin" />
          </div>
        </div>

        <div v-if="item.bookId" class="rounded-md border border-border bg-muted/30 px-3 py-2">
          <p class="text-xs text-muted-foreground">BookOrbit match</p>
          <p class="mt-0.5 text-sm">{{ item.bookTitle ?? 'Untitled' }}</p>
          <p class="text-xs text-muted-foreground">
            {{ item.bookAuthorName ?? 'Unknown author' }}
            <span v-if="item.matchMethod"> · {{ matchMethodLabel(item.matchMethod) }}</span>
            <span v-if="confidenceLabel(item.matchConfidence)"> · {{ confidenceLabel(item.matchConfidence) }}</span>
          </p>
        </div>

        <p v-if="item.matchError" class="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
          {{ item.matchError }}
        </p>
        <p v-if="item.syncError" class="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
          Last sync: {{ item.syncError }}
        </p>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="activeBucket === 'needs-review'"
            type="button"
            :disabled="actionId !== null"
            class="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            @click="handleConfirm(item)"
          >
            <Check class="size-3" />
            Confirm match
          </button>
          <button
            v-if="activeBucket !== 'linked' || item.needsReview"
            type="button"
            :disabled="actionId !== null"
            class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="beginManualLink(item)"
          >
            <Link2 class="size-3" />
            Link manually
          </button>
          <button
            v-if="item.bookId && !item.needsReview"
            type="button"
            :disabled="actionId !== null"
            class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="handleUnlink(item)"
          >
            <Unlink class="size-3" />
            Unlink
          </button>
          <button
            type="button"
            :disabled="actionId !== null"
            class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="handleToggleExcluded(item)"
          >
            <Ban class="size-3" />
            {{ item.syncExcluded ? 'Include in sync' : 'Exclude from sync' }}
          </button>
        </div>

        <div v-if="pickerItemId === item.absLibraryItemId" class="space-y-2 rounded-md border border-border bg-background p-3">
          <label :for="`book-search-${item.absLibraryItemId}`" class="text-xs font-medium">Choose a BookOrbit book</label>
          <div class="relative">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              :id="`book-search-${item.absLibraryItemId}`"
              :value="searchQuery"
              type="search"
              placeholder="Search by title, author, or series"
              class="w-full rounded-md border border-border bg-background py-2 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              @input="handleSearchInput"
            />
          </div>
          <p v-if="searching" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 class="size-3 animate-spin" />
            Searching...
          </p>
          <p v-if="searchError" class="text-xs text-destructive">{{ searchError }}</p>
          <div v-if="searchResults.length > 0" class="max-h-52 overflow-y-auto rounded-md border border-border">
            <button
              v-for="option in searchResults"
              :key="option.id"
              type="button"
              class="flex w-full flex-col border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted/60"
              @click="selectSearchResult(option)"
            >
              <span class="text-sm">{{ option.title ?? 'Untitled' }}</span>
              <span class="text-xs text-muted-foreground">{{ option.authors.join(', ') || 'Unknown author' }} · {{ option.libraryName }}</span>
            </button>
          </div>
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              class="rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/80"
              @click="closePicker"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="!selectedBook || actionId !== null"
              class="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              @click="handleLinkSelected"
            >
              Link selected book
            </button>
          </div>
        </div>
      </article>
    </div>

    <div
      v-if="activePage.total > 0"
      class="flex flex-col gap-2 border-t border-border pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <span>Showing {{ rangeStart }} to {{ rangeEnd }} of {{ activePage.total }}</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          :disabled="activePage.page <= 0 || activeBucketLoading"
          aria-label="Previous page"
          class="rounded-md border border-border bg-muted p-1.5 transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handlePreviousPage"
        >
          <ChevronLeft class="size-3.5" />
        </button>
        <span>Page {{ activePage.page + 1 }} of {{ totalPages }}</span>
        <button
          type="button"
          :disabled="activePage.page + 1 >= totalPages || activeBucketLoading"
          aria-label="Next page"
          class="rounded-md border border-border bg-muted p-1.5 transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleNextPage"
        >
          <ChevronRight class="size-3.5" />
        </button>
      </div>
    </div>
  </section>
</template>
