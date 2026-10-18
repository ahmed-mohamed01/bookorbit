<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import type { MonitoredFormat, MonitoredWork, BookSearchOption } from '@bookorbit/types'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLibraryMatchSearch } from '../composables/useLibraryMatchSearch'
import type { MonitoredMatchAnswer } from '../composables/useWorkMatch'

/**
 * Finds a library book by hand and links it to one format of a work: "Match file" on a format with
 * no match, "Fix match" on one whose match is wrong. Fixing also offers to drop the match outright.
 */
const props = defineProps<{
  work: MonitoredWork
  format: MonitoredFormat
  saving: boolean
  /** The book this format is matched to now, which "Fix match" replaces. */
  currentBookId?: number | null
  /** The current match was linked by hand, so dropping it hands the format back to automatic. */
  linkedByHand?: boolean
}>()
const emit = defineEmits<{ answer: [format: MonitoredFormat, answer: MonitoredMatchAnswer] }>()

const { t } = useI18n()
const open = ref(false)
const search = useLibraryMatchSearch(toRef(props, 'format'))
const fixing = computed(() => props.currentBookId != null)
const results = computed(() => search.results.value.filter((book) => book.id !== props.currentBookId))
const dropLabel = computed(() => t(props.linkedByHand ? 'monitored.slot.match.matchAutomatically' : 'monitored.slot.match.unlinkCurrent'))
const formatLower = computed(() => t(props.format === 'audiobook' ? 'monitored.slot.match.audiobook' : 'monitored.slot.match.ebook'))
const hint = computed(() => {
  if (search.loading.value) return null
  if (search.failed.value) return t('monitored.slot.match.searchFailed')
  if (search.query.value.trim().length < search.minQueryLength) return t('monitored.slot.match.searchHint')
  if (results.value.length === 0) return t('monitored.slot.match.searchEmpty', { format: formatLower.value })
  return null
})

function handleOpenChange(value: boolean) {
  open.value = value
  // Starting from the work's own title is usually one edit away from the library's spelling.
  if (value) search.reset(props.work.title)
}

function describe(book: BookSearchOption): string {
  return [book.authors.join(', '), book.seriesName, book.libraryName].filter(Boolean).join(' · ')
}

function handlePick(book: BookSearchOption) {
  open.value = false
  emit('answer', props.format, { decision: 'link', bookId: book.id })
}

function handleDrop() {
  open.value = false
  if (props.linkedByHand || props.currentBookId == null) emit('answer', props.format, { decision: 'automatic' })
  else emit('answer', props.format, { decision: 'reject', bookId: props.currentBookId })
}
</script>

<template>
  <Popover :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="shrink-0 rounded-sm px-1 text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
        :class="fixing ? 'h-[22px]' : 'ms-auto'"
        :disabled="saving"
        :data-testid="fixing ? 'fix-match' : 'match-file'"
      >
        {{ t(fixing ? 'monitored.slot.match.fix' : 'monitored.slot.match.matchFile') }}
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 max-w-[calc(100vw-2rem)] p-0">
      <div class="border-b border-border p-2">
        <Input
          v-model="search.query.value"
          class="h-8 text-xs"
          :placeholder="t('monitored.slot.match.searchPlaceholder')"
          :aria-label="t('monitored.slot.match.searchPlaceholder')"
          data-testid="match-file-input"
        />
      </div>
      <div class="max-h-72 overflow-y-auto p-1" role="listbox" :aria-label="t('monitored.slot.match.matchFile')">
        <div v-if="search.loading.value" class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <Loader2 :size="13" class="motion-safe:animate-spin" aria-hidden="true" />
          {{ t('monitored.slot.match.searching') }}
        </div>
        <p v-else-if="hint" class="px-2 py-3 text-xs text-muted-foreground" data-testid="match-file-hint">{{ hint }}</p>
        <template v-else>
          <button
            v-for="book in results"
            :key="book.id"
            type="button"
            role="option"
            :aria-selected="false"
            class="flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            data-testid="match-file-result"
            @click="handlePick(book)"
          >
            <span class="w-full truncate text-xs font-medium text-foreground">{{ book.title ?? t('monitored.slot.match.untitled') }}</span>
            <span class="w-full truncate text-[11px] text-muted-foreground">{{ describe(book) }}</span>
          </button>
        </template>
        <p
          v-if="search.truncated.value && !search.loading.value"
          class="px-2 py-1.5 text-[11px] text-muted-foreground"
          data-testid="match-file-truncated"
        >
          {{ t('monitored.slot.match.searchTruncated') }}
        </p>
      </div>
      <div v-if="fixing" class="border-t border-border p-1">
        <button
          type="button"
          class="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
          data-testid="match-file-drop"
          @click="handleDrop"
        >
          {{ dropLabel }}
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
