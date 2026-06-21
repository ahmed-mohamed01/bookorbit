<script setup lang="ts">
import { useWindowSize } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUpDown, ChevronDown, ChevronLeft, ImageMinus, LayoutGrid, List, Upload } from '@lucide/vue'
import { toast } from 'vue-sonner'

import type { AuthorSummary, BookCard } from '@bookorbit/types'
import VirtualBookGrid from '@/features/book/components/VirtualBookGrid.vue'
import BookListRow from '@/features/book/components/BookListRow.vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { usePageTitle } from '@/composables/usePageTitle'
import AuthorHeader from '../components/AuthorHeader.vue'
import AuthorConfirmDialog from '../components/AuthorConfirmDialog.vue'
import {
  deleteAuthorImage,
  deleteAuthors,
  fetchAuthors,
  mergeAuthors,
  MAX_AUTHOR_IMAGE_BYTES,
  refreshAuthorMetadata,
  updateAuthor,
  uploadAuthorImage,
} from '../api/author'
import { useAuthorBooks } from '../composables/useAuthorBooks'
import { useAuthorDetail } from '../composables/useAuthorDetail'
import { useAuthorMetadataPreview } from '../composables/useAuthorMetadataPreview'
import EntityNotFound from '@/components/EntityNotFound.vue'

const route = useRoute()
const router = useRouter()
const { hasPermission, isSuperuser } = usePermissions()
const { width: windowWidth } = useWindowSize()

const { portraitCoverSize, gridGap } = useDisplaySettings()
const { libraries, fetchLibraries } = useLibraries()

const authorBooksViewMode = ref<'grid' | 'list'>('grid')

const authorId = computed(() => Number(route.params.id))
const { author, loading: loadingAuthor, error: authorError, notFound: authorNotFound, load: loadAuthor } = useAuthorDetail(authorId)
const { items: books, total, loading: loadingBooks, error: booksError, hasMore, sort, order, libraryId, load: loadBooks } = useAuthorBooks(authorId)
const authorName = computed(() => author.value?.name ?? '')
const pageTitle = computed(() => {
  if (author.value?.name) return `Author · ${author.value.name}`
  return Number.isFinite(authorId.value) ? `Author #${authorId.value}` : 'Author'
})
usePageTitle(pageTitle)
const {
  preview: metadataPreview,
  loading: loadingMetadataPreview,
  error: metadataPreviewError,
  cancel: cancelMetadataPreview,
  load: loadMetadataPreview,
} = useAuthorMetadataPreview(authorName)

const canUpdate = computed(() => hasPermission('library_edit_metadata'))
const canMerge = computed(() => isSuperuser.value)
const canDelete = computed(() => isSuperuser.value)

const editOpen = ref(false)
const mergeOpen = ref(false)
const confirmMergeOpen = ref(false)
const confirmDeleteOpen = ref(false)
const savingEdit = ref(false)
const merging = ref(false)
const deleting = ref(false)
const refreshingMetadata = ref(false)
const uploadingImage = ref(false)
const removingImage = ref(false)
const authorImageInput = ref<HTMLInputElement | null>(null)

const draftName = ref('')
const draftSortName = ref('')
const draftDescription = ref('')
const authorImageBusy = computed(() => uploadingImage.value || removingImage.value)

const mergeQuery = ref('')
const mergeCandidates = ref<AuthorSummary[]>([])
const selectedMergeIds = ref<number[]>([])
const searchingMergeCandidates = ref(false)
let mergeSearchTimer: ReturnType<typeof setTimeout> | null = null

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

const selectedMergeBookCount = computed(() => {
  const selected = new Set(selectedMergeIds.value)
  return mergeCandidates.value.filter((candidate) => selected.has(candidate.id)).reduce((sum, candidate) => sum + candidate.bookCount, 0)
})

const BOOK_SORT_OPTIONS = [
  { value: 'addedAt', label: 'Recently Added' },
  { value: 'title', label: 'Title' },
  { value: 'publishedYear', label: 'Published Year' },
] as const

function showRefreshResultToast(updated: { imageUrl?: string | null }) {
  if (!updated.imageUrl) {
    toast.warning('Metadata refreshed, but no author image was found.')
    return
  }
  toast.success('Author metadata refreshed')
}

watch(
  author,
  (value) => {
    draftName.value = value?.name ?? ''
    draftSortName.value = value?.sortName ?? ''
    draftDescription.value = value?.description ?? ''
  },
  { immediate: true },
)

function goBack() {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  if (from.startsWith('/authors')) {
    void router.push(from)
    return
  }
  if (window.history.length > 1) {
    router.back()
    return
  }
  void router.push({ name: 'authors' })
}

function toggleEdit() {
  editOpen.value = !editOpen.value
  if (editOpen.value) mergeOpen.value = false
}

function toggleMerge() {
  mergeOpen.value = !mergeOpen.value
  if (mergeOpen.value) editOpen.value = false
}

function handleBookAction(book: BookCard, action: 'quick-view' | 'edit-metadata' | 'add-to-collection' | 'delete') {
  if (action === 'quick-view') {
    void router.push({ name: 'book-detail', params: { bookId: book.id } })
  }
}

function handleBookUpdate(updated: BookCard) {
  const idx = books.value.findIndex((b) => b.id === updated.id)
  if (idx !== -1) books.value = books.value.map((b, i) => (i === idx ? updated : b))
}

function loadIfSentinelVisible() {
  if (loadingBooks.value || !hasMore.value || !sentinel.value) return
  if (sentinel.value.getBoundingClientRect().top < window.innerHeight + 250) {
    void loadBooks()
  }
}

async function saveAuthorEdits() {
  if (!author.value || savingEdit.value) return
  const name = draftName.value.trim()
  if (!name) {
    toast.error('Author name is required')
    return
  }

  savingEdit.value = true
  try {
    const updated = await updateAuthor(author.value.id, {
      name,
      sortName: draftSortName.value.trim() || null,
      description: draftDescription.value.trim() || null,
    })
    author.value = updated
    editOpen.value = false
    toast.success('Author updated')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to update author')
  } finally {
    savingEdit.value = false
  }
}

function openAuthorImagePicker() {
  if (!author.value || authorImageBusy.value) return
  authorImageInput.value?.click()
}

async function onAuthorImageSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !author.value || authorImageBusy.value) return

  uploadingImage.value = true
  try {
    const updated = await uploadAuthorImage(author.value.id, file)
    author.value = updated
    toast.success('Author image updated')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to upload author image')
  } finally {
    uploadingImage.value = false
  }
}

async function removeAuthorImage() {
  if (!author.value || authorImageBusy.value || !author.value.imageUrl) return

  removingImage.value = true
  try {
    const updated = await deleteAuthorImage(author.value.id)
    author.value = updated
    toast.success('Author image removed')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to remove author image')
  } finally {
    removingImage.value = false
  }
}

async function searchMergeCandidates() {
  if (!mergeOpen.value || !mergeQuery.value.trim()) {
    mergeCandidates.value = []
    return
  }

  searchingMergeCandidates.value = true
  try {
    const page = await fetchAuthors({
      q: mergeQuery.value.trim(),
      page: 0,
      size: 20,
      sort: 'name',
      order: 'asc',
      libraryId: null,
    })

    mergeCandidates.value = page.items.filter((candidate) => candidate.id !== authorId.value)
  } catch {
    mergeCandidates.value = []
  } finally {
    searchingMergeCandidates.value = false
  }
}

function toggleMergeCandidate(candidateId: number, checked: boolean) {
  const current = new Set(selectedMergeIds.value)
  if (checked) current.add(candidateId)
  else current.delete(candidateId)
  selectedMergeIds.value = [...current]
}

function onMergeCandidateToggle(candidateId: number, event: Event) {
  const target = event.target as HTMLInputElement | null
  toggleMergeCandidate(candidateId, target?.checked ?? false)
}

async function runMerge() {
  if (!author.value || merging.value || selectedMergeIds.value.length === 0) return

  confirmMergeOpen.value = false
  merging.value = true
  try {
    const result = await mergeAuthors({
      targetAuthorId: author.value.id,
      sourceAuthorIds: selectedMergeIds.value,
    })

    author.value = result.target
    selectedMergeIds.value = []
    mergeCandidates.value = []
    mergeQuery.value = ''
    mergeOpen.value = false

    await loadBooks(true)
    toast.success(`Merged ${result.mergedAuthorIds.length} author(s); affected ${result.affectedBookCount} books`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to merge authors')
  } finally {
    merging.value = false
  }
}

async function runDelete() {
  if (!author.value || deleting.value) return

  confirmDeleteOpen.value = false
  deleting.value = true
  try {
    const result = await deleteAuthors({ authorIds: [author.value.id] })
    toast.success(`Deleted author; affected ${result.affectedBookCount} books`)
    await router.push({ name: 'authors' })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to delete author')
  } finally {
    deleting.value = false
  }
}

function promptRunMerge() {
  if (!author.value || merging.value || selectedMergeIds.value.length === 0) return
  confirmMergeOpen.value = true
}

const mergeDialogTitle = computed(() => {
  if (!author.value) return 'Merge selected authors?'
  return `Merge ${selectedMergeIds.value.length} author(s) into "${author.value.name}"?`
})

const mergeDialogDescription = computed(() => {
  if (selectedMergeIds.value.length === 0) return 'This action cannot be undone.'
  return 'This will merge selected authors into the current author and re-link associated books. This action cannot be undone.'
})

const isMobileLayout = computed(() => windowWidth.value < 640)
const authorBookCoverSize = computed(() => {
  const configuredSize = Number(portraitCoverSize.value)
  const normalizedSize = Number.isFinite(configuredSize) && configuredSize > 0 ? configuredSize : 130
  if (!isMobileLayout.value) return normalizedSize
  return Math.min(normalizedSize, 110)
})
const authorBookGridGap = computed(() => {
  const configuredGap = Number(gridGap.value)
  const normalizedGap = Number.isFinite(configuredGap) && configuredGap > 0 ? configuredGap : 20
  if (!isMobileLayout.value) return normalizedGap
  return Math.min(normalizedGap, 12)
})

function onLibraryFilterChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  libraryId.value = value ? Number(value) : null
}

function onMobileSortChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (BOOK_SORT_OPTIONS.some((option) => option.value === value)) {
    sort.value = value as (typeof BOOK_SORT_OPTIONS)[number]['value']
  }
}

function toggleBookOrder() {
  order.value = order.value === 'asc' ? 'desc' : 'asc'
}

async function refreshMetadata() {
  if (!author.value || refreshingMetadata.value) return
  refreshingMetadata.value = true
  try {
    const updated = await refreshAuthorMetadata(author.value.id)
    author.value = updated
    await loadMetadataPreview()
    showRefreshResultToast(updated)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to refresh author metadata')
  } finally {
    refreshingMetadata.value = false
  }
}

onMounted(async () => {
  await fetchLibraries()
  await Promise.all([loadAuthor(), loadBooks(true)])

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && !loadingBooks.value && hasMore.value) {
        void loadBooks()
      }
    },
    { rootMargin: '280px' },
  )

  if (sentinel.value) observer.observe(sentinel.value)
})

onUnmounted(() => {
  observer?.disconnect()
  if (mergeSearchTimer) clearTimeout(mergeSearchTimer)
  cancelMetadataPreview()
})

watch(authorId, () => {
  selectedMergeIds.value = []
  mergeCandidates.value = []
  mergeQuery.value = ''
  void Promise.all([loadAuthor(), loadBooks(true)]).then(() => loadMetadataPreview())
})

watch([sort, order, libraryId], () => {
  void loadBooks(true)
})

watch(mergeQuery, () => {
  if (mergeSearchTimer) clearTimeout(mergeSearchTimer)
  mergeSearchTimer = setTimeout(() => {
    void searchMergeCandidates()
  }, 220)
})

watch(
  loadingBooks,
  (isLoading) => {
    if (!isLoading) loadIfSentinelVisible()
  },
  { flush: 'post' },
)

watch(authorName, () => {
  void loadMetadataPreview()
})
</script>

<template>
  <main class="flex min-h-full w-full min-w-0 flex-col overflow-x-hidden pr-0 sm:pr-2">
    <div class="mb-3 mt-2 mr-0 sm:mr-4 flex items-center gap-2 px-1">
      <button
        class="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        @click="goBack"
      >
        <ChevronLeft :size="14" />
        Back
      </button>
    </div>

    <div v-if="authorNotFound">
      <EntityNotFound entity="Author" />
    </div>

    <template v-else>
      <div v-if="authorError" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {{ authorError }}
      </div>

      <div v-if="loadingAuthor && !author" class="mb-4 rounded-lg border border-border/70 bg-card/60 p-4 text-sm text-muted-foreground">
        Loading author...
      </div>
      <AuthorHeader
        v-else-if="author"
        :author="author"
        :image-url="author.imageUrl ?? metadataPreview?.imageUrl ?? null"
        :preview-description="metadataPreview?.description ?? null"
        :preview-provider="metadataPreview?.provider ?? null"
        :loading-preview="loadingMetadataPreview"
        :can-update="canUpdate"
        :can-merge="canMerge"
        :can-delete="canDelete"
        :refreshing="refreshingMetadata"
        @edit="toggleEdit"
        @merge="toggleMerge"
        @refresh="refreshMetadata"
        @delete="confirmDeleteOpen = true"
      />

      <div v-if="metadataPreviewError" class="mt-3 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Could not load external author preview metadata right now.
      </div>

      <section v-if="author && (editOpen || mergeOpen)" class="mt-4 rounded-lg border border-border/70 bg-card/60 p-3 space-y-3">
        <div v-if="editOpen && canUpdate" class="space-y-2">
          <div class="grid gap-2 md:grid-cols-2">
            <label class="text-xs text-muted-foreground">
              Name
              <input v-model="draftName" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm" />
            </label>
            <label class="text-xs text-muted-foreground">
              Sort Name
              <input v-model="draftSortName" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm" />
            </label>
          </div>
          <label class="block text-xs text-muted-foreground">
            Description
            <textarea v-model="draftDescription" rows="3" class="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm" />
          </label>
          <div class="space-y-1.5">
            <p class="text-xs text-muted-foreground">Image</p>
            <input ref="authorImageInput" type="file" accept="image/*" class="hidden" :disabled="authorImageBusy" @change="onAuthorImageSelected" />
            <div class="flex flex-wrap items-center gap-2">
              <button
                :disabled="authorImageBusy"
                class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                @click="openAuthorImagePicker"
              >
                <Upload :size="14" />
                {{ uploadingImage ? 'Uploading...' : author?.imageUrl ? 'Replace image' : 'Upload image' }}
              </button>
              <button
                :disabled="authorImageBusy || !author?.imageUrl"
                class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                @click="removeAuthorImage"
              >
                <ImageMinus :size="14" />
                {{ removingImage ? 'Removing...' : 'Remove image' }}
              </button>
            </div>
            <p class="text-[11px] text-muted-foreground">PNG/JPEG/WEBP/GIF/BMP up to {{ Math.floor(MAX_AUTHOR_IMAGE_BYTES / 1024 / 1024) }} MB</p>
          </div>
          <div class="flex items-center justify-end gap-2">
            <button class="h-8 rounded-md border border-input px-3 text-sm text-muted-foreground hover:bg-muted" @click="editOpen = false">
              Cancel
            </button>
            <button
              :disabled="savingEdit"
              class="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
              @click="saveAuthorEdits"
            >
              {{ savingEdit ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </div>

        <div v-if="mergeOpen && canMerge" class="space-y-2">
          <input
            v-model="mergeQuery"
            class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
            placeholder="Search authors to merge into this author"
          />

          <div v-if="searchingMergeCandidates" class="text-xs text-muted-foreground">Searching...</div>

          <div v-if="mergeCandidates.length > 0" class="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-background/50 p-2">
            <label v-for="candidate in mergeCandidates" :key="candidate.id" class="flex items-center gap-2 text-sm">
              <input type="checkbox" :checked="selectedMergeIds.includes(candidate.id)" @change="onMergeCandidateToggle(candidate.id, $event)" />
              <span class="min-w-0 flex-1 truncate">{{ candidate.name }}</span>
              <span class="text-xs text-muted-foreground">{{ candidate.bookCount }} books</span>
            </label>
          </div>

          <div v-if="selectedMergeIds.length > 0" class="text-xs text-muted-foreground">
            Selected {{ selectedMergeIds.length }} author(s), approx. {{ selectedMergeBookCount }} books affected.
          </div>

          <div class="flex items-center justify-end">
            <button
              :disabled="merging || selectedMergeIds.length === 0"
              class="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
              @click="promptRunMerge"
            >
              {{ merging ? 'Merging...' : 'Merge Selected' }}
            </button>
          </div>
        </div>
      </section>

      <section class="mt-4 rounded-lg border border-border/70 bg-card/60 p-3">
        <div class="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h2 class="text-sm font-semibold text-foreground">Books</h2>
          <div class="w-full space-y-2 sm:hidden">
            <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
              <div class="relative min-w-0">
                <select
                  :value="sort"
                  class="h-8 w-full appearance-none rounded-md border border-input bg-background px-2.5 pr-8 text-sm text-foreground outline-none transition-colors focus:border-primary/60"
                  @change="onMobileSortChange"
                >
                  <option v-for="opt in BOOK_SORT_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
                <ArrowUpDown :size="13" class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/85" />
              </div>

              <button
                class="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                @click="toggleBookOrder"
              >
                {{ order === 'asc' ? 'Asc' : 'Desc' }}
              </button>

              <div class="flex items-center rounded-md border border-input bg-background">
                <button
                  class="flex h-8 w-8 items-center justify-center rounded-l-md transition-colors"
                  :class="
                    authorBooksViewMode === 'grid' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  "
                  @click="authorBooksViewMode = 'grid'"
                >
                  <LayoutGrid :size="14" />
                </button>
                <button
                  class="flex h-8 w-8 items-center justify-center rounded-r-md transition-colors"
                  :class="
                    authorBooksViewMode === 'list' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  "
                  @click="authorBooksViewMode = 'list'"
                >
                  <List :size="14" />
                </button>
              </div>
            </div>

            <div class="relative min-w-0">
              <select
                :value="libraryId ?? ''"
                class="h-8 w-full appearance-none rounded-md border border-input bg-background px-2.5 pr-8 text-sm text-foreground outline-none transition-colors focus:border-primary/60"
                @change="onLibraryFilterChange"
              >
                <option value="">All Libraries</option>
                <option v-for="library in libraries" :key="library.id" :value="library.id">
                  {{ library.name }}
                </option>
              </select>
              <ChevronDown :size="14" class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/85" />
            </div>
          </div>

          <div class="hidden flex-wrap items-center gap-2 sm:flex">
            <select
              v-model="sort"
              class="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 sm:w-auto"
            >
              <option value="addedAt">Recently Added</option>
              <option value="title">Title</option>
              <option value="publishedYear">Published Year</option>
            </select>

            <select
              v-model="order"
              class="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 sm:w-auto"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>

            <select
              :value="libraryId ?? ''"
              class="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 sm:w-auto"
              @change="onLibraryFilterChange"
            >
              <option value="">All Libraries</option>
              <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
            </select>

            <div class="flex items-center rounded-md border border-input bg-background">
              <button
                class="flex h-8 w-8 items-center justify-center rounded-l-md transition-colors"
                :class="authorBooksViewMode === 'grid' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
                @click="authorBooksViewMode = 'grid'"
              >
                <LayoutGrid :size="14" />
              </button>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-r-md transition-colors"
                :class="authorBooksViewMode === 'list' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
                @click="authorBooksViewMode = 'list'"
              >
                <List :size="14" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="booksError" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {{ booksError }}
        </div>

        <div v-if="!loadingBooks && books.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p class="text-sm font-medium text-foreground">No books found for this author</p>
          <p class="text-xs text-muted-foreground">Try changing sort/order or selecting another library.</p>
        </div>

        <VirtualBookGrid
          v-if="authorBooksViewMode === 'grid' && books.length > 0"
          :books="books"
          :cover-size="authorBookCoverSize"
          :grid-gap="authorBookGridGap"
          @action="handleBookAction"
          @update:book="handleBookUpdate"
        />

        <div v-if="authorBooksViewMode === 'list' && books.length > 0" class="flex flex-col divide-y divide-border">
          <BookListRow v-for="book in books" :key="book.id" :book="book" @action="handleBookAction(book, $event)" />
        </div>

        <div ref="sentinel" class="mt-4 flex h-8 items-center justify-center">
          <span v-if="loadingBooks" class="text-xs text-muted-foreground">Loading...</span>
          <span v-else-if="!hasMore && books.length > 0" class="text-xs text-muted-foreground">All {{ total.toLocaleString() }} books loaded</span>
        </div>
      </section>
    </template>
  </main>

  <AuthorConfirmDialog
    :open="confirmDeleteOpen"
    title="Delete author?"
    description="This removes the author from the catalog and unlinks it from associated books. This action cannot be undone."
    confirm-label="Delete"
    :loading="deleting"
    destructive
    @confirm="runDelete"
    @cancel="confirmDeleteOpen = false"
  />

  <AuthorConfirmDialog
    :open="confirmMergeOpen"
    :title="mergeDialogTitle"
    :description="mergeDialogDescription"
    confirm-label="Merge"
    :loading="merging"
    @confirm="runMerge"
    @cancel="confirmMergeOpen = false"
  />
</template>
