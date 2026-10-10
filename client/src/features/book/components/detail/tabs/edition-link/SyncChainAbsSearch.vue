<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library, Search, X } from '@lucide/vue'
import type { AudiobookshelfBookState } from '@bookorbit/types'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'

const props = withDefaults(
  defineProps<{
    query: string
    results: AudiobookshelfBookState[]
    searching: boolean
    searchError: boolean
    hasSearched: boolean
    disabled: boolean
    autofocus?: boolean
  }>(),
  { autofocus: true },
)

const emit = defineEmits<{ 'update:query': [value: string]; pick: [item: AudiobookshelfBookState]; cancel: [] }>()

const { t } = useI18n()
const inputEl = ref<HTMLInputElement | null>(null)
const failedCovers = ref(new Set<string>())

onMounted(() => {
  if (props.autofocus) inputEl.value?.focus()
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

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <div class="relative z-[1] rounded-xl border border-dashed border-border bg-card px-3 pt-2.5 pb-2" data-testid="sync-chain-abs-search">
    <button
      type="button"
      class="absolute end-1.5 top-1.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      :aria-label="t('book.detail.editionLink.chain.action.cancel')"
      data-testid="sync-chain-abs-search-cancel"
      @click="handleCancel"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
    <p class="pe-8 text-sm font-semibold text-foreground">{{ t('book.detail.editionLink.chain.absSearch.title') }}</p>

    <label class="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-input bg-card px-3 focus-within:ring-1 focus-within:ring-ring">
      <Search class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref="inputEl"
        type="text"
        :value="query"
        :placeholder="t('book.detail.editionLink.chain.absSearch.placeholder')"
        :aria-label="t('book.detail.editionLink.chain.absSearch.placeholder')"
        class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        data-testid="sync-chain-abs-search-input"
        @input="handleInput"
      />
    </label>

    <div class="mt-2">
      <p v-if="searching" class="px-2 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.searching') }}</p>
      <p v-else-if="searchError" class="px-2 py-1.5 text-xs text-destructive" data-testid="sync-chain-abs-search-error">
        {{ t('book.detail.editionLink.searchFailed') }}
      </p>
      <ul v-else-if="results.length" class="flex max-h-60 flex-col gap-1 overflow-y-auto" data-testid="sync-chain-abs-search-results">
        <li v-for="item in results" :key="item.absLibraryItemId">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="disabled"
            data-testid="sync-chain-abs-search-result"
            @click="handlePick(item)"
          >
            <span class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground shadow-md">
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
              class="max-w-24 shrink-0 truncate rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
            >
              {{ item.absLibraryName }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else-if="hasSearched" class="px-2 py-1.5 text-xs text-muted-foreground">{{ t('book.detail.editionLink.noResults') }}</p>
    </div>
  </div>
</template>
