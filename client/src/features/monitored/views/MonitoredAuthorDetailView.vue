<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  BookCopy,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Headphones,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Permission } from '@bookorbit/types'
import type { MonitoredFormat, MonitoredGrouping, MonitoredSort, MonitoredWork } from '@bookorbit/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useScrollRestoreOnActivate } from '@/features/book/composables/useScrollRestoreOnActivate'
import { useBookRequestProgress } from '@/features/book-requests/composables/useBookRequestProgress'
import { deleteMonitoredAuthor, refreshMonitoredAuthor } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { monitoredPortraitUrl } from '../lib/portrait-url'
import MonitoredWorkCard from '../components/MonitoredWorkCard.vue'
import MonitoredBookPanel from '../components/MonitoredBookPanel.vue'
import MonitoredGroupMenu from '../components/MonitoredGroupMenu.vue'
import MonitoredSortMenu from '../components/MonitoredSortMenu.vue'
import MonitoredVirtualGrid from '../components/MonitoredVirtualGrid.vue'
import { useMonitoredAuthorDetail } from '../composables/useMonitoredAuthorDetail'
import { useRefreshFeedback } from '../composables/useRefreshFeedback'
import { seriesMembershipForGroup } from '../lib/grouping'

const { t, d } = useI18n()
const route = useRoute()
const router = useRouter()
const { hasPermission } = usePermissions()
const { cardInfoMode } = useDisplaySettings()
const {
  detail,
  loading,
  error,
  updating,
  sort,
  order,
  grouping,
  groups,
  visibleWorks,
  showReview,
  reviewCount,
  monitoredFormats,
  load,
  setSort,
  setOrder,
  setGrouping,
  toggleReview,
  setPaused,
  queueWork,
  markQueued,
  isQueued,
  updateWork,
  loadMonitoredBooks,
  isBookMonitored,
  isMonitoringBook,
  monitorBook,
} = useMonitoredAuthorDetail()
const { state: refreshState, run: runRefresh } = useRefreshFeedback()
const { onRequestsChanged } = useBookRequestProgress()
const mainRef = ref<HTMLElement | null>(null)
useScrollRestoreOnActivate(mainRef)
const confirmStopOpen = ref(false)
const imageFailed = ref(false)
// The header's prose and links cost a full viewport on a phone, so they stay behind a toggle there.
const detailsExpanded = ref(false)
const panelWork = ref<MonitoredWork | null>(null)
const panelOpen = ref(false)
// Deferred server reconciliation runs when this kept-alive view returns.
let reloadOnActivate = false
let viewActive = true
let initialLoadComplete = false
let requestRefreshPending = false
let requestRefreshTimer: ReturnType<typeof setTimeout> | null = null
const REQUEST_CHANGE_DEBOUNCE_MS = 1500
const DETAIL_WORK_CARD_SIZE = 122
const DETAIL_WORK_GRID_GAP = 12
const detailWorkExtraHeight = computed(() => (cardInfoMode.value === 'below-cover' ? 40 : 0))

const canManage = computed(() => hasPermission(Permission.BookRequestAccess))
const canEdit = computed(() => canManage.value && (detail.value?.author.isOwner ?? false))
const author = computed(() => detail.value?.author ?? null)
const portraitUrl = computed(() => (author.value?.portraitAuthorId == null ? null : monitoredPortraitUrl(author.value.id)))
const fallbackStyle = computed(() => bookCoverStyle(author.value?.authorName ?? 'Monitored author'))
const initials = computed(() =>
  (author.value?.authorName ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join(''),
)
const nextRelease = computed(() => {
  if (!author.value?.nextReleaseAt) return t('monitored.common.tba')
  return d(new Date(author.value.nextReleaseAt), { year: 'numeric', month: 'short', day: 'numeric' })
})
const bio = computed(() => author.value?.description?.trim() ?? '')
const genres = computed(() => author.value?.genres ?? [])
const hasDetails = computed(() => Boolean(bio.value || author.value?.website || genres.value.length))
const sortOptions = computed<{ value: MonitoredSort; label: string }[]>(() => [
  { value: 'releaseDate', label: t('monitored.detail.controls.releaseDate') },
  { value: 'title', label: t('monitored.detail.controls.title') },
])
const groupOptions = computed<{ value: MonitoredGrouping; label: string }[]>(() => [
  { value: 'none', label: t('monitored.detail.controls.none') },
  { value: 'series', label: t('monitored.detail.controls.series') },
  { value: 'year', label: t('monitored.detail.controls.year') },
  { value: 'status', label: t('monitored.detail.controls.status') },
])
const reviewLabel = computed(() =>
  showReview.value ? t('monitored.detail.hideReview') : t('monitored.detail.showReview', { count: reviewCount.value }),
)
const bioExpanded = ref(false)
watch(bio, () => {
  bioExpanded.value = false
})

function toggleBio() {
  bioExpanded.value = !bioExpanded.value
}

function toggleDetails() {
  detailsExpanded.value = !detailsExpanded.value
}

function goBack() {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  if (from.startsWith('/monitored')) {
    void router.push(from)
    return
  }
  void router.push({ name: 'monitored' })
}

function handleImageError() {
  imageFailed.value = true
}

async function handleToggleMonitoring() {
  if (!author.value || !canEdit.value) return
  const paused = !author.value.paused
  try {
    await setPaused(paused)
    toast.success(t(paused ? 'monitored.toast.paused' : 'monitored.toast.resumed', { name: author.value.authorName }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleRefresh() {
  if (!author.value) return
  const { id, authorName } = author.value
  try {
    await runRefresh(async () => {
      detail.value = await refreshMonitoredAuthor(id)
    })
    toast.success(t('monitored.toast.authorRefreshed', { name: authorName }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

function promptStopAuthor() {
  confirmStopOpen.value = true
}

function cancelStopAuthor() {
  confirmStopOpen.value = false
}

async function confirmStopAuthor() {
  if (!author.value) return
  try {
    await deleteMonitoredAuthor(author.value.id)
    toast.success(t('monitored.toast.stopped', { name: author.value.authorName }))
    await router.push({ name: 'monitored' })
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  } finally {
    confirmStopOpen.value = false
  }
}

function handleQuickView(work: MonitoredWork) {
  if (work.matchedBookId !== null) void router.push({ name: 'book-detail', params: { bookId: work.matchedBookId } })
}

function handlePreview(work: MonitoredWork) {
  panelWork.value = work
  panelOpen.value = true
}

function handlePanelOpen(value: boolean) {
  panelOpen.value = value
}

async function handlePanelRequest(work: MonitoredWork, format: MonitoredFormat, autoDownload: boolean) {
  await queue(work, format, autoDownload)
}

/**
 * The panel keeps the grab and reports its progress in place, so this only flips the card behind
 * it to queued now and refetches the page on the next visit, by which point the download may
 * already have been filed.
 */
function handlePanelGrabbed(work: MonitoredWork, format: MonitoredFormat, requestId: number) {
  markQueued(work.id, format, requestId)
  reloadOnActivate = true
}

/**
 * The download the panel was watching has landed in the library. What the work owns is the server's
 * to decide, so the page reloads and the open panel re-points at the work that came back with it.
 */
async function handlePanelFiled(work: MonitoredWork) {
  await load()
  panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
}

async function handleToggleMonitor(work: MonitoredWork, format: MonitoredFormat, value: boolean) {
  try {
    await updateWork(work.id, format === 'ebook' ? { monitorEbook: value } : { monitorAudiobook: value })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleToggleHidden(work: MonitoredWork, value: boolean) {
  try {
    await updateWork(work.id, { hidden: value })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function queue(work: MonitoredWork, format: MonitoredFormat, autoDownload?: boolean) {
  if (!canEdit.value || isQueued(work.id, format)) return
  try {
    await queueWork(work.id, format, autoDownload)
    if (panelWork.value?.id === work.id) panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
    toast.success(t('monitored.toast.sendingToRequests', { title: work.title, format: t(`monitored.formats.${format}`) }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.queueFailed')))
  }
}

function handleDownloadEbook(work: MonitoredWork) {
  void queue(work, 'ebook')
}

function handleDownloadAudiobook(work: MonitoredWork) {
  void queue(work, 'audiobook')
}

async function handleStopWork(work: MonitoredWork) {
  try {
    await updateWork(work.id, { hidden: true })
    toast.success(t('monitored.toast.workStopped', { title: work.title }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleMonitorBook(work: MonitoredWork) {
  if (!canEdit.value) return
  try {
    await monitorBook(work)
    toast.success(t('monitored.toast.bookMonitoring', { title: work.title }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.bookMonitorFailed')))
  }
}

function groupLabel(key: string, fallback: string): string {
  if (key === 'all') return t('monitored.detail.groups.all')
  if (key === 'standalone') return t('monitored.detail.groups.standalone')
  if (key === 'unknown') return t('monitored.detail.groups.unknownYear')
  if (key === 'upcoming') return t('monitored.detail.groups.upcoming')
  if (key === 'recent') return t('monitored.detail.groups.recent')
  if (key === 'backlist') return t('monitored.detail.groups.backlist')
  return fallback
}

async function loadPage(): Promise<void> {
  await Promise.all([load(), loadMonitoredBooks()])
}

function flushRequestRefresh(): void {
  if (!requestRefreshPending || !initialLoadComplete || loading.value) return
  requestRefreshPending = false
  if (!viewActive) {
    reloadOnActivate = true
    return
  }
  void load()
}

function handleRequestsChanged(): void {
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
  requestRefreshTimer = setTimeout(() => {
    requestRefreshTimer = null
    if (!viewActive) {
      reloadOnActivate = true
      return
    }
    requestRefreshPending = true
    flushRequestRefresh()
  }, REQUEST_CHANGE_DEBOUNCE_MS)
}

onRequestsChanged(handleRequestsChanged)

watch(loading, (isLoading) => {
  if (!isLoading) flushRequestRefresh()
})

onMounted(async () => {
  await loadPage()
  initialLoadComplete = true
  flushRequestRefresh()
})

onActivated(() => {
  viewActive = true
  if (!reloadOnActivate) return
  reloadOnActivate = false
  void loadPage()
})

onDeactivated(() => {
  viewActive = false
})

onUnmounted(() => {
  viewActive = false
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
})

defineOptions({ name: 'MonitoredAuthorDetailView' })
</script>

<template>
  <main ref="mainRef" class="h-full overflow-y-auto pr-0 sm:pr-2">
    <div class="mx-auto w-full max-w-7xl pb-8">
      <Button variant="outline" size="sm" class="mt-3" @click="goBack">
        <ChevronLeft :size="14" />
        {{ t('monitored.detail.back') }}
      </Button>

      <div v-if="loading && !detail" class="flex min-h-80 items-center justify-center text-muted-foreground">
        <Loader2 class="animate-spin" :size="24" />
      </div>
      <div v-else-if="error && !detail" class="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {{ error }}
      </div>

      <template v-else-if="author">
        <section class="mt-4 overflow-hidden rounded-xl border border-border bg-card/80">
          <div class="bg-linear-to-b from-primary/8 via-background/0 to-transparent p-3 sm:p-5">
            <div class="flex gap-3 sm:gap-4">
              <div
                class="h-24 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted shadow-sm sm:h-44 sm:w-32"
                :style="portraitUrl && !imageFailed ? undefined : fallbackStyle"
              >
                <img
                  v-if="portraitUrl && !imageFailed"
                  :src="portraitUrl"
                  :alt="author.authorName"
                  class="size-full object-cover"
                  @error="handleImageError"
                />
                <span
                  v-else
                  class="flex size-full items-center justify-center text-xl font-semibold sm:text-3xl"
                  :style="{ color: fallbackStyle.color }"
                  >{{ initials }}</span
                >
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <h1 class="min-w-0 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{{ author.authorName }}</h1>
                  <div class="flex items-center gap-2">
                    <button
                      v-if="canEdit"
                      type="button"
                      class="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-bold"
                      :class="
                        author.paused
                          ? 'border-border bg-muted text-muted-foreground'
                          : 'border-[var(--pill-success)]/40 bg-[var(--pill-success)]/10 text-[var(--pill-success)]'
                      "
                      :disabled="updating"
                      @click="handleToggleMonitoring"
                    >
                      <span class="size-2 rounded-full bg-current" />
                      {{ author.paused ? t('monitored.status.paused') : t('monitored.status.monitoring') }}
                    </button>
                    <DropdownMenu v-if="canEdit">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="sm">
                          <Loader2 v-if="refreshState === 'loading'" class="animate-spin" />
                          <Check v-else-if="refreshState === 'done'" class="text-[var(--pill-success)]" />
                          <MoreHorizontal v-else />
                          {{ t('monitored.actions.actions') }}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem :disabled="refreshState === 'loading'" @click="handleRefresh"
                          ><RefreshCw :class="refreshState === 'loading' ? 'animate-spin' : ''" />{{
                            t('monitored.actions.refresh')
                          }}</DropdownMenuItem
                        >
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" @click="promptStopAuthor"
                          ><Trash2 />{{ t('monitored.actions.stopMonitoring') }}</DropdownMenuItem
                        >
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:hidden">
                  <span class="flex items-center gap-1 font-semibold text-foreground">
                    <BookCopy :size="14" role="img" :aria-label="t('monitored.detail.stats.books')" />{{ author.counts.total }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-info)]">
                    <BookOpen :size="14" role="img" :aria-label="t('monitored.formats.ebooks')" />{{ author.counts.ebookOwned }}/{{
                      author.counts.total
                    }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-koreader)]">
                    <Headphones :size="14" role="img" :aria-label="t('monitored.formats.audiobooks')" />{{ author.counts.audioOwned }}/{{
                      author.counts.total
                    }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-warning)]">
                    <CalendarDays :size="14" role="img" :aria-label="t('monitored.detail.stats.nextRelease')" />{{ nextRelease }}
                  </span>
                </div>

                <button
                  v-if="hasDetails"
                  type="button"
                  class="mt-2 text-xs font-medium text-primary transition-colors sm:hidden"
                  @click="toggleDetails"
                >
                  {{ detailsExpanded ? t('monitored.detail.hideDetails') : t('monitored.detail.showDetails') }}
                </button>

                <div :class="detailsExpanded ? '' : 'hidden sm:block'">
                  <div class="mt-3">
                    <p v-if="bio" :class="bioExpanded ? 'text-sm leading-6 text-foreground' : 'text-sm leading-6 text-foreground line-clamp-4'">
                      {{ bio }}
                    </p>
                    <button
                      v-if="bio"
                      type="button"
                      class="mt-1 text-xs font-medium text-primary transition-colors hover:text-primary"
                      @click="toggleBio"
                    >
                      {{ bioExpanded ? t('author.header.showLess') : t('author.header.showMore') }}
                    </button>
                    <p v-else class="hidden text-sm text-muted-foreground sm:block">{{ t('monitored.detail.headerDescription') }}</p>
                  </div>

                  <dl v-if="author.website || genres.length" class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <div v-if="author.website" class="flex min-w-0 gap-1.5">
                      <dt class="text-muted-foreground">{{ t('author.header.website') }}</dt>
                      <dd class="min-w-0 truncate">
                        <a :href="author.website" target="_blank" rel="noopener noreferrer" class="text-foreground underline underline-offset-2">{{
                          author.website
                        }}</a>
                      </dd>
                    </div>
                    <div v-if="genres.length" class="flex min-w-0 gap-1.5">
                      <dt class="text-muted-foreground">{{ t('author.header.genres') }}</dt>
                      <dd class="min-w-0 text-foreground">{{ genres.join(', ') }}</dd>
                    </div>
                  </dl>
                </div>

                <div class="mt-5 hidden grid-cols-2 gap-2 sm:grid lg:grid-cols-4">
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-foreground"><BookCopy :size="15" />{{ author.counts.total }}</p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.detail.stats.books') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-[var(--pill-info)]">
                      <BookOpen :size="15" />{{ author.counts.ebookOwned }}/{{ author.counts.total }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.formats.ebooks') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-[var(--pill-koreader)]">
                      <Headphones :size="15" />{{ author.counts.audioOwned }}/{{ author.counts.total }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.formats.audiobooks') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-sm font-semibold text-[var(--pill-warning)]">
                      <CalendarDays :size="15" />{{ nextRelease }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.detail.stats.nextRelease') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="mt-4 rounded-xl border border-border bg-card/75 p-3 sm:p-4">
          <div class="flex items-center justify-between gap-3">
            <h2 class="min-w-0 truncate text-sm font-semibold text-foreground">
              <span class="hidden sm:inline">{{
                t('monitored.detail.booksHeading', { shown: visibleWorks.length, total: author.counts.total })
              }}</span>
              <span class="sm:hidden">{{ t('monitored.detail.booksHeadingShort', { shown: visibleWorks.length, total: author.counts.total }) }}</span>
            </h2>
            <div class="flex shrink-0 items-center gap-2">
              <MonitoredSortMenu
                :options="sortOptions"
                :model-value="sort"
                :order="order"
                default-value="releaseDate"
                default-order="desc"
                @update:model-value="setSort"
                @update:order="setOrder"
              />
              <MonitoredGroupMenu :options="groupOptions" :model-value="grouping" default-value="series" @update:model-value="setGrouping" />
              <DropdownMenu v-if="reviewCount > 0 || showReview">
                <DropdownMenuTrigger as-child>
                  <Button variant="outline" size="icon-sm" class="rounded-lg" :aria-label="t('monitored.actions.actions')">
                    <MoreHorizontal :size="14" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="toggleReview">
                    <EyeOff v-if="showReview" />
                    <Eye v-else />
                    {{ reviewLabel }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div class="mt-5 space-y-6">
            <section v-for="group in groups" :key="group.key">
              <div class="mb-3 flex items-center gap-2">
                <h3 class="text-xs font-semibold text-foreground">{{ groupLabel(group.key, group.label) }}</h3>
                <span class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{{ group.works.length }}</span>
                <div class="h-px flex-1 bg-border" />
              </div>
              <MonitoredVirtualGrid
                :virtualized="grouping === 'none'"
                :items="group.works"
                :card-size="DETAIL_WORK_CARD_SIZE"
                :grid-gap="DETAIL_WORK_GRID_GAP"
                :extra-height="detailWorkExtraHeight"
              >
                <template #default="{ item: work }">
                  <MonitoredWorkCard
                    :work="work"
                    :queued="isQueued(work.id)"
                    :ebook-queued="isQueued(work.id, 'ebook')"
                    :audiobook-queued="isQueued(work.id, 'audiobook')"
                    :series-membership="grouping === 'series' ? seriesMembershipForGroup(work, group.key) : undefined"
                    :monitored-formats="monitoredFormats"
                    :can-manage="canEdit"
                    :allow-book-monitoring="true"
                    :individually-monitored="isBookMonitored(work.id)"
                    :monitoring-book="isMonitoringBook(work.id)"
                    @preview="handlePreview"
                    @quick-view="handleQuickView"
                    @download-ebook="handleDownloadEbook"
                    @download-audiobook="handleDownloadAudiobook"
                    @stop="handleStopWork"
                    @monitor="handleMonitorBook"
                  />
                </template>
              </MonitoredVirtualGrid>
            </section>
          </div>
        </section>
      </template>
    </div>

    <ConfirmDialog
      :open="confirmStopOpen"
      :title="t('monitored.detail.stopDialog.title')"
      :description="t('monitored.detail.stopDialog.description')"
      :confirm-label="t('monitored.actions.stopMonitoring')"
      @confirm="confirmStopAuthor"
      @cancel="cancelStopAuthor"
    />

    <MonitoredBookPanel
      :work="panelWork"
      :author-name="author?.authorName ?? ''"
      :monitored-formats="monitoredFormats"
      :can-manage="canEdit"
      :open="panelOpen"
      @update:open="handlePanelOpen"
      @request="handlePanelRequest"
      @grabbed="handlePanelGrabbed"
      @filed="handlePanelFiled"
      @toggle-monitor="handleToggleMonitor"
      @toggle-hidden="handleToggleHidden"
    />
  </main>
</template>
