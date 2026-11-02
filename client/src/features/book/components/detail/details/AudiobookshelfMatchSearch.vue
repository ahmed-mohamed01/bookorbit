<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library, Search } from '@lucide/vue'
import type { AudiobookshelfBookState } from '@bookorbit/types'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'

defineProps<{
  query: string
  results: AudiobookshelfBookState[]
  searching: boolean
  searchError: boolean
  hasSearched: boolean
  disabled: boolean
}>()

const emit = defineEmits<{ 'update:query': [value: string]; pick: [item: AudiobookshelfBookState] }>()

const { t } = useI18n()
const inputEl = ref<HTMLInputElement | null>(null)
const failedCovers = ref(new Set<string>())

onMounted(() => {
  inputEl.value?.focus()
})

function coverUrl(item: AudiobookshelfBookState): string {
  return audiobookshelfCoverUrl(item.absLibraryItemId)
}

function handleCoverError(item: AudiobookshelfBookState) {
  failedCovers.value = new Set(failedCovers.value).add(item.absLibraryItemId)
}

function handleInput(event: Event) {
  emit('update:query', (event.target as HTMLInputElement).value)
}

function handlePick(item: AudiobookshelfBookState) {
  emit('pick', item)
}
</script>

<template>
  <div class="mt-2.5" data-testid="abs-match-search">
    <label class="flex h-8 items-center gap-2 rounded-lg border border-input bg-background px-2.5 focus-within:ring-1 focus-within:ring-ring">
      <Search class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('book.detail.editionLink.abs.row.search.label') }}</span>
      <input
        ref="inputEl"
        type="search"
        :value="query"
        :placeholder="t('book.detail.editionLink.abs.row.search.placeholder')"
        class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        data-testid="abs-match-search-input"
        @input="handleInput"
      />
    </label>

    <div class="mt-1.5">
      <p v-if="searching" class="px-1 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.searching') }}</p>
      <p v-else-if="searchError" class="px-1 py-1.5 text-xs text-destructive" data-testid="abs-match-search-error">
        {{ t('book.detail.editionLink.searchFailed') }}
      </p>
      <ul v-else-if="results.length" class="-mx-1 flex max-h-60 flex-col gap-0.5 overflow-y-auto" data-testid="abs-match-search-results">
        <li v-for="item in results" :key="item.absLibraryItemId">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="disabled"
            data-testid="abs-match-search-result"
            @click="handlePick(item)"
          >
            <span class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
              <img
                v-if="!failedCovers.has(item.absLibraryItemId)"
                :src="coverUrl(item)"
                alt=""
                loading="lazy"
                class="size-full object-cover"
                @error="handleCoverError(item)"
              />
              <Library v-else class="size-4" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-foreground">{{ item.absTitle }}</span>
              <span v-if="item.absAuthorName" class="block truncate text-xs text-muted-foreground">{{ item.absAuthorName }}</span>
            </span>
            <span
              v-if="item.absLibraryName"
              class="max-w-20 shrink-0 truncate rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
            >
              {{ item.absLibraryName }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else-if="hasSearched" class="px-1 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.noResults') }}</p>
    </div>
  </div>
</template>
