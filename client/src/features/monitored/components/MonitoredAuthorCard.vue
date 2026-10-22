<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { BookCopy, BookOpen, Check, Headphones, Loader2, MoreHorizontal, Pause, Pencil, Play, RefreshCw, Trash2, TriangleAlert } from '@lucide/vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { relativeTimestamp } from '@/lib/relative-time'
import { fetchStatusCopy } from '../lib/fetch-status-copy'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import AuthorPlaceholder from '@/features/author/components/AuthorPlaceholder.vue'
import { refreshMonitoredAuthor } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { monitoredPortraitUrl } from '../lib/portrait-url'
import { useRefreshFeedback } from '../composables/useRefreshFeedback'

const props = defineProps<{ author: MonitoredAuthorItem; canManage: boolean }>()
const emit = defineEmits<{
  open: [id: string]
  pause: [author: MonitoredAuthorItem]
  edit: [author: MonitoredAuthorItem]
  remove: [author: MonitoredAuthorItem]
  updated: [author: MonitoredAuthorItem]
}>()
const { t } = useI18n()
const { state: refreshState, run: runRefresh } = useRefreshFeedback()
const imageFailed = ref(false)
const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.author.fetch.state,
  (state) => {
    if (timer) clearInterval(timer)
    timer = null
    now.value = new Date()
    if (state === 'failed')
      timer = setInterval(() => {
        now.value = new Date()
      }, 30_000)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
const busy = computed(() => props.author.fetch.state === 'queued' || props.author.fetch.state === 'fetching')
const showCounts = computed(() => !busy.value && (props.author.fetch.state !== 'failed' || props.author.lastRefreshedAt !== null))
const copy = computed(() => fetchStatusCopy(props.author.fetch, now.value, props.author.lastRefreshedAt !== null))

const openLabel = computed(() => t('monitored.authorCard.open', { name: props.author.authorName, count: props.author.counts.total }))
const portraitUrl = computed(() => (props.author.portraitAuthorId === null ? null : monitoredPortraitUrl(props.author.id)))

function handleOpen() {
  emit('open', props.author.id)
}

function handlePause() {
  emit('pause', props.author)
}

function handleEdit() {
  emit('edit', props.author)
}

function handleRemove() {
  emit('remove', props.author)
}

async function handleRefresh() {
  try {
    await runRefresh(async () => {
      const item = await refreshMonitoredAuthor(props.author.id)
      emit('updated', item)
    })
    toast.success(t('monitored.fetch.queued'))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

function handleImageError() {
  imageFailed.value = true
}

function stopCardClick(event: MouseEvent) {
  event.stopPropagation()
}
</script>

<template>
  <article class="group">
    <div
      class="relative aspect-2/3 overflow-hidden rounded-sm shadow-md transition-[box-shadow,transform] duration-150 group-hover:scale-[1.02] group-hover:shadow-xl"
    >
      <img
        v-if="portraitUrl && !imageFailed"
        :src="portraitUrl"
        :class="{ 'opacity-50': busy }"
        :alt="t('monitored.authorCard.portraitAlt', { name: author.authorName })"
        class="absolute inset-0 size-full object-cover"
        loading="lazy"
        decoding="async"
        @error="handleImageError"
      />
      <AuthorPlaceholder v-else :name="author.authorName" :class="{ 'opacity-50': busy }" />

      <Tooltip v-if="copy">
        <TooltipTrigger as-child>
          <span
            :class="
              busy
                ? 'absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2'
                : 'absolute right-1.5 top-1.5 z-30 rounded-full bg-background/90 p-1 text-warning'
            "
            tabindex="0"
          >
            <Loader2 v-if="busy" data-testid="fetch-spinner" :size="28" class="animate-spin text-foreground" />
            <TriangleAlert v-else data-testid="fetch-failed" :size="18" />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{{ t(copy.titleKey) }}</p>
          <p v-if="author.fetch.state === 'failed'">{{ t(copy.actionKey, copy.actionParams ?? {}) }}</p>
          <p v-if="author.fetch.state === 'failed' && author.lastRefreshedAt">
            {{ t('monitored.fetch.showingFrom', { when: relativeTimestamp(author.lastRefreshedAt) }) }}
          </p>
        </TooltipContent>
      </Tooltip>

      <!-- The hit target is the whole tile: a click target sized to the name alone leaves most of it dead. -->
      <button
        type="button"
        class="absolute inset-0 z-10 cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        :aria-label="openLabel"
        @click="handleOpen"
      />

      <span
        v-if="showCounts"
        class="pointer-events-none absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded border border-white/20 bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white"
      >
        <BookCopy :size="11" />
        {{ author.counts.total }}
      </span>

      <div v-if="showCounts" data-testid="count-pills" class="pointer-events-none absolute bottom-11 right-1.5 z-20 flex flex-col items-end gap-1">
        <span
          class="inline-flex items-center gap-1 rounded bg-background/85 px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--pill-media-ebook)] shadow-sm ring-1 ring-border backdrop-blur-[2px]"
        >
          <BookOpen :size="10" aria-hidden="true" />
          <span class="sr-only">{{ t('monitored.formats.ebooks') }}</span>
          {{ author.counts.ebookOwned }}/{{ author.counts.total }}
        </span>
        <span
          class="inline-flex items-center gap-1 rounded bg-background/85 px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--pill-media-audiobook)] shadow-sm ring-1 ring-border backdrop-blur-[2px]"
        >
          <Headphones :size="10" aria-hidden="true" />
          <span class="sr-only">{{ t('monitored.formats.audiobooks') }}</span>
          {{ author.counts.audioOwned }}/{{ author.counts.total }}
        </span>
      </div>

      <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-black/80 via-black/35 to-transparent p-2 pt-8">
        <div class="flex items-end justify-between gap-2">
          <h3 class="line-clamp-2 text-xs font-semibold leading-tight text-white">{{ author.authorName }}</h3>
          <DropdownMenu v-if="canManage">
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                :aria-label="t('monitored.authorCard.menu', { name: author.authorName })"
                class="pointer-events-auto relative z-30 flex size-7 shrink-0 items-center justify-center rounded-md bg-black/35 text-white/90 hover:bg-black/55"
                @click="stopCardClick"
              >
                <Loader2 v-if="refreshState === 'loading'" :size="14" class="animate-spin" />
                <Check v-else-if="refreshState === 'done'" :size="14" class="text-[var(--pill-success)]" />
                <MoreHorizontal v-else :size="14" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" @click="stopCardClick">
              <DropdownMenuItem :disabled="busy || refreshState === 'loading'" data-testid="refresh-author" @click="handleRefresh">
                <RefreshCw :class="busy || refreshState === 'loading' ? 'animate-spin' : ''" />
                {{ t(author.fetch.state === 'failed' ? 'monitored.fetch.retry' : 'monitored.actions.refresh') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="handlePause">
                <Play v-if="author.paused" />
                <Pause v-else />
                {{ author.paused ? t('monitored.actions.resume') : t('monitored.actions.pause') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="handleEdit">
                <Pencil />
                {{ t('monitored.actions.editSettings') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @click="handleRemove">
                <Trash2 />
                {{ t('monitored.actions.stopMonitoring') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  </article>
</template>
