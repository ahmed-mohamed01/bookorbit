<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio, BookOpen, Headphones, RefreshCw, TriangleAlert } from '@lucide/vue'
import type { CoverMedium, ReadAloudProgressSync } from '@bookorbit/types'
import type { EditionFilledSlot } from '@/features/book/composables/useLinkEditionPanel'
import { describeReadAloudSyncIssue, readAloudSyncIssue } from '@/features/book/lib/read-aloud-sync-issue'
import EditionCover from './EditionCover.vue'

const props = withDefaults(
  defineProps<{
    edition: EditionFilledSlot
    merged: boolean
    position: 'top' | 'middle' | 'bottom'
    rebuildLabel?: string | null
    rebuildDisabled?: boolean
    readAloudSync?: ReadAloudProgressSync | null
  }>(),
  { rebuildLabel: null, rebuildDisabled: false, readAloudSync: null },
)
const emit = defineEmits<{ change: []; rebuild: [] }>()

const { t } = useI18n()

const isEbook = computed(() => props.edition.format === 'ebook')
const coverMedium = computed<CoverMedium>(() => (isEbook.value ? 'ebook' : 'audio'))
const formatLabel = computed(() => {
  if (props.edition.readAlong) return t('book.detail.editionLink.readAlong.title')
  return isEbook.value ? t('book.detail.editionLink.counterpartEbook') : t('book.detail.editionLink.counterpartAudiobook')
})

const matchLabel = computed(() => {
  const match = props.edition.match
  if (!match) return null
  return match.source === 'auto' ? t('book.detail.editionLink.slot.autoMatched', { score: match.score }) : t('book.detail.editionLink.slot.selected')
})

const progress = computed(() => {
  const value = props.edition.progress
  if (typeof value !== 'number') return null
  if (value <= 0) return 0
  return Math.min(100, Math.max(1, Math.round(value)))
})

const progressLabel = computed(() => {
  if (progress.value === null) return null
  const params = { percentage: progress.value }
  return isEbook.value ? t('book.detail.editionLink.progressRead', params) : t('book.detail.editionLink.progressListened', params)
})

// Merged cards sit edge to edge, so their facing edges make room for the connector drawn between them.
const cardClass = computed(() => {
  if (!props.merged) return 'border-border bg-card px-2.5 py-2'
  const edges = { top: 'pt-0.5 pb-2', middle: 'py-2', bottom: 'pt-2 pb-0.5' }[props.position]
  return `border-transparent bg-transparent px-0 ${edges}`
})

// Only the read-along row narrates read-aloud sync, and only the failures a rebuild fixes.
const syncIssue = computed(() => (props.edition.readAlong ? readAloudSyncIssue(props.readAloudSync) : null))
const syncIssueDetail = computed(() => (syncIssue.value && props.readAloudSync ? describeReadAloudSyncIssue(props.readAloudSync, t) : null))

const route = computed(() => ({ name: 'book-detail', params: { bookId: props.edition.bookId } }))
const title = computed(() => props.edition.title ?? t('book.detail.editionLink.unknownTitle'))

function handleChange() {
  emit('change')
}

function handleRebuild() {
  emit('rebuild')
}
</script>

<template>
  <div
    class="relative z-[1] rounded-xl border transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
    :class="cardClass"
    :data-testid="`edition-slot-${edition.readAlong ? 'read-along' : edition.format}`"
  >
    <div class="flex items-center gap-2.5">
      <div class="flex w-10 shrink-0 justify-center">
        <EditionCover :book-id="edition.bookId" :medium="coverMedium" :version="edition.coverVersion" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <BookAudio v-if="edition.readAlong" class="size-3.5 shrink-0" aria-hidden="true" />
          <BookOpen v-else-if="isEbook" class="size-3.5 shrink-0" aria-hidden="true" />
          <Headphones v-else class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ formatLabel }}</span>
          <span
            v-if="edition.isThisBook"
            class="rounded-md bg-primary/15 px-1.5 py-px text-[10px] font-semibold text-primary"
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
          <button
            v-if="rebuildLabel && !syncIssue"
            type="button"
            class="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="rebuildDisabled"
            :aria-label="rebuildLabel"
            data-testid="edition-slot-rebuild"
            @click="handleRebuild"
          >
            <RefreshCw class="size-3" aria-hidden="true" />
            {{ t('book.detail.editionLink.actions.rebuild') }}
          </button>
        </div>
        <p class="truncate text-sm leading-5 font-medium text-foreground">
          <span v-if="edition.isThisBook">{{ title }}</span>
          <RouterLink v-else :to="route" class="hover:underline">{{ title }}</RouterLink>
        </p>
        <div v-if="edition.authorName || progress !== null || syncIssue" class="flex items-center gap-2 text-xs text-muted-foreground">
          <p v-if="edition.authorName" class="min-w-0 flex-1 truncate">{{ edition.authorName }}</p>
          <span
            v-if="syncIssue"
            class="ms-auto inline-flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-warning"
            :title="syncIssueDetail ?? undefined"
            data-testid="edition-slot-sync-issue"
            :data-reason="syncIssue"
          >
            <TriangleAlert class="size-3.5" aria-hidden="true" />
            {{ t('book.detail.details.readAloudSync.state.notSyncing') }}
          </span>
          <div
            v-else-if="progress !== null"
            class="ms-auto flex shrink-0 items-center gap-1.5"
            :title="progressLabel ?? undefined"
            :aria-label="progressLabel ?? undefined"
            role="img"
            data-testid="edition-slot-progress"
          >
            <div class="h-1 w-10 overflow-hidden rounded-sm bg-muted">
              <div
                class="h-full rounded-sm"
                :class="isEbook ? 'bg-[var(--pill-media-ebook)]' : 'bg-[var(--pill-media-audiobook)]'"
                :style="{ width: `${progress}%` }"
              />
            </div>
            <span class="text-[11px] tabular-nums whitespace-nowrap" aria-hidden="true">{{ progress }}%</span>
          </div>
        </div>
        <div v-if="syncIssue" class="mt-1 space-y-1 text-[11px] text-pretty text-muted-foreground" data-testid="edition-slot-sync-issue-detail">
          <p>{{ syncIssueDetail }}</p>
          <div v-if="rebuildLabel" class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="rebuildDisabled"
              data-testid="edition-slot-sync-issue-rebuild"
              @click="handleRebuild"
            >
              <RefreshCw class="size-3" aria-hidden="true" />
              {{ rebuildLabel }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
