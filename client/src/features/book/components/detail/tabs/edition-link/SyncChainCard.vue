<script setup lang="ts">
import { computed, ref, useId, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio, BookOpen, Headphones, Library } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'
import type { ChainActionId, ChainCardRow, ChainViewMode, EditionKey } from '@/features/book/lib/sync-chain'
import { cardProgress, chainTitle } from '@/features/book/lib/sync-chain-messages'
import EditionCover from './EditionCover.vue'
import ReadAlongStepper from './ReadAlongStepper.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'

const props = defineProps<{ row: ChainCardRow; view: ChainViewMode }>()
const emit = defineEmits<{ action: [id: ChainActionId, rowKey: string] }>()

const { t } = useI18n()

interface EditionLook {
  icon: Component | null
  label: string
  medium: CoverMedium
  bar: string
  progressKey: string
}

const LOOK: Record<EditionKey, EditionLook> = {
  ebook: {
    icon: BookOpen,
    label: 'book.detail.editionLink.chain.short.ebook',
    medium: 'ebook',
    bar: 'bg-[var(--pill-media-ebook)]',
    progressKey: 'book.detail.editionLink.progressRead',
  },
  readAlong: {
    icon: BookAudio,
    label: 'book.detail.editionLink.chain.short.readAlong',
    medium: 'ebook',
    bar: 'bg-[var(--pill-media-ebook)]',
    progressKey: 'book.detail.editionLink.progressRead',
  },
  audiobook: {
    icon: Headphones,
    label: 'book.detail.editionLink.chain.short.audiobook',
    medium: 'audio',
    bar: 'bg-[var(--pill-media-audiobook)]',
    progressKey: 'book.detail.editionLink.progressListened',
  },
  abs: {
    icon: null,
    label: 'book.detail.editionLink.chain.kind.abs',
    medium: 'audio',
    bar: 'bg-[var(--pill-media-audiobook)]',
    progressKey: 'book.detail.editionLink.progressListened',
  },
}

const SHELL_CLASS: Record<ChainViewMode, string> = {
  modify: 'rounded-xl border bg-card px-2.5 py-2',
  compact: 'border border-transparent px-0 py-1',
}

const look = computed(() => LOOK[props.row.edition])
const modify = computed(() => props.view === 'modify')
const shellClass = computed(() => [SHELL_CLASS[props.view], modify.value ? (props.row.isThisBook ? 'border-primary' : 'border-border') : ''])
const title = computed(() => chainTitle(props.row.title, t))
const subtitle = computed(() =>
  props.row.edition === 'abs' && props.row.subtitle ? t('book.detail.editionLink.abs.library', { name: props.row.subtitle }) : props.row.subtitle,
)
const progress = computed(() => cardProgress(props.row.progress))
const progressLabel = computed(() => (progress.value === null ? undefined : t(look.value.progressKey, { percentage: progress.value })))
const route = computed(() => ({ name: 'book-detail', params: { bookId: props.row.routeBookId } }))

const absCoverFailed = ref(false)
const absCoverSrc = computed(() => (props.row.cover.kind === 'abs' ? audiobookshelfCoverUrl(props.row.cover.absLibraryItemId) : null))
watch(absCoverSrc, () => {
  absCoverFailed.value = false
})

const changeHintId = `sync-chain-change-hint-${useId()}`
const changeButton = ref<HTMLButtonElement | null>(null)
const changeBlocked = computed(() => props.row.change === 'blocked')

function handleAbsCoverError() {
  absCoverFailed.value = true
}

function handleChange() {
  if (changeBlocked.value) return
  emit('action', 'change', props.row.id)
}

function focusChange() {
  changeButton.value?.focus()
}

defineExpose({ focusChange })

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}
</script>

<template>
  <div
    class="relative z-[1] transition-colors"
    :class="shellClass"
    :data-edition="row.edition"
    :data-view="view"
    :data-this-book="row.isThisBook || undefined"
    data-testid="sync-chain-card"
  >
    <div class="flex items-center gap-2.5">
      <div class="flex w-10 shrink-0 justify-center">
        <EditionCover v-if="row.cover.kind === 'book'" :book-id="row.cover.bookId" :medium="look.medium" :version="row.cover.coverVersion" />
        <div
          v-else-if="row.cover.kind === 'abs'"
          class="size-10 shrink-0 overflow-hidden rounded bg-muted shadow-md"
          data-testid="sync-chain-abs-cover"
        >
          <img
            v-if="!absCoverFailed && absCoverSrc"
            :src="absCoverSrc"
            alt=""
            loading="lazy"
            class="size-full object-cover"
            @error="handleAbsCoverError"
          />
          <div v-else class="flex size-full items-center justify-center text-muted-foreground" data-testid="sync-chain-abs-cover-fallback">
            <Library class="size-4" aria-hidden="true" />
          </div>
        </div>
        <div
          v-else
          class="flex h-12 w-8 items-center justify-center rounded bg-success/15 text-success shadow-md"
          data-testid="sync-chain-read-along-tile"
        >
          <BookAudio class="size-4" aria-hidden="true" />
        </div>
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <component :is="look.icon" v-if="look.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <!-- The logo masks the row's text colour, so it reads as muted as the Lucide icons in either theme. -->
          <span
            v-else
            class="size-3.5 shrink-0 bg-current mask-[url(/assets/provider-icons/audiobookshelf.svg)] mask-contain mask-center mask-no-repeat"
            aria-hidden="true"
          />
          <span>{{ t(look.label) }}</span>
          <span
            v-if="row.isThisBook"
            class="rounded-md bg-primary/15 px-1.5 py-px text-[10px] font-semibold text-primary"
            data-testid="sync-chain-this-book"
          >
            {{ t('book.detail.editionLink.thisBook') }}
          </span>
          <span
            v-if="row.external"
            class="rounded-md bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground"
            data-testid="sync-chain-external"
          >
            {{ t('book.detail.editionLink.abs.external') }}
          </span>
          <span v-if="modify && (row.rebuild || row.change !== 'none')" class="ms-auto inline-flex items-center gap-2.5">
            <SyncChainActionButton v-if="row.rebuild" :action="row.rebuild" variant="link" @action="handleAction" />
            <button
              v-if="row.change !== 'none'"
              ref="changeButton"
              type="button"
              class="h-7 px-0.5 text-xs font-semibold text-info hover:underline aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
              :aria-disabled="changeBlocked ? 'true' : undefined"
              :aria-describedby="changeBlocked ? changeHintId : undefined"
              data-testid="sync-chain-change"
              @click="handleChange"
            >
              {{ t('book.detail.editionLink.slot.change') }}
            </button>
          </span>
        </div>

        <p
          v-if="modify && changeBlocked"
          :id="changeHintId"
          class="text-[11px] leading-snug text-pretty text-muted-foreground"
          data-testid="sync-chain-change-hint"
        >
          {{ t('book.detail.editionLink.chain.change.blocked') }}
        </p>

        <p class="truncate text-sm leading-5 font-medium text-foreground" data-testid="sync-chain-title">
          <RouterLink v-if="row.routeBookId !== null" :to="route" class="hover:underline">{{ title }}</RouterLink>
          <a v-else-if="row.href" :href="row.href" target="_blank" rel="noopener noreferrer" class="hover:underline">
            {{ title }}
            <span class="sr-only">{{ t('book.detail.editionLink.abs.opensNewTab') }}</span>
          </a>
          <span v-else>{{ title }}</span>
        </p>

        <div v-if="subtitle || progress !== null || row.progressPending" class="flex items-center gap-2 text-xs text-muted-foreground">
          <p class="min-w-0 flex-1 truncate">{{ subtitle }}</p>
          <span
            v-if="row.progressPending"
            class="ms-auto h-1 w-10 shrink-0 animate-pulse rounded-sm bg-muted"
            :aria-label="t('book.detail.editionLink.abs.checking')"
            role="img"
            data-testid="sync-chain-progress-pending"
          />
          <div
            v-else-if="progress !== null"
            class="ms-auto flex shrink-0 items-center gap-1.5"
            :title="progressLabel"
            :aria-label="progressLabel"
            role="img"
            data-testid="sync-chain-progress"
          >
            <div class="h-1 w-12 overflow-hidden rounded-full bg-muted">
              <div class="h-full rounded-full" :class="look.bar" :style="{ width: `${progress}%` }" />
            </div>
            <span class="text-[11px] tabular-nums whitespace-nowrap" aria-hidden="true">{{ progress }}%</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="row.job" class="mt-2 flex flex-col gap-1.5 ps-[50px]" data-testid="sync-chain-card-job">
      <div class="flex items-center gap-2">
        <ReadAlongStepper class="min-w-0 flex-1" :stage="row.job.stage" :remote-progress="row.job.remoteProgress" :failed="row.job.failed" />
        <SyncChainActionButton v-if="modify && row.job.cancel" :action="row.job.cancel" variant="cancel" @action="handleAction" />
      </div>
      <p v-if="row.job.error" class="text-xs break-words text-muted-foreground" data-testid="sync-chain-card-job-error">{{ row.job.error }}</p>
      <div v-if="modify && row.job.retry" class="flex">
        <SyncChainActionButton :action="row.job.retry" @action="handleAction" />
      </div>
    </div>
  </div>
</template>
