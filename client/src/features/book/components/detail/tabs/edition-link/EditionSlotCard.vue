<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Headphones } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import type { EditionFilledSlot } from '@/features/book/composables/useLinkEditionPanel'
import EditionCover from './EditionCover.vue'

const props = defineProps<{ edition: EditionFilledSlot; merged: boolean; position: 'top' | 'bottom' }>()
const emit = defineEmits<{ change: [] }>()

const { t } = useI18n()

const isEbook = computed(() => props.edition.format === 'ebook')
const coverMedium = computed<CoverMedium>(() => (isEbook.value ? 'ebook' : 'audio'))
const formatLabel = computed(() =>
  isEbook.value ? t('book.detail.editionLink.counterpartEbook') : t('book.detail.editionLink.counterpartAudiobook'),
)

const matchLabel = computed(() => {
  const match = props.edition.match
  if (!match) return null
  return match.source === 'auto' ? t('book.detail.editionLink.slot.autoMatched', { score: match.score }) : t('book.detail.editionLink.slot.selected')
})

const progress = computed(() => {
  const value = props.edition.progress
  if (typeof value !== 'number' || value <= 0) return null
  return Math.min(100, Math.max(0, Math.round(value)))
})

const progressLabel = computed(() => {
  if (progress.value === null) return null
  const params = { percentage: progress.value }
  return isEbook.value ? t('book.detail.editionLink.progressRead', params) : t('book.detail.editionLink.progressListened', params)
})

// Merged cards sit edge to edge, so their facing edges make room for the connector drawn between them.
const cardClass = computed(() => {
  if (!props.merged) return 'border-border bg-background'
  return `border-transparent bg-transparent ${props.position === 'top' ? 'pb-4' : 'pt-4'}`
})

const route = computed(() => ({ name: 'book-detail', params: { bookId: props.edition.bookId } }))
const title = computed(() => props.edition.title ?? t('book.detail.editionLink.unknownTitle'))

function handleChange() {
  emit('change')
}
</script>

<template>
  <div
    class="relative z-[1] rounded-xl border p-2.5 transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
    :class="cardClass"
    :data-testid="`edition-slot-${edition.format}`"
  >
    <div class="flex items-center gap-3">
      <EditionCover :book-id="edition.bookId" :medium="coverMedium" :version="edition.coverVersion" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <BookOpen v-if="isEbook" class="size-3.5 shrink-0" aria-hidden="true" />
          <Headphones v-else class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ formatLabel }}</span>
          <span
            v-if="edition.isThisBook"
            class="rounded-md bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
            data-testid="edition-slot-this-book"
          >
            {{ t('book.detail.editionLink.thisBook') }}
          </span>
          <span v-if="matchLabel" class="rounded-md bg-info/15 px-1.5 py-px text-[10px] font-semibold text-info" data-testid="edition-slot-match">
            {{ matchLabel }}
          </span>
          <button
            v-if="edition.canChange"
            type="button"
            class="ms-auto text-xs text-info hover:underline"
            data-testid="edition-slot-change"
            @click="handleChange"
          >
            {{ t('book.detail.editionLink.slot.change') }}
          </button>
        </div>
        <p class="mt-0.5 truncate text-sm font-medium text-foreground">
          <span v-if="edition.isThisBook">{{ title }}</span>
          <RouterLink v-else :to="route" class="hover:underline">{{ title }}</RouterLink>
        </p>
        <p v-if="edition.authorName" class="truncate text-xs text-muted-foreground">{{ edition.authorName }}</p>
        <div v-if="progress !== null" class="mt-1.5 flex items-center gap-2" data-testid="edition-slot-progress">
          <div class="h-1 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              class="h-full rounded-sm"
              :class="isEbook ? 'bg-[var(--pill-media-ebook)]' : 'bg-[var(--pill-media-audiobook)]'"
              :style="{ width: `${progress}%` }"
            />
          </div>
          <span class="text-[11px] whitespace-nowrap text-muted-foreground">{{ progressLabel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
