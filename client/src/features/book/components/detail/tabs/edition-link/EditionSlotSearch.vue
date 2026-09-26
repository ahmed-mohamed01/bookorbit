<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Search } from '@lucide/vue'
import type { CoverMedium, EditionLinkCandidate } from '@bookorbit/types'
import type { EditionFormat } from '@/features/book/composables/useLinkEditionPanel'
import EditionCover from './EditionCover.vue'

const STRONG_MATCH_SCORE = 80

const props = withDefaults(
  defineProps<{
    format: EditionFormat
    canSearch: boolean
    query: string
    candidates: EditionLinkCandidate[]
    searching: boolean
    searchError: string | null
    hasSearched: boolean
    disabled: boolean
    autofocus?: boolean
  }>(),
  { autofocus: false },
)

const emit = defineEmits<{ 'update:query': [value: string]; pick: [candidate: EditionLinkCandidate] }>()

const { t } = useI18n()
const inputEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (props.autofocus) inputEl.value?.focus()
})

const isEbook = computed(() => props.format === 'ebook')
const coverMedium = computed<CoverMedium>(() => (isEbook.value ? 'ebook' : 'audio'))
const title = computed(() => (isEbook.value ? t('book.detail.editionLink.search.titleEbook') : t('book.detail.editionLink.search.titleAudiobook')))
const body = computed(() => (isEbook.value ? t('book.detail.editionLink.search.bodyEbook') : t('book.detail.editionLink.search.bodyAudiobook')))
const placeholder = computed(() =>
  isEbook.value ? t('book.detail.editionLink.search.placeholderEbook') : t('book.detail.editionLink.search.placeholderAudiobook'),
)

function scoreClass(score: number): string {
  return score > STRONG_MATCH_SCORE ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
}

function handleInput(event: Event) {
  emit('update:query', (event.target as HTMLInputElement).value)
}

function handlePick(candidate: EditionLinkCandidate) {
  emit('pick', candidate)
}
</script>

<template>
  <div
    class="relative z-[1] rounded-xl border border-dashed border-border bg-background px-3 pt-3 pb-2"
    :data-testid="`edition-slot-search-${format}`"
  >
    <div class="flex flex-col items-center px-1 pt-1 text-center">
      <div class="flex size-8 items-center justify-center rounded-lg border-[1.5px] border-dashed border-border text-muted-foreground">
        <Plus class="size-4" aria-hidden="true" />
      </div>
      <p class="mt-2 text-sm font-semibold text-foreground">{{ title }}</p>
      <p class="mt-0.5 max-w-[340px] text-xs text-pretty text-muted-foreground">{{ body }}</p>
    </div>

    <template v-if="canSearch">
      <label class="mt-3 flex h-9 items-center gap-2 rounded-lg border border-input bg-card px-3 focus-within:ring-1 focus-within:ring-ring">
        <Search class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref="inputEl"
          type="text"
          :value="query"
          :placeholder="placeholder"
          :aria-label="placeholder"
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="edition-search-input"
          @input="handleInput"
        />
      </label>

      <div class="mt-2">
        <p v-if="searching" class="px-2 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.searching') }}</p>
        <p v-else-if="searchError" class="px-2 py-1.5 text-xs text-destructive" data-testid="edition-search-error">
          {{ t('book.detail.editionLink.searchFailed') }}
        </p>
        <ul v-else-if="candidates.length" class="flex max-h-60 flex-col gap-1 overflow-y-auto" data-testid="edition-search-results">
          <li v-for="candidate in candidates" :key="candidate.bookId">
            <button
              type="button"
              class="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="disabled"
              data-testid="edition-search-result"
              @click="handlePick(candidate)"
            >
              <EditionCover :book-id="candidate.bookId" :medium="coverMedium" :version="candidate.coverVersion" size="result" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium text-foreground">{{
                  candidate.title ?? t('book.detail.editionLink.unknownTitle')
                }}</span>
                <span v-if="candidate.authorName" class="block truncate text-xs text-muted-foreground">{{ candidate.authorName }}</span>
              </span>
              <span
                class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                :class="scoreClass(candidate.score)"
                data-testid="edition-search-score"
              >
                {{ t('book.detail.editionLink.search.score', { score: candidate.score }) }}
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="hasSearched" class="px-2 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.noResults') }}</p>
      </div>
    </template>
  </div>
</template>
