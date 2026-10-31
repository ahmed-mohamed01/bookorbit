<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookAudio, BookOpen, Headphones, Library } from '@lucide/vue'
import type { CoverMedium } from '@bookorbit/types'
import { audiobookshelfCoverUrl } from '@/features/audiobookshelf/api/audiobookshelf.api'
import type { ChainActionId, ChainCardRow, ChainFrame, ChainViewMode, EditionKey } from '@/features/book/lib/sync-chain'
import { useAnimatedNumber } from '@/composables/useAnimatedNumber'
import { cardProgress, chainText, chainTitle } from '@/features/book/lib/sync-chain-messages'
import EditionCover from './EditionCover.vue'
import SyncChainActionButton from './SyncChainActionButton.vue'
import { frameChromeClass } from './chain-ui'

const props = withDefaults(defineProps<{ row: ChainCardRow; view: ChainViewMode; frame?: ChainFrame; busy?: boolean }>(), {
  frame: 'spine',
  busy: false,
})
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

const look = computed(() => LOOK[props.row.edition])
const modify = computed(() => props.view === 'modify')
const dashed = computed(() => !props.row.linked)
const shellClass = computed(() => frameChromeClass(props.frame, dashed.value ? 'dashed' : 'plain'))
const coverClass = computed(() => (dashed.value ? 'opacity-70' : ''))
const hasActions = computed(() => modify.value && (props.row.confirm || props.row.change))
const title = computed(() => chainTitle(props.row.title, t))
const subtitle = computed(() => (props.row.subtitle ? chainText(props.row.subtitle, t) : null))
const progress = computed(() => cardProgress(props.row.progress))
const tweenTarget = ref(progress.value ?? 0)
const tweenedProgress = useAnimatedNumber(tweenTarget, 700)
const barWidth = ref(progress.value ?? 0)
const showRaw = ref(false)
const bookKey = computed(() => `${props.row.id}|${JSON.stringify(props.row.cover)}`)
// A value after a pending check, or on another book, has nothing meaningful to count from, so it shows at once.
watch(
  () => ({ value: progress.value, pending: props.row.progressPending, book: bookKey.value }),
  async (to, from) => {
    if (to.value === null) return
    const snap = from.pending || to.book !== from.book
    showRaw.value = snap
    tweenTarget.value = to.value
    if (snap || from.value !== null) {
      barWidth.value = to.value
      return
    }
    barWidth.value = 0
    await nextTick()
    requestAnimationFrame(() => requestAnimationFrame(() => (barWidth.value = progress.value ?? 0)))
  },
)
const shownProgress = computed(() => (showRaw.value ? progress.value : tweenedProgress.value))
const progressLabel = computed(() => (progress.value === null ? undefined : t(look.value.progressKey, { percentage: progress.value })))

const absCoverFailed = ref(false)
const absCoverSrc = computed(() => (props.row.cover.kind === 'abs' ? audiobookshelfCoverUrl(props.row.cover.absLibraryItemId) : null))
watch(absCoverSrc, () => {
  absCoverFailed.value = false
})

const changeButton = ref<HTMLButtonElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLElement | null>(null)
const changeDisabled = computed(() => props.busy)

function handleAbsCoverError() {
  absCoverFailed.value = true
}

function handleChange() {
  if (changeDisabled.value) return
  emit('action', 'change', props.row.id)
}

// Compact cards and cards with no Change have no button, so focus must still land on the card rather than drop to body.
function focusChange() {
  const target = changeButton.value ?? titleEl.value?.querySelector<HTMLElement>('a') ?? rootEl.value
  target?.focus()
}

defineExpose({ focusChange })

function handleAction(id: ChainActionId) {
  emit('action', id, props.row.id)
}
</script>

<template>
  <div
    ref="rootEl"
    tabindex="-1"
    class="relative z-[1] px-2 py-1.5 transition-colors"
    :class="shellClass"
    :data-edition="row.edition"
    :data-view="view"
    :data-linked="row.linked"
    data-testid="sync-chain-card"
  >
    <div class="flex items-center gap-2.5">
      <div class="flex w-9 shrink-0 justify-center" :class="coverClass">
        <EditionCover v-if="row.cover.kind === 'book'" :book-id="row.cover.bookId" :medium="look.medium" :version="row.cover.coverVersion" />
        <div v-else class="size-10 shrink-0 overflow-hidden rounded bg-muted shadow-md" data-testid="sync-chain-abs-cover">
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
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <component :is="look.icon" v-if="look.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <!-- The logo masks the row's text colour, so it reads as muted as the Lucide icons in either theme. -->
          <span
            v-else
            class="size-3.5 shrink-0 bg-current mask-[url(/assets/provider-icons/audiobookshelf.svg)] mask-contain mask-center mask-no-repeat"
            aria-hidden="true"
          />
          <span>{{ t(look.label) }}</span>
          <span
            v-if="row.external"
            class="rounded-md bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground"
            data-testid="sync-chain-external"
          >
            {{ t('book.detail.editionLink.abs.external') }}
          </span>
          <span
            v-if="row.chip"
            class="max-w-40 truncate rounded-md bg-info/15 px-1.5 py-px text-[10px] font-semibold text-info"
            data-testid="sync-chain-chip"
          >
            {{ chainText(row.chip, t) }}
          </span>
          <span v-if="hasActions" class="-my-1.5 ms-auto inline-flex items-center gap-2.5">
            <SyncChainActionButton v-if="row.confirm" :action="row.confirm" variant="link" :disabled="busy" @action="handleAction" />
            <button
              v-if="row.change"
              ref="changeButton"
              type="button"
              class="h-7 px-0.5 text-xs font-semibold text-info hover:underline aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
              :aria-disabled="changeDisabled ? 'true' : undefined"
              data-testid="sync-chain-change"
              @click="handleChange"
            >
              {{ t('book.detail.editionLink.slot.change') }}
            </button>
          </span>
        </div>

        <p ref="titleEl" class="truncate text-sm leading-5 font-medium text-foreground" :title="title" data-testid="sync-chain-title">
          <a v-if="row.href" :href="row.href" target="_blank" rel="noopener noreferrer" class="hover:underline">
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
              <div
                class="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
                :class="look.bar"
                :style="{ width: `${barWidth}%` }"
              />
            </div>
            <span class="text-[11px] tabular-nums whitespace-nowrap" aria-hidden="true">{{ shownProgress }}%</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
