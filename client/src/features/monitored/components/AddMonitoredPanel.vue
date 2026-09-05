<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Loader2, Search, UserRound } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorDetail, MonitoredAuthorSearchResult, MonitoredFormat } from '@bookorbit/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { deleteMonitoredAuthor, searchMonitoredAuthors } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import MonitorAuthorModal from './MonitorAuthorModal.vue'

type FormatChoice = 'ebook' | 'audiobook' | 'both'

const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const query = ref('')
const choice = ref<FormatChoice>('both')
const results = ref<MonitoredAuthorSearchResult[]>([])
const loading = ref(false)
const searched = ref(false)
const error = ref<string | null>(null)
const selected = ref<MonitoredAuthorSearchResult | null>(null)
const stopTarget = ref<MonitoredAuthorSearchResult | null>(null)
const stopping = ref(false)
const failedImages = ref(new Set<string>())

const initialFormats = computed<MonitoredFormat[]>(() => (choice.value === 'both' ? ['ebook', 'audiobook'] : [choice.value]))

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function fallbackStyle(name: string) {
  return bookCoverStyle(name)
}

function resultImageUrl(result: MonitoredAuthorSearchResult): string {
  return failedImages.value.has(result.name) ? '' : toMonitoredCoverUrl(result.imageUrl)
}

function handleResultImageError(result: MonitoredAuthorSearchResult) {
  failedImages.value = new Set([...failedImages.value, result.name])
}

function resultMeta(result: MonitoredAuthorSearchResult): string {
  const bookCount = result.bookCount === null ? t('monitored.common.unknownBooks') : t('monitored.common.bookCount', { count: result.bookCount })
  return result.genres.length > 0 ? `${bookCount} · ${result.genres.join(', ')}` : bookCount
}

function selectEbooks() {
  choice.value = 'ebook'
}

function selectAudiobooks() {
  choice.value = 'audiobook'
}

function selectBoth() {
  choice.value = 'both'
}

async function handleSearch() {
  const normalized = query.value.trim()
  if (!normalized || loading.value) return
  loading.value = true
  error.value = null
  searched.value = true
  try {
    results.value = await searchMonitoredAuthors(normalized)
  } catch (cause) {
    error.value = monitoredErrorText(cause, t('monitored.add.searchFailed'))
    results.value = []
  } finally {
    loading.value = false
  }
}

function handleMonitor(result: MonitoredAuthorSearchResult) {
  selected.value = result
}

// Un-monitoring is destructive, so the pill asks before it deletes rather than acting on the click.
function promptStopMonitoring(result: MonitoredAuthorSearchResult) {
  if (stopping.value) return
  stopTarget.value = result
}

function cancelStopMonitoring() {
  if (!stopping.value) stopTarget.value = null
}

async function confirmStopMonitoring() {
  const result = stopTarget.value
  const monitorId = result?.alreadyMonitoredId
  if (!result || !monitorId || stopping.value) return
  stopping.value = true
  try {
    await deleteMonitoredAuthor(monitorId)
    result.alreadyMonitoredId = null
    toast.success(t('monitored.toast.stopped', { name: result.name }))
    emit('changed')
    stopTarget.value = null
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  } finally {
    stopping.value = false
  }
}

function closeModal() {
  selected.value = null
}

function handleCreated(detail: MonitoredAuthorDetail) {
  const result = results.value.find((item) => item.name === detail.author.authorName)
  if (result) result.alreadyMonitoredId = detail.author.id
  selected.value = null
  toast.success(t('monitored.toast.monitoring', { name: detail.author.authorName }))
  emit('changed')
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card/75 p-4 sm:p-5">
    <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="handleSearch">
      <label class="relative min-w-0 flex-1">
        <UserRound class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" :size="16" />
        <input
          v-model="query"
          type="search"
          :placeholder="t('monitored.add.placeholder')"
          class="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
        />
      </label>
      <Button type="submit" :disabled="!query.trim() || loading">
        <Loader2 v-if="loading" class="animate-spin" />
        <Search v-else />
        {{ t('common.search') }}
      </Button>
    </form>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-muted-foreground">{{ t('monitored.add.monitorFormats') }}</span>
      <button
        type="button"
        class="rounded-full border px-3 py-1.5 text-xs font-semibold"
        :class="choice === 'ebook' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'"
        @click="selectEbooks"
      >
        {{ t('monitored.formats.ebooks') }}
      </button>
      <button
        type="button"
        class="rounded-full border px-3 py-1.5 text-xs font-semibold"
        :class="choice === 'audiobook' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'"
        @click="selectAudiobooks"
      >
        {{ t('monitored.formats.audiobooks') }}
      </button>
      <button
        type="button"
        class="rounded-full border px-3 py-1.5 text-xs font-semibold"
        :class="choice === 'both' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'"
        @click="selectBoth"
      >
        {{ t('monitored.formats.both') }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-destructive">{{ error }}</p>

    <div v-if="searched && !loading" class="mt-6">
      <h2 class="text-xs font-bold uppercase tracking-widest text-muted-foreground">{{ t('monitored.add.results') }}</h2>
      <div v-if="results.length > 0" class="mt-2 divide-y divide-border">
        <article v-for="result in results" :key="`${result.name}-${result.localAuthorId ?? 'remote'}`" class="flex items-center gap-3 py-3">
          <div class="size-11 shrink-0 overflow-hidden rounded-full" :style="resultImageUrl(result) ? undefined : fallbackStyle(result.name)">
            <img
              v-if="resultImageUrl(result)"
              :src="resultImageUrl(result)"
              :alt="result.name"
              class="size-full object-cover"
              @error="handleResultImageError(result)"
            />
            <span v-else class="flex size-full items-center justify-center text-xs font-bold" :style="{ color: fallbackStyle(result.name).color }">{{
              initials(result.name)
            }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="truncate text-sm font-semibold text-foreground">{{ result.name }}</h3>
            <p class="truncate text-xs text-muted-foreground">{{ resultMeta(result) }}</p>
          </div>
          <Button v-if="!result.alreadyMonitoredId" size="sm" @click="handleMonitor(result)">{{ t('monitored.actions.monitor') }}</Button>
          <button
            v-else
            type="button"
            class="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--pill-success)]/40 bg-[var(--pill-success)]/10 px-3 text-xs font-bold text-[var(--pill-success)] disabled:opacity-60"
            :aria-pressed="true"
            :aria-label="t('monitored.actions.stopMonitoringNamed', { name: result.name })"
            :title="t('monitored.actions.stopMonitoringNamed', { name: result.name })"
            :disabled="stopping"
            @click="promptStopMonitoring(result)"
          >
            <Check :size="13" />
            {{ t('monitored.status.monitoring') }}
          </button>
        </article>
      </div>
      <p v-else class="py-8 text-center text-sm text-muted-foreground">{{ t('monitored.add.noResults') }}</p>
    </div>
  </section>

  <MonitorAuthorModal :open="Boolean(selected)" :result="selected" :initial-formats="initialFormats" @close="closeModal" @created="handleCreated" />

  <ConfirmDialog
    :open="Boolean(stopTarget)"
    :title="t('monitored.detail.stopDialog.title')"
    :description="t('monitored.detail.stopDialog.description')"
    :confirm-label="t('monitored.actions.stopMonitoring')"
    :busy="stopping"
    @confirm="confirmStopMonitoring"
    @cancel="cancelStopMonitoring"
  />
</template>
