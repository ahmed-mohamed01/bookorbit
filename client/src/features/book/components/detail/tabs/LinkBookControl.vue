<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, ChevronDown, Headphones, Link2, Loader2, Search, Unlink2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Permission, type BookDetail } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { getBookLinkModality, useEditionLink, type EditionLinkCandidate } from '@/features/book/composables/useEditionLink'
import { useReadingAlignment } from '@/features/book/composables/useReadingAlignment'

const props = withDefaults(defineProps<{ book: BookDetail; triggerClass?: string }>(), {
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})

const { t } = useI18n()

const modality = computed(() => getBookLinkModality(props.book.files))
const isEligible = computed(() => modality.value === 'text' || modality.value === 'audio')

// The counterpart is always the opposite modality of the current book, and every candidate/suggestion/
// linked record shares it, so a single indicator describes what we're linking to. A text-only book links
// to an audiobook; an audio-only book links to an ebook.
const counterpartIsAudio = computed(() => modality.value === 'text')
const counterpartLabel = computed(() =>
  counterpartIsAudio.value ? t('book.detail.editionLink.counterpartAudiobook') : t('book.detail.editionLink.counterpartEbook'),
)
const counterpartIcon = computed(() => (counterpartIsAudio.value ? Headphones : BookOpen))

const alignment = useReadingAlignment()

const { hasPermission } = usePermissions()
const canEditMetadata = computed(() => hasPermission(Permission.LibraryEditMetadata))

const {
  link,
  proposed,
  linkedCounterpart,
  candidates,
  loading,
  searching,
  mutating,
  error,
  searchError,
  loadForBook,
  searchCandidates,
  linkBook,
  unlink: unlinkBook,
  resetSearch,
} = useEditionLink(props.book.id)

// The button already carries the action, so its hover title carries the *reason*: an unlinked book
// gets the modality-specific "link the counterpart to enable position alignment" prompt; a linked one
// just says it manages the existing link.
const alignmentBusy = computed(() => alignment.mutating.value || alignment.status.value === 'building' || alignment.status.value === 'pending')

// The trigger icon narrates the match lifecycle: blue while the alignment is processing, green once
// the pair is linked and aligned, the default linked accent for a link whose alignment isn't built.
const iconClass = computed(() => {
  if (!link.value) return ''
  if (alignmentBusy.value) return 'text-sky-500'
  if (alignment.status.value === 'ready') return 'text-emerald-500'
  if (alignment.status.value === 'failed') return 'text-destructive'
  return 'text-primary'
})

const linkTooltip = computed(() => {
  if (link.value && alignmentBusy.value) return t('book.detail.editionLink.tooltipAligning')
  if (link.value && alignment.status.value === 'ready') return t('book.detail.editionLink.tooltipAligned')
  if (link.value && alignment.status.value === 'failed') return t('book.detail.editionLink.tooltipAlignFailed')
  if (link.value) return t('book.detail.editionLink.tooltipLinked')
  return modality.value === 'audio' ? t('book.detail.editionLink.tooltipNeedsText') : t('book.detail.editionLink.tooltipNeedsAudio')
})

// Load the link state up front (only for a link-eligible book) so the trigger's hover title reflects
// whether a link already exists, without the user having to open the popover first. One cheap fetch
// per book-detail view; the popover refreshes it on open.
function refreshAlignmentStatus() {
  if (link.value) void alignment.fetchStatus(props.book.id)
}

onMounted(() => {
  if (!isEligible.value) return
  void loadForBook().then(refreshAlignmentStatus)
})

const open = ref(false)
const searchOpen = ref(false)
const hasSearched = ref(false)
const query = ref('')

async function handleOpenChange(next: boolean) {
  open.value = next
  if (!next) return

  searchOpen.value = false
  hasSearched.value = false
  query.value = ''
  resetSearch()

  await loadForBook()
  refreshAlignmentStatus()
  if (canEditMetadata.value && !link.value && !proposed.value) {
    searchOpen.value = true
    hasSearched.value = true
    void searchCandidates('')
  }
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value && !hasSearched.value) {
    hasSearched.value = true
    void searchCandidates(query.value)
  }
}

function handleQueryInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
  hasSearched.value = true
  void searchCandidates(query.value)
}

async function confirmLink(counterpartId: number) {
  const success = await linkBook(counterpartId)
  if (success) {
    toast.success(t('book.detail.editionLink.linkedSuccess'))
    searchOpen.value = false
    query.value = ''
    // Matching flows straight into alignment: kick the build off so the icon can narrate
    // blue (processing) -> green (linked and aligned) without a separate manual step.
    void alignment.build(props.book.id)
  } else {
    toast.error(error.value ?? t('book.detail.editionLink.linkFailed'))
  }
}

function handleProposedLinkClick() {
  if (proposed.value) void confirmLink(proposed.value.bookId)
}

function selectCandidate(candidate: EditionLinkCandidate) {
  void confirmLink(candidate.bookId)
}

async function handleUnlinkClick() {
  const success = await unlinkBook()
  if (success) {
    toast.success(t('book.detail.editionLink.unlinkedSuccess'))
  } else {
    toast.error(error.value ?? t('book.detail.editionLink.unlinkFailed'))
  }
}
</script>

<template>
  <Popover v-if="isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button type="button" :class="triggerClass" :title="linkTooltip" :aria-label="t('book.detail.editionLink.trigger')">
        <Link2 class="size-3.5" :class="iconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-3">
      <p class="text-sm font-semibold text-foreground">{{ t('book.detail.editionLink.title') }}</p>

      <div v-if="loading" class="mt-3 space-y-2" data-testid="edition-link-loading">
        <div class="h-4 w-3/4 rounded bg-muted animate-shimmer" />
        <div class="h-8 w-full rounded bg-muted animate-shimmer" />
      </div>

      <template v-else>
        <div v-if="link" class="mt-3 rounded-lg border border-border bg-background p-2.5" data-testid="edition-link-linked">
          <p class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.linkedTo') }}</p>
          <p class="mt-0.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
            <span class="truncate">{{ linkedCounterpart?.title ?? t('book.detail.editionLink.unknownTitle') }}</span>
            <component
              :is="counterpartIcon"
              class="size-3.5 shrink-0 text-muted-foreground"
              :aria-label="counterpartLabel"
              data-testid="edition-link-counterpart-format"
            />
          </p>
          <p v-if="linkedCounterpart?.authorName" class="truncate text-xs text-muted-foreground">{{ linkedCounterpart.authorName }}</p>
          <button
            v-if="canEditMetadata"
            type="button"
            class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="mutating"
            @click="handleUnlinkClick"
          >
            <Loader2 v-if="mutating" class="size-3.5 animate-spin" />
            <Unlink2 v-else class="size-3.5" />
            {{ t('book.detail.editionLink.unlink') }}
          </button>
        </div>

        <template v-else>
          <div v-if="proposed" class="mt-3 rounded-lg border border-border bg-background p-2.5" data-testid="edition-link-proposed">
            <p class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.suggestedMatch') }}</p>
            <p class="mt-0.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
              <span class="truncate">{{ proposed.title ?? t('book.detail.editionLink.unknownTitle') }}</span>
              <component
                :is="counterpartIcon"
                class="size-3.5 shrink-0 text-muted-foreground"
                :aria-label="counterpartLabel"
                data-testid="edition-link-counterpart-format"
              />
            </p>
            <p v-if="proposed.authorName" class="truncate text-xs text-muted-foreground">{{ proposed.authorName }}</p>
            <p class="mt-1 text-[11px] text-muted-foreground">{{ t('book.detail.editionLink.confidence', { score: proposed.score }) }}</p>
            <button
              v-if="canEditMetadata"
              type="button"
              class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="mutating"
              @click="handleProposedLinkClick"
            >
              <Loader2 v-if="mutating" class="size-3.5 animate-spin" />
              <Link2 v-else class="size-3.5" />
              {{ t('book.detail.editionLink.confirmLink') }}
            </button>
          </div>
          <p v-else class="mt-3 text-xs text-muted-foreground" data-testid="edition-link-no-match">{{ t('book.detail.editionLink.noMatch') }}</p>

          <div v-if="canEditMetadata" class="mt-3 border-t border-border pt-3">
            <button
              type="button"
              class="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              @click="toggleSearch"
            >
              <span class="inline-flex items-center gap-1.5"><Search class="size-3.5" />{{ t('book.detail.editionLink.searchToggle') }}</span>
              <ChevronDown class="size-3.5 transition-transform" :class="{ 'rotate-180': searchOpen }" />
            </button>

            <div v-if="searchOpen" class="mt-2 space-y-2" data-testid="edition-link-search">
              <input
                type="text"
                :value="query"
                class="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                :placeholder="t('book.detail.editionLink.searchPlaceholder')"
                @input="handleQueryInput"
              />
              <p v-if="searching" class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.searching') }}</p>
              <p v-else-if="searchError" class="text-xs text-destructive" data-testid="edition-link-search-error">
                {{ t('book.detail.editionLink.searchFailed') }}
              </p>
              <ul v-else-if="candidates.length" class="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                <li v-for="candidate in candidates" :key="candidate.bookId">
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="mutating"
                    @click="selectCandidate(candidate)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center gap-1.5 text-foreground">
                        <span class="truncate">{{ candidate.title ?? t('book.detail.editionLink.unknownTitle') }}</span>
                        <component :is="counterpartIcon" class="size-3 shrink-0 text-muted-foreground" :aria-label="counterpartLabel" />
                      </span>
                      <span v-if="candidate.authorName" class="block truncate text-xs text-muted-foreground">{{ candidate.authorName }}</span>
                    </span>
                    <span class="shrink-0 text-[11px] text-muted-foreground">{{ candidate.score }}%</span>
                  </button>
                </li>
              </ul>
              <p v-else-if="hasSearched" class="text-xs text-muted-foreground">{{ t('book.detail.editionLink.noResults') }}</p>
            </div>
          </div>
        </template>
      </template>
    </PopoverContent>
  </Popover>
</template>
