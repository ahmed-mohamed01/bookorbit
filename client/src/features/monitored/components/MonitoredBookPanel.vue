<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Check, Headphones, Loader2, Search, Eye, EyeOff, X } from '@lucide/vue'
import type { MonitoredDatePrecision, MonitoredFormat, MonitoredWork, ReleaseCandidateItem } from '@bookorbit/types'
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { useBookDetail } from '@/features/book/composables/useBookDetail'
import { useSafeHtml } from '@/features/book/composables/useSafeHtml'
import { useMonitoredReleases } from '../composables/useMonitoredReleases'
import { monitoredReleaseWindowStarted, parseMonitoredDate } from '../lib/release-date'
import MonitoredFormatPill from './MonitoredFormatPill.vue'
import MonitoredRequestProgress from './MonitoredRequestProgress.vue'
import MonitoredWorkFiles from './MonitoredWorkFiles.vue'
import ReleaseResultRow from './ReleaseResultRow.vue'

type PanelTab = 'details' | 'files' | 'ebook' | 'audiobook'

const props = defineProps<{
  work: MonitoredWork | null
  authorName: string
  canManage: boolean
  monitoredFormats?: MonitoredFormat[]
  open: boolean
}>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  request: [work: MonitoredWork, format: MonitoredFormat, autoDownload: boolean]
  grabbed: [work: MonitoredWork, format: MonitoredFormat, requestId: number]
  filed: [work: MonitoredWork, requestId: number]
  'toggle-monitor': [work: MonitoredWork, format: MonitoredFormat, value: boolean]
  'toggle-hidden': [work: MonitoredWork, value: boolean]
}>()

const { t, d } = useI18n()

const activeTab = ref<PanelTab>('details')
const imageFailed = ref(false)
const autoDownload = ref(true)

const workIdRef = computed<string | null>(() => props.work?.id ?? null)
const coverUrl = computed(() => toMonitoredCoverUrl(props.work?.coverUrl))
const fallbackStyle = computed(() => bookCoverStyle(props.work?.title ?? ''))

const seriesLine = computed(() => {
  const work = props.work
  if (!work?.seriesName) return null
  return work.seriesIndex != null ? `${work.seriesName} #${work.seriesIndex}` : work.seriesName
})

const headerMeta = computed(() => {
  const parts: string[] = [props.authorName]
  if (seriesLine.value) parts.push(seriesLine.value)
  if (props.work?.releaseYear != null) parts.push(String(props.work.releaseYear))
  return parts.filter(Boolean).join(' · ')
})

const safeDescription = useSafeHtml(() => props.work?.description)

const flagLabels = computed(() => (props.work?.flags ?? []).map((flag) => t(`monitored.panel.flags.${flag}`)))
const showVerdict = computed(() => props.work != null && props.work.verdict !== 'verified')

const { detail, loading: detailLoading, fetch: fetchDetail } = useBookDetail()
// The ebook and the audiobook are separate library rows; matchedBookIds carries each format's
// row so the Files tab can show both file trees, not just the primary match's.
const { detail: secondaryDetail, fetch: fetchSecondaryDetail } = useBookDetail()
const secondaryBookId = computed(() => {
  const ids = props.work?.matchedBookIds
  if (!ids) return null
  const primary = props.work?.matchedBookId
  return [ids.ebook, ids.audiobook].find((id) => id != null && id !== primary) ?? null
})

const ebookReleases = useMonitoredReleases(workIdRef, 'ebook')
const audioReleases = useMonitoredReleases(workIdRef, 'audiobook')
const activeReleases = computed(() => (activeTab.value === 'audiobook' ? audioReleases : ebookReleases))
const activeFormat = computed<MonitoredFormat>(() => (activeTab.value === 'audiobook' ? 'audiobook' : 'ebook'))

/**
 * Which row a grab made in this panel session came from, per work and format, so the request that
 * grab created can report itself under the release it was taken from rather than somewhere else on
 * the tab. Keyed rather than a single slot because the two format tabs each have their own request.
 */
const grabbedRows = ref<Record<string, { releaseKey: string; requestId: number }>>({})

/**
 * The download this panel is watching has landed in the library. The panel itself holds no owned
 * state - the work it renders belongs to the page behind it - so this only reports the moment, and
 * the page refetches the work it is now wrong about.
 */
function handleProgressFiled(requestId: number) {
  if (props.work) emit('filed', props.work, requestId)
}

function releaseKey(release: ReleaseCandidateItem): string {
  return `${release.indexerId}:${release.guid}`
}

const activeGrabKey = computed(() => (props.work ? `${props.work.id}:${activeFormat.value}` : null))
const activeGrab = computed(() => (activeGrabKey.value ? (grabbedRows.value[activeGrabKey.value] ?? null) : null))

/**
 * The request this work and format is downloading under. The local marker leads so a fresh grab
 * reports immediately whatever the parent does with the work, and the work's own id carries the
 * case this panel did not create: a queued book reopened later still has progress to show.
 */
const activeRequestId = computed<number | null>(() => activeGrab.value?.requestId ?? props.work?.requestIds?.[activeFormat.value] ?? null)

/** Only a row grabbed here can be named, so only that one expands. */
const expandedReleaseKey = computed(() => (activeRequestId.value === null ? null : (activeGrab.value?.releaseKey ?? null)))
const expandedRowOnScreen = computed(
  () => expandedReleaseKey.value !== null && activeReleases.value.releases.value.some((release) => releaseKey(release) === expandedReleaseKey.value),
)

/**
 * Where the block goes when no row owns it: a request that predates this panel session, or one
 * whose row has been searched away. Above the list, because it is the first thing to read.
 */
const topProgressRequestId = computed(() => (expandedRowOnScreen.value ? null : activeRequestId.value))

const tabs = computed<{ key: PanelTab; label: string }[]>(() => [
  { key: 'details', label: t('monitored.panel.tabs.details') },
  { key: 'files', label: t('monitored.panel.tabs.files') },
  { key: 'ebook', label: t('monitored.panel.tabs.ebookReleases') },
  { key: 'audiobook', label: t('monitored.panel.tabs.audiobookReleases') },
])

function isFormatMonitored(format: MonitoredFormat): boolean {
  return props.monitoredFormats == null || props.monitoredFormats.includes(format)
}

const ebookOwned = computed(() => Boolean(props.work?.ownedFormats.includes('ebook') || props.work?.matchedBookIds?.ebook != null))
const audiobookOwned = computed(() => Boolean(props.work?.ownedFormats.includes('audiobook') || props.work?.matchedBookIds?.audiobook != null))
const ebookQueued = computed(() => !ebookOwned.value && props.work?.requestIds.ebook != null)
const audiobookQueued = computed(() => !audiobookOwned.value && props.work?.requestIds.audiobook != null)
const monitorEbookOn = computed(() => props.work?.monitorFormats?.ebook !== false)
const monitorAudiobookOn = computed(() => props.work?.monitorFormats?.audiobook !== false)
const ebookReleaseStarted = computed(() => monitoredReleaseWindowStarted(props.work?.ebookReleaseDate, props.work?.ebookDatePrecision))
const audiobookReleaseStarted = computed(() => monitoredReleaseWindowStarted(props.work?.audioReleaseDate, props.work?.audioDatePrecision))
const isHidden = computed(() => {
  const work = props.work
  if (!work) return false
  if (work.userVisibility === 'hidden') return true
  if (work.userVisibility === 'visible') return false
  return work.verdict !== 'verified' || work.flags.length > 0
})
const pillBase = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors'
const pillMuted = 'border-border bg-muted text-muted-foreground hover:text-foreground'

function toggleMonitor(format: MonitoredFormat) {
  if (!props.work) return
  const next = format === 'ebook' ? !monitorEbookOn.value : !monitorAudiobookOn.value
  emit('toggle-monitor', props.work, format, next)
}

function handleToggleEbookMonitor() {
  toggleMonitor('ebook')
}

function handleToggleAudiobookMonitor() {
  toggleMonitor('audiobook')
}

function toggleHidden() {
  if (props.work) emit('toggle-hidden', props.work, !isHidden.value)
}
const showEbookRequest = computed(() => props.canManage && isFormatMonitored('ebook'))
const showAudiobookRequest = computed(() => props.canManage && isFormatMonitored('audiobook'))
const showAutoDownload = computed(
  () =>
    (showEbookRequest.value && !ebookOwned.value && !ebookQueued.value) ||
    (showAudiobookRequest.value && !audiobookOwned.value && !audiobookQueued.value),
)

function resetReleaseState() {
  grabbedRows.value = {}
  for (const source of [ebookReleases, audioReleases]) {
    source.releases.value = []
    source.searched.value = false
    source.error.value = null
    source.loading.value = false
  }
}

watch(
  () => props.work?.id ?? null,
  () => {
    activeTab.value = 'details'
    imageFailed.value = false
    autoDownload.value = true
    resetReleaseState()
    if (props.work?.matchedBookId != null) void fetchDetail(props.work.matchedBookId)
    if (secondaryBookId.value != null) void fetchSecondaryDetail(secondaryBookId.value)
  },
  { immediate: true },
)

function formatReleaseDate(value: string | null, precision: MonitoredDatePrecision | null): string | null {
  const parsed = parseMonitoredDate(value, precision)
  if (!parsed) return null
  if (parsed.precision === 'year') return String(parsed.date.getFullYear())
  if (parsed.precision === 'month') return d(parsed.date, { year: 'numeric', month: 'long' })
  return d(parsed.date, { year: 'numeric', month: 'long', day: 'numeric' })
}

const ebookReleaseLabel = computed(() => (props.work ? formatReleaseDate(props.work.ebookReleaseDate, props.work.ebookDatePrecision) : null))
const audioReleaseLabel = computed(() => (props.work ? formatReleaseDate(props.work.audioReleaseDate, props.work.audioDatePrecision) : null))

function selectTab(tab: PanelTab) {
  activeTab.value = tab
}

function handleOpenChange(value: boolean) {
  emit('update:open', value)
}

function handleImageError() {
  imageFailed.value = true
}

function handleSearchReleases() {
  void activeReleases.value.search()
}

/**
 * A grab hands the work over to the Requests pipeline, and the row it was taken from opens to show
 * that pipeline running. The panel stays where it is: being thrown onto another page to watch a
 * download start is the opposite of what clicking Grab asks for, and the Requests drawer is still
 * one link away inside the block. The parent hears `grabbed` so the list behind reads as queued.
 */
async function handleRowGrab(release: ReleaseCandidateItem) {
  const work = props.work
  if (!work) return
  const format = activeFormat.value
  const requestId = await activeReleases.value.grab(release)
  if (requestId === null) return
  grabbedRows.value = { ...grabbedRows.value, [`${work.id}:${format}`]: { releaseKey: releaseKey(release), requestId } }
  emit('grabbed', work, format, requestId)
}

function handleRequestEbook() {
  if (props.work && !ebookOwned.value && !ebookQueued.value && ebookReleaseStarted.value) {
    emit('request', props.work, 'ebook', autoDownload.value)
  }
}

function handleRequestAudiobook() {
  if (props.work && !audiobookOwned.value && !audiobookQueued.value && audiobookReleaseStarted.value) {
    emit('request', props.work, 'audiobook', autoDownload.value)
  }
}
</script>

<template>
  <Sheet :open="props.open" @update:open="handleOpenChange">
    <SheetContent side="right" class="w-full p-0 sm:max-w-xl">
      <SheetTitle class="sr-only">{{ work?.title ? t('monitored.panel.titleFor', { title: work.title }) : t('monitored.panel.title') }}</SheetTitle>
      <SheetDescription class="sr-only">{{ t('monitored.panel.description') }}</SheetDescription>

      <div v-if="work" class="flex h-full flex-col">
        <!-- Header -->
        <div class="shrink-0 border-b border-border p-5 pt-10">
          <div class="flex items-start gap-4">
            <div
              class="relative aspect-2/3 w-24 shrink-0 overflow-hidden rounded shadow-sm"
              :style="coverUrl && !imageFailed ? undefined : fallbackStyle"
            >
              <img
                v-if="coverUrl && !imageFailed"
                :src="coverUrl"
                :alt="work.title"
                class="size-full object-cover"
                loading="eager"
                @error="handleImageError"
              />
              <div
                v-else
                class="flex size-full items-center justify-center p-2 text-center text-xs font-bold"
                :style="{ color: fallbackStyle.color }"
              >
                {{ work.title }}
              </div>
            </div>

            <div class="min-w-0 flex-1 pr-2">
              <h2 class="text-sm font-bold leading-snug text-foreground line-clamp-3">{{ work.title }}</h2>
              <p v-if="work.subtitle" class="mt-0.5 text-xs text-muted-foreground line-clamp-2">{{ work.subtitle }}</p>
              <p class="mt-2 text-xs text-muted-foreground">{{ headerMeta }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge v-if="showVerdict" variant="outline">{{ t(`monitored.panel.verdict.${work.verdict}`) }}</Badge>
              </div>
              <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span class="text-muted-foreground">{{ t('monitored.panel.availableLabel') }}</span>
                <MonitoredFormatPill format="ebook" :muted="!ebookOwned" />
                <MonitoredFormatPill format="audiobook" :muted="!audiobookOwned" />
                <template v-if="canManage">
                  <span class="ml-1.5 text-muted-foreground">{{ t('monitored.panel.monitoringLabel') }}</span>
                  <button
                    type="button"
                    :class="[pillBase, monitorEbookOn ? 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]' : pillMuted]"
                    :aria-pressed="monitorEbookOn"
                    @click="handleToggleEbookMonitor"
                  >
                    <Check v-if="monitorEbookOn" :size="11" aria-hidden="true" />
                    <X v-else :size="11" aria-hidden="true" />
                    {{ t('monitored.formats.ebook') }}
                  </button>
                  <button
                    type="button"
                    :class="[
                      pillBase,
                      monitorAudiobookOn ? 'border-[var(--pill-koreader)]/40 bg-[var(--pill-koreader)]/10 text-[var(--pill-koreader)]' : pillMuted,
                    ]"
                    :aria-pressed="monitorAudiobookOn"
                    @click="handleToggleAudiobookMonitor"
                  >
                    <Check v-if="monitorAudiobookOn" :size="11" aria-hidden="true" />
                    <X v-else :size="11" aria-hidden="true" />
                    {{ t('monitored.formats.audiobook') }}
                  </button>
                  <button
                    type="button"
                    :class="[
                      pillBase,
                      isHidden ? 'border-[var(--pill-warning)]/40 bg-[var(--pill-warning)]/10 text-[var(--pill-warning)]' : pillMuted,
                    ]"
                    :aria-pressed="isHidden"
                    @click="toggleHidden"
                  >
                    <EyeOff v-if="isHidden" :size="11" aria-hidden="true" />
                    <Eye v-else :size="11" aria-hidden="true" />
                    {{ isHidden ? t('monitored.panel.hiddenPill') : t('monitored.panel.hidePill') }}
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab strip -->
        <div class="shrink-0 border-b border-border px-3">
          <div class="no-scrollbar flex items-stretch gap-0 overflow-x-auto">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              class="h-11 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors"
              :class="activeTab === tab.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
              @click="selectTab(tab.key)"
            >
              {{ tab.label }}
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="min-h-0 flex-1 overflow-y-auto p-5">
          <!-- Details -->
          <div v-if="activeTab === 'details'" class="space-y-4">
            <div v-if="flagLabels.length" class="flex flex-wrap gap-1.5">
              <span
                v-for="flag in flagLabels"
                :key="flag"
                class="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
              >
                {{ flag }}
              </span>
            </div>

            <dl v-if="work.seriesMemberships.length || ebookReleaseLabel || audioReleaseLabel" class="space-y-3">
              <div v-if="work.seriesMemberships.length">
                <dt class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ t('monitored.panel.series') }}</dt>
                <dd class="mt-0.5 text-sm text-foreground">
                  <span v-for="(membership, index) in work.seriesMemberships" :key="`${membership.name}-${index}`">
                    <span v-if="index > 0" class="text-muted-foreground"> &middot; </span>
                    {{ membership.index != null ? `${membership.name} #${membership.index}` : membership.name }}
                  </span>
                </dd>
              </div>
              <div v-if="ebookReleaseLabel">
                <dt class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ t('monitored.panel.ebookRelease') }}</dt>
                <dd class="mt-0.5 text-sm text-foreground">{{ ebookReleaseLabel }}</dd>
              </div>
              <div v-if="audioReleaseLabel">
                <dt class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ t('monitored.panel.audioRelease') }}</dt>
                <dd class="mt-0.5 text-sm text-foreground">{{ audioReleaseLabel }}</dd>
              </div>
            </dl>

            <div class="border-t border-border pt-4">
              <div v-if="work.description" class="text-sm leading-relaxed text-foreground" v-html="safeDescription" />
              <p v-else class="text-xs italic text-muted-foreground">{{ t('monitored.panel.noDescription') }}</p>
            </div>
          </div>

          <!-- Files -->
          <div v-else-if="activeTab === 'files'">
            <template v-if="work.matchedBookId != null">
              <div v-if="detailLoading && !detail" class="space-y-2">
                <Skeleton class="h-12 w-full rounded-lg" />
                <Skeleton class="h-12 w-full rounded-lg" />
                <Skeleton class="h-12 w-full rounded-lg" />
              </div>
              <template v-else-if="detail">
                <MonitoredWorkFiles :book="detail" />
                <div v-if="secondaryBookId != null && secondaryDetail" class="mt-3">
                  <MonitoredWorkFiles :book="secondaryDetail" />
                </div>
              </template>
            </template>
            <div v-else class="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-4 py-16 text-center">
              <BookOpen class="size-5 text-muted-foreground" aria-hidden="true" />
              <p class="mt-3 text-sm text-muted-foreground">{{ t('monitored.panel.notInLibrary') }}</p>
            </div>
          </div>

          <!-- E-book / Audiobook releases -->
          <div v-else class="space-y-4">
            <MonitoredRequestProgress v-if="topProgressRequestId !== null" :request-id="topProgressRequestId" @filed="handleProgressFiled" />

            <div class="flex items-center justify-between gap-3">
              <p class="text-xs text-muted-foreground">
                {{
                  activeReleases.releases.value.length
                    ? t('monitored.panel.releaseCount', { count: activeReleases.releases.value.length })
                    : t('monitored.panel.releaseSearchIntro')
                }}
              </p>
              <Button v-if="canManage" size="sm" variant="outline" :disabled="activeReleases.loading.value" @click="handleSearchReleases">
                <Loader2 v-if="activeReleases.loading.value" class="size-3.5 animate-spin" aria-hidden="true" />
                <Search v-else :size="14" aria-hidden="true" />
                {{ t('monitored.panel.searchReleases') }}
              </Button>
            </div>

            <p v-if="activeReleases.loading.value" role="status" class="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="size-4 animate-spin" aria-hidden="true" />
              {{ t('monitored.panel.searching') }}
            </p>
            <p v-else-if="activeReleases.error.value" role="alert" class="text-sm text-destructive">{{ activeReleases.error.value }}</p>
            <ul v-else-if="activeReleases.releases.value.length" class="space-y-2">
              <ReleaseResultRow
                v-for="release in activeReleases.releases.value"
                :key="`${release.indexerId}:${release.guid}`"
                :release="release"
                :busy="activeReleases.loading.value || activeReleases.isGrabbing(release)"
                :grabbed="activeReleases.isGrabbed(release)"
                :expanded="releaseKey(release) === expandedReleaseKey"
                @grab="handleRowGrab"
              >
                <template #expansion>
                  <MonitoredRequestProgress v-if="activeRequestId !== null" :request-id="activeRequestId" @filed="handleProgressFiled" />
                </template>
              </ReleaseResultRow>
            </ul>
            <div
              v-else
              class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-4 py-14 text-center"
            >
              <Search class="size-5 text-muted-foreground" aria-hidden="true" />
              <p class="mt-3 text-sm font-medium text-foreground">
                {{ activeReleases.searched.value ? t('monitored.panel.noReleases') : t('monitored.panel.releaseSearchIdle') }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ activeReleases.searched.value ? t('monitored.panel.noReleasesHint') : t('monitored.panel.releaseSearchIdleHint') }}
              </p>
            </div>
          </div>
        </div>

        <!-- Footer: request actions -->
        <div v-if="showEbookRequest || showAudiobookRequest" class="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-4">
          <Button
            v-if="showEbookRequest"
            class="min-w-36 flex-1"
            :disabled="ebookOwned || ebookQueued || !ebookReleaseStarted"
            :title="!ebookReleaseStarted ? t('monitored.panel.notReleasedYet') : undefined"
            @click="handleRequestEbook"
          >
            <Check v-if="ebookOwned || ebookQueued" :size="16" aria-hidden="true" />
            <BookOpen v-else :size="16" aria-hidden="true" />
            {{ ebookOwned ? t('monitored.detail.ebookOwned') : ebookQueued ? t('monitored.detail.ebookQueued') : t('monitored.panel.requestEbook') }}
          </Button>
          <Button
            v-if="showAudiobookRequest"
            variant="outline"
            class="min-w-36 flex-1"
            :disabled="audiobookOwned || audiobookQueued || !audiobookReleaseStarted"
            :title="!audiobookReleaseStarted ? t('monitored.panel.notReleasedYet') : undefined"
            @click="handleRequestAudiobook"
          >
            <Check v-if="audiobookOwned || audiobookQueued" :size="16" aria-hidden="true" />
            <Headphones v-else :size="16" aria-hidden="true" />
            {{
              audiobookOwned
                ? t('monitored.detail.audiobookOwned')
                : audiobookQueued
                  ? t('monitored.detail.audiobookQueued')
                  : t('monitored.panel.requestAudiobook')
            }}
          </Button>
          <label v-if="showAutoDownload" class="inline-flex w-full items-center justify-end gap-1.5 text-xs text-muted-foreground sm:w-auto">
            <input v-model="autoDownload" type="checkbox" class="size-3.5 rounded border-border accent-primary" />
            {{ t('monitored.panel.autoDownload') }}
          </label>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>
