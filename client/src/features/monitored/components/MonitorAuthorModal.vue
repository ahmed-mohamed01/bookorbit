<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen, Headphones, Loader2, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { MonitorAuthorRequest, MonitoredAuthorDetail, MonitoredAuthorSearchResult, MonitoredFormat, MonitorMode } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { bookCoverStyle } from '@/features/book/lib/book-cover'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { monitorAuthor } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'

type FormatState = { mode: MonitorMode; libraryId: number | null }

const props = defineProps<{
  open: boolean
  result: MonitoredAuthorSearchResult | null
  initialFormats: MonitoredFormat[]
}>()
const emit = defineEmits<{ close: []; created: [detail: MonitoredAuthorDetail] }>()
const { t } = useI18n()
const { libraries, fetchLibraries } = useLibraries()
const ebook = ref<FormatState>({ mode: 'auto-upcoming', libraryId: null })
const audiobook = ref<FormatState>({ mode: 'notify', libraryId: null })
const saving = ref(false)
const error = ref<string | null>(null)
const imageFailed = ref(false)

const fallbackStyle = computed(() => bookCoverStyle(props.result?.name ?? 'Monitored author'))
const imageUrl = computed(() => toMonitoredCoverUrl(props.result?.imageUrl))
const initials = computed(() =>
  (props.result?.name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join(''),
)
const meta = computed(() => {
  if (!props.result) return ''
  const books =
    props.result.bookCount === null ? t('monitored.common.unknownBooks') : t('monitored.common.bookCount', { count: props.result.bookCount })
  return props.result.genres.length > 0 ? `${books} · ${props.result.genres.join(', ')}` : books
})

const modeOptions: MonitorMode[] = ['notify', 'auto-upcoming', 'auto-all', 'off']
const ebookSummary = computed(() => formatSummary('ebook', ebook.value))
const audiobookSummary = computed(() => formatSummary('audiobook', audiobook.value))
const summary = computed(() => `${ebookSummary.value} · ${audiobookSummary.value}`)

function libraryName(id: number | null): string {
  if (id === null) return t('monitored.modal.noLibrary')
  return libraries.value.find((library) => library.id === id)?.name ?? t('monitored.modal.noLibrary')
}

function formatSummary(format: MonitoredFormat, state: FormatState): string {
  const label = t(`monitored.formats.${format}`)
  if (state.mode === 'off') return `${label}: ${t('monitored.modes.off')}`
  return `${label}: ${t(`monitored.modes.${state.mode}`)} → ${libraryName(state.libraryId)}`
}

function resetState() {
  const firstLibrary = libraries.value[0]?.id ?? null
  ebook.value = { mode: props.initialFormats.includes('ebook') ? 'auto-upcoming' : 'off', libraryId: firstLibrary }
  audiobook.value = { mode: props.initialFormats.includes('audiobook') ? 'notify' : 'off', libraryId: firstLibrary }
  error.value = null
  imageFailed.value = false
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await fetchLibraries()
    resetState()
  },
)

function handleOpenChange(open: boolean) {
  if (!open && !saving.value) emit('close')
}

function handleClose() {
  if (!saving.value) emit('close')
}

function handleImageError() {
  imageFailed.value = true
}

function handleEbookLibrary(event: Event) {
  ebook.value.libraryId = Number((event.target as HTMLSelectElement).value) || null
}

function handleAudiobookLibrary(event: Event) {
  audiobook.value.libraryId = Number((event.target as HTMLSelectElement).value) || null
}

function handleEbookMode(event: Event) {
  ebook.value.mode = (event.target as HTMLSelectElement).value as MonitorMode
}

function handleAudiobookMode(event: Event) {
  audiobook.value.mode = (event.target as HTMLSelectElement).value as MonitorMode
}

async function handleSubmit() {
  if (!props.result || saving.value) return
  saving.value = true
  error.value = null
  const payload: MonitorAuthorRequest = {
    authorName: props.result.name,
    providerIds: props.result.providerIds,
    formats: {
      ebook: { mode: ebook.value.mode, libraryId: ebook.value.libraryId, folderId: null },
      audiobook: { mode: audiobook.value.mode, libraryId: audiobook.value.libraryId, folderId: null },
    },
  }
  if (props.result.localAuthorId !== null) payload.localAuthorId = props.result.localAuthorId

  try {
    emit('created', await monitorAuthor(payload))
  } catch (cause) {
    error.value = monitoredErrorText(cause, t('monitored.modal.failed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-foreground/50 backdrop-blur-sm" />
      <DialogContent
        aria-modal="true"
        class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl focus:outline-none sm:p-6"
      >
        <div v-if="result" class="flex items-start gap-4">
          <div class="h-28 w-[84px] shrink-0 overflow-hidden rounded-lg shadow-sm" :style="imageUrl && !imageFailed ? undefined : fallbackStyle">
            <img v-if="imageUrl && !imageFailed" :src="imageUrl" :alt="result.name" class="size-full object-cover" @error="handleImageError" />
            <span v-else class="flex size-full items-center justify-center text-xl font-bold" :style="{ color: fallbackStyle.color }">{{
              initials
            }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <DialogTitle class="pr-8 text-lg font-semibold text-foreground">{{ t('monitored.modal.title', { name: result.name }) }}</DialogTitle>
            <DialogDescription class="mt-1 text-xs text-muted-foreground">{{ meta }}</DialogDescription>
            <p class="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
              {{ t('monitored.modal.description', { name: result.name }) }}
            </p>
          </div>
          <button
            type="button"
            :aria-label="t('common.close')"
            class="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
            @click="handleClose"
          >
            <X :size="18" />
          </button>
        </div>

        <div class="mt-5 space-y-3">
          <section class="rounded-xl border border-border bg-background/40 p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span class="flex size-7 items-center justify-center rounded-lg bg-[var(--pill-info)]/10 text-[var(--pill-info)]"
                  ><BookOpen :size="15"
                /></span>
                {{ t('monitored.formats.ebooks') }}
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t(`monitored.modes.${ebook.mode}`) }}</span>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <label class="space-y-1.5 text-xs font-medium text-foreground">
                {{ t('monitored.modal.targetLibrary') }}
                <select
                  :value="ebook.libraryId ?? ''"
                  class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
                  @change="handleEbookLibrary"
                >
                  <option value="">{{ t('monitored.modal.noLibrary') }}</option>
                  <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                </select>
              </label>
              <label class="space-y-1.5 text-xs font-medium text-foreground">
                {{ t('monitored.modal.monitoringMode') }}
                <select :value="ebook.mode" class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm" @change="handleEbookMode">
                  <option v-for="mode in modeOptions" :key="mode" :value="mode">{{ t(`monitored.modes.${mode}`) }}</option>
                </select>
              </label>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">{{ t(`monitored.modeHelp.${ebook.mode}`) }}</p>
          </section>

          <section class="rounded-xl border border-border bg-background/40 p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span class="flex size-7 items-center justify-center rounded-lg bg-[var(--pill-koreader)]/10 text-[var(--pill-koreader)]"
                  ><Headphones :size="15"
                /></span>
                {{ t('monitored.formats.audiobooks') }}
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t(`monitored.modes.${audiobook.mode}`) }}</span>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <label class="space-y-1.5 text-xs font-medium text-foreground">
                {{ t('monitored.modal.targetLibrary') }}
                <select
                  :value="audiobook.libraryId ?? ''"
                  class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
                  @change="handleAudiobookLibrary"
                >
                  <option value="">{{ t('monitored.modal.noLibrary') }}</option>
                  <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                </select>
              </label>
              <label class="space-y-1.5 text-xs font-medium text-foreground">
                {{ t('monitored.modal.monitoringMode') }}
                <select
                  :value="audiobook.mode"
                  class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
                  @change="handleAudiobookMode"
                >
                  <option v-for="mode in modeOptions" :key="mode" :value="mode">{{ t(`monitored.modes.${mode}`) }}</option>
                </select>
              </label>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">{{ t(`monitored.modeHelp.${audiobook.mode}`) }}</p>
          </section>
        </div>

        <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
        <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <p class="min-w-0 flex-1 text-xs text-muted-foreground">{{ summary }}</p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" :disabled="saving" @click="handleClose">{{ t('common.cancel') }}</Button>
            <Button :disabled="saving" @click="handleSubmit">
              <Loader2 v-if="saving" class="animate-spin" />
              {{ t('monitored.modal.start') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
