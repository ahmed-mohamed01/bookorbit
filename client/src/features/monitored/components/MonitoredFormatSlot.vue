<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight, Bell, BellOff, BookOpen, ChevronUp, Folder, Headphones, Search } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { BookDetail, MonitorMode, MonitoredFormat, MonitoredWork } from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useFormatSlotState } from '../composables/useFormatSlotState'
import type { MonitoredReleaseRow } from '../composables/useReleaseRows'
import type { MonitoredFormatStatus } from '../lib/format-status'
import MonitoredOwnedTree from './MonitoredOwnedTree.vue'
import MonitoredSlotDates from './MonitoredSlotDates.vue'
import MonitoredSlotRequest from './MonitoredSlotRequest.vue'

/** One format of a monitored work: what is in the library for it, or what is being done to get it. */
const props = defineProps<{
  work: MonitoredWork
  format: MonitoredFormat
  status: MonitoredFormatStatus
  /** May send requests and change what is watched, and the author monitors this format. */
  canEdit: boolean
  /** The author monitors this format at all. */
  authorWatches: boolean
  /** May look release dates up and change them. */
  canManage: boolean
  /** Where the author's monitored page is, when the panel is not already on it. */
  authorRoute?: { name: string; params: { id: string } } | null
  /** The author's mode for this format. */
  mode?: MonitorMode | null
  /** The library book holding this format, once loaded. */
  book?: BookDetail | null
  bookError?: boolean
  row: MonitoredReleaseRow
  datesOpen: boolean
  refreshing: boolean
  requesting: boolean
  releasesOpen: boolean
}>()
const emit = defineEmits<{
  request: [format: MonitoredFormat, autoDownload: boolean]
  'toggle-releases': [format: MonitoredFormat]
  'toggle-monitor': [format: MonitoredFormat, value: boolean]
  'dates-open-change': [format: MonitoredFormat, open: boolean]
  'date-set': [format: MonitoredFormat, releaseDate: string]
  'date-clear': [format: MonitoredFormat]
  'refresh-dates': []
  'retry-book': [format: MonitoredFormat]
  filed: [requestId: number]
}>()

defineSlots<{ releases(props: { canRequest: boolean }): unknown }>()

const { t } = useI18n()

const state = useFormatSlotState(props, (id) => emit('filed', id))
const icon = computed(() => (props.format === 'audiobook' ? Headphones : BookOpen))
const iconTone = computed(() => (props.format === 'audiobook' ? 'text-[var(--pill-media-audiobook)]' : 'text-[var(--pill-media-ebook)]'))
const formatLower = computed(() => state.formatName.value.toLowerCase())
const ownedReleasesLabel = computed(() => (props.releasesOpen ? t('monitored.slot.hideReleases') : t('monitored.slot.findAnotherRelease')))
const watchLabel = computed(() => t('monitored.slot.watchFormat', { format: formatLower.value }))

function handleToggleWatch() {
  emit('toggle-monitor', props.format, !state.watching.value)
}

function handleRequest(format: MonitoredFormat) {
  emit('request', format, true)
}

function handleToggleReleases() {
  emit('toggle-releases', props.format)
}

function handleDatesOpenChange(format: MonitoredFormat, open: boolean) {
  emit('dates-open-change', format, open)
}

function handleDateSet(format: MonitoredFormat, releaseDate: string) {
  emit('date-set', format, releaseDate)
}

function handleDateClear(format: MonitoredFormat) {
  emit('date-clear', format)
}

function handleRefreshDates() {
  emit('refresh-dates')
}

function handleRetryBook() {
  emit('retry-book', props.format)
}
</script>

<template>
  <section
    class="border-t border-border py-2.5 first-of-type:border-t-0 first-of-type:pt-1 last-of-type:pb-0"
    :data-format="format"
    :data-status="status"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <component :is="icon" :size="15" :class="iconTone" aria-hidden="true" />
        <h3 class="text-[13px] font-semibold text-foreground">{{ state.formatName.value }}</h3>
      </div>

      <div v-if="state.owned.value" class="flex items-center gap-1.5">
        <span class="text-xs text-[var(--pill-success)]">{{ t('monitored.slot.inLibrary') }}</span>
        <RouterLink
          v-if="state.bookRoute.value"
          :to="state.bookRoute.value"
          class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-label="t('monitored.panel.openBookFormat', { format: formatLower })"
          :title="t('monitored.panel.openBook')"
          data-testid="library-link"
        >
          <ArrowUpRight :size="14" aria-hidden="true" />
        </RouterLink>
        <button
          v-if="canEdit"
          type="button"
          class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:w-6 max-sm:justify-center max-sm:px-0 [@media(pointer:coarse)]:min-h-11"
          :aria-expanded="releasesOpen"
          :aria-label="ownedReleasesLabel"
          :title="ownedReleasesLabel"
          data-testid="owned-releases-toggle"
          @click="handleToggleReleases"
        >
          <ChevronUp v-if="releasesOpen" :size="12" aria-hidden="true" />
          <Search v-else :size="12" aria-hidden="true" />
          <span class="max-sm:hidden">{{ ownedReleasesLabel }}</span>
        </button>
      </div>

      <div v-else class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <TooltipProvider v-if="canEdit">
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                role="switch"
                class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
                :class="state.watching.value ? 'text-primary' : 'text-muted-foreground'"
                :aria-checked="state.watching.value"
                :aria-label="watchLabel"
                data-testid="watch-toggle"
                @click="handleToggleWatch"
              >
                <Bell v-if="state.watching.value" :size="13" aria-hidden="true" />
                <BellOff v-else :size="13" aria-hidden="true" />
                {{ state.watching.value ? t('monitored.slot.watching') : t('monitored.slot.notWatching') }}
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ state.watchTooltip.value }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div
          class="flex items-center [&>*]:rounded-none [&>*+*]:-ms-px [&>:first-child]:rounded-s-md [&>:last-child]:rounded-e-md"
          data-testid="slot-actions"
        >
          <button
            v-if="canEdit"
            type="button"
            :disabled="state.releasesBlockedHint.value !== null"
            class="inline-flex h-7 shrink-0 items-center gap-1 border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
            :aria-expanded="releasesOpen"
            :aria-label="state.releasesToggleLabel.value"
            :title="state.releasesBlockedHint.value ?? state.releasesToggleLabel.value"
            data-testid="releases-toggle"
            @click="handleToggleReleases"
          >
            <ChevronUp v-if="releasesOpen" :size="13" aria-hidden="true" />
            <Search v-else :size="13" aria-hidden="true" />
            <span class="hidden sm:inline">{{ releasesOpen ? t('monitored.slot.hideReleases') : t('monitored.slot.releasesButton') }}</span>
          </button>
          <MonitoredSlotRequest
            :format="format"
            :kind="state.requestKind.value"
            :request-route="state.requestRoute.value"
            :can-request="state.canRequest.value"
            :busy="requesting"
            :hint="state.requestHint.value"
            @request="handleRequest"
          />
        </div>
      </div>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 pt-2">
      <!-- The dates float so a long path or file name can run under them once the tree opens. -->
      <div v-if="state.owned.value" class="col-span-2 flow-root">
        <div class="float-end ms-4 mb-1 flex flex-col items-end gap-0.5 text-end text-xs text-muted-foreground">
          <i18n-t
            v-if="state.releasedOn.value"
            :keypath="state.releasedOn.value.yearOnly ? 'monitored.slot.releasedIn' : 'monitored.slot.released'"
            tag="span"
          >
            <template #date
              ><span class="text-foreground">{{ state.releasedOn.value.date }}</span></template
            >
          </i18n-t>
          <i18n-t v-if="state.availableSince.value" keypath="monitored.slot.availableSince" tag="span">
            <template #date
              ><span class="text-foreground">{{ state.availableSince.value.date }}</span></template
            >
          </i18n-t>
        </div>
        <MonitoredOwnedTree
          v-if="state.ownedBody.value === 'file' && state.fileName.value"
          class="min-w-0"
          :format="format"
          :library-name="book?.libraryName ?? ''"
          :library-id="book?.libraryId"
          :file-name="state.fileName.value"
          :file-path="state.filePath.value"
          :files="book?.files"
        />
        <div
          v-else-if="state.ownedBody.value === 'error'"
          class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
          role="alert"
          data-testid="owned-error"
        >
          <p class="text-xs text-destructive">{{ t('monitored.slot.ownedLoadFailed') }}</p>
          <button
            type="button"
            class="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:min-h-11"
            data-testid="owned-retry"
            @click="handleRetryBook"
          >
            {{ t('monitored.slot.ownedRetry') }}
          </button>
        </div>
        <div v-else-if="state.ownedBody.value === 'loading'" class="h-10 min-w-0 animate-pulse rounded-md bg-muted" aria-hidden="true" />
        <p v-else class="flex min-w-0 items-center text-xs text-muted-foreground" data-testid="owned-no-file">
          {{ t('monitored.slot.ownedNoFile') }}
        </p>
      </div>
      <template v-else>
        <p class="flex min-w-0 items-center gap-1.5 text-muted-foreground" data-testid="not-in-library">
          <Folder :size="12" class="shrink-0" aria-hidden="true" />
          <span class="truncate font-mono text-[11.5px]">{{ t('monitored.slot.notInLibrary') }}</span>
        </p>
        <div class="flex flex-col items-end gap-0.5 text-end text-xs text-muted-foreground">
          <div class="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
            <MonitoredSlotDates
              :format="format"
              :row="row"
              :label="state.chipLabel.value"
              :open="datesOpen"
              :can-manage="canManage"
              :refreshing="refreshing"
              @open-change="handleDatesOpenChange"
              @set="handleDateSet"
              @clear="handleDateClear"
              @refresh="handleRefreshDates"
            />
          </div>
        </div>
      </template>

      <div v-if="!state.owned.value && (state.statusLine.value || state.releasesBlockedHint.value)" class="col-span-2 space-y-0.5">
        <p v-if="state.statusLine.value" class="text-xs" :class="state.statusLine.value.tone" data-testid="slot-status">
          {{ state.statusLine.value.text }}
          <RouterLink
            v-if="state.statusLine.value.authorLink && authorRoute"
            :to="authorRoute"
            class="font-medium text-foreground underline-offset-2 hover:underline"
            data-testid="slot-author-link"
            >{{ t('monitored.slot.openAuthor') }}</RouterLink
          >
        </p>
        <p v-if="state.releasesBlockedHint.value" class="text-xs text-muted-foreground" data-testid="releases-blocked">
          {{ state.releasesBlockedHint.value }}
        </p>
      </div>
    </div>

    <div v-if="releasesOpen" class="mt-2.5 border-t border-border pt-2.5" data-testid="slot-releases">
      <p v-if="state.owned.value" class="mb-2 text-xs text-muted-foreground" data-testid="owned-releases-note">
        {{ t('monitored.slot.ownedReleasesNote', { format: formatLower }) }}
      </p>
      <slot name="releases" :can-request="state.requestOffered.value" />
    </div>
  </section>
</template>
