<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen, Headphones, Loader2, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { MonitorAuthorRequest, MonitoredAuthorItem, MonitoredAuthorSearchResult, MonitoredFormat, MonitorMode } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { useRequestDestinationDefault } from '@/features/book-requests/composables/useRequestDestinationDefault'
import AuthorPlaceholder from '@/features/author/components/AuthorPlaceholder.vue'
import { toMonitoredCoverUrl } from '@/features/monitored/lib/cover-url'
import { monitorAuthor, refreshMonitoredAuthor, updateMonitoredAuthor } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { monitorDestinationDefault } from '../lib/monitor-destination'
import { monitoredPortraitUrl } from '../lib/portrait-url'

type FormatState = { mode: MonitorMode; libraryId: number | null; folderId: number | null }

const props = defineProps<{
  open: boolean
  result: MonitoredAuthorSearchResult | null
  initialFormats: MonitoredFormat[]
  author?: MonitoredAuthorItem | null
}>()
const emit = defineEmits<{ close: []; created: [item: MonitoredAuthorItem]; updated: [item: MonitoredAuthorItem] }>()
const { t } = useI18n()
const { libraries, loaded: librariesLoaded, error: librariesError, fetchLibraries, refreshLibraries } = useLibraries()
const { load: loadRequestDestinations, defaultFor } = useRequestDestinationDefault()
const ebook = ref<FormatState>({ mode: 'notify', libraryId: null, folderId: null })
const audiobook = ref<FormatState>({ mode: 'notify', libraryId: null, folderId: null })
const staleDestination = ref<Record<MonitoredFormat, boolean>>({ ebook: false, audiobook: false })
const librariesUnavailable = ref(false)
let openGeneration = 0
const saving = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const imageFailed = ref(false)

const editing = computed(() => Boolean(props.author))
const displayName = computed(() => props.author?.authorName ?? props.result?.name ?? '')
const imageUrl = computed(() => {
  if (props.author) return props.author.portraitAuthorId === null ? null : monitoredPortraitUrl(props.author.id)
  return toMonitoredCoverUrl(props.result?.imageUrl)
})
const meta = computed(() => {
  if (props.author) return t('monitored.common.bookCount', { count: props.author.counts.total })
  if (!props.result) return ''
  const books =
    props.result.bookCount === null ? t('monitored.common.unknownBooks') : t('monitored.common.bookCount', { count: props.result.bookCount })
  return props.result.genres.length > 0 ? `${books} · ${props.result.genres.join(', ')}` : books
})

const modeOptions: MonitorMode[] = ['notify', 'auto-upcoming', 'auto-all', 'off']
const AUTO_MODES: MonitorMode[] = ['auto-upcoming', 'auto-all']

function needsLibrary(state: FormatState): boolean {
  return AUTO_MODES.includes(state.mode) && state.libraryId === null
}

// A watch is saved against a library that can be deleted or lose access afterwards, and the server
// then refuses every save of that author, so Save stays off until each auto format has a library.
const missingLibrary = computed(() => editing.value && (needsLibrary(ebook.value) || needsLibrary(audiobook.value)))
const saveBlocked = computed(() => missingLibrary.value || librariesUnavailable.value)
const controlsLocked = computed(() => editing.value && loading.value)
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

function reconcileDestination(state: FormatState): { state: FormatState; stale: boolean } {
  if (state.libraryId === null) return { state, stale: false }
  const library = libraries.value.find((candidate) => candidate.id === state.libraryId)
  if (!library) return { state: { ...state, libraryId: null, folderId: null }, stale: true }
  if (state.folderId !== null && !library.folders.some((folder) => folder.id === state.folderId)) {
    return { state: { ...state, folderId: null }, stale: true }
  }
  return { state, stale: false }
}

function reconcileAuthorDestinations() {
  const reconciledEbook = reconcileDestination(ebook.value)
  const reconciledAudiobook = reconcileDestination(audiobook.value)
  ebook.value = reconciledEbook.state
  audiobook.value = reconciledAudiobook.state
  staleDestination.value = { ebook: reconciledEbook.stale, audiobook: reconciledAudiobook.stale }
}

function resetState() {
  staleDestination.value = { ebook: false, audiobook: false }
  if (props.author) {
    ebook.value = { ...props.author.formats.ebook }
    audiobook.value = { ...props.author.formats.audiobook }
    error.value = null
    imageFailed.value = false
    return
  }
  ebook.value = {
    mode: props.initialFormats.includes('ebook') ? 'notify' : 'off',
    ...monitorDestinationDefault(libraries.value, defaultFor('ebook')),
  }
  audiobook.value = {
    mode: props.initialFormats.includes('audiobook') ? 'notify' : 'off',
    ...monitorDestinationDefault(libraries.value, defaultFor('audiobook')),
  }
  error.value = null
  imageFailed.value = false
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    // The author's own modes need no network, so show them at once: waiting on the libraries fetch
    // would leave the previous author's values on screen with Save available.
    if (props.author) resetState()
    const generation = ++openGeneration
    librariesUnavailable.value = false
    // Both defaults arrive over the network, and until they do the form holds no destination at
    // all: submitting inside that window would monitor the author with nowhere to file its grabs.
    loading.value = true
    try {
      // The cached list can predate a library being created, deleted or shared, and reconciling
      // against it would clear a destination that is still valid.
      await Promise.all([props.author ? refreshLibraries() : fetchLibraries(), props.author ? Promise.resolve() : loadRequestDestinations()])
      if (generation !== openGeneration) return
      if (props.author) {
        // A failed load leaves the list empty or stale, which would read as every library deleted.
        librariesUnavailable.value = Boolean(librariesError.value) || !librariesLoaded.value
        if (!librariesUnavailable.value) reconcileAuthorDestinations()
      } else resetState()
    } finally {
      if (generation === openGeneration) loading.value = false
    }
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

function selectedLibraryId(event: Event): number | null {
  return Number((event.target as HTMLSelectElement).value) || null
}

// A folder belongs to the library it was chosen under, so picking another library drops it rather
// than filing this author's grabs into a folder of the library left behind.
function handleEbookLibrary(event: Event) {
  ebook.value = { ...ebook.value, libraryId: selectedLibraryId(event), folderId: null }
  staleDestination.value.ebook = false
}

function handleAudiobookLibrary(event: Event) {
  audiobook.value = { ...audiobook.value, libraryId: selectedLibraryId(event), folderId: null }
  staleDestination.value.audiobook = false
}

function handleEbookMode(event: Event) {
  ebook.value.mode = (event.target as HTMLSelectElement).value as MonitorMode
}

function handleAudiobookMode(event: Event) {
  audiobook.value.mode = (event.target as HTMLSelectElement).value as MonitorMode
}

// The save has already landed by the time the refresh runs, and the refresh can be refused (cooldown,
// already fetching), so its failure must not read as a failed save.
async function handleUpdate(author: MonitoredAuthorItem) {
  saving.value = true
  error.value = null
  try {
    const formats = {
      ebook: { mode: ebook.value.mode, libraryId: ebook.value.libraryId, folderId: ebook.value.folderId },
      audiobook: { mode: audiobook.value.mode, libraryId: audiobook.value.libraryId, folderId: audiobook.value.folderId },
    }
    let item = await updateMonitoredAuthor(author.id, { formats })
    try {
      item = await refreshMonitoredAuthor(author.id)
    } catch {
      // Keep the saved item; the next scheduled sync applies the new mode.
    }
    emit('updated', item)
  } catch (cause) {
    error.value = monitoredErrorText(cause, t('monitored.modal.updateFailed'))
  } finally {
    saving.value = false
  }
}

async function handleSubmit() {
  if (props.author) {
    if (!saving.value) await handleUpdate(props.author)
    return
  }
  if (!props.result || saving.value) return
  saving.value = true
  error.value = null
  const payload: MonitorAuthorRequest = {
    authorName: props.result.name,
    providerIds: props.result.providerIds,
    formats: {
      ebook: { mode: ebook.value.mode, libraryId: ebook.value.libraryId, folderId: ebook.value.folderId },
      audiobook: { mode: audiobook.value.mode, libraryId: audiobook.value.libraryId, folderId: audiobook.value.folderId },
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
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim backdrop-blur-sm" />
      <DialogContent
        aria-modal="true"
        class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl focus:outline-none sm:p-6"
      >
        <div v-if="displayName" class="flex items-start gap-4">
          <div class="relative h-28 w-[84px] shrink-0 overflow-hidden rounded-lg shadow-sm">
            <img v-if="imageUrl && !imageFailed" :src="imageUrl" :alt="displayName" class="size-full object-cover" @error="handleImageError" />
            <AuthorPlaceholder v-else :name="displayName" />
          </div>
          <div class="min-w-0 flex-1">
            <DialogTitle class="pr-8 text-lg font-semibold text-foreground">{{
              editing ? t('monitored.modal.editTitle', { name: displayName }) : t('monitored.modal.title', { name: displayName })
            }}</DialogTitle>
            <DialogDescription class="mt-1 text-xs text-muted-foreground">{{ meta }}</DialogDescription>
            <p class="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
              {{ editing ? t('monitored.modal.editDescription', { name: displayName }) : t('monitored.modal.description', { name: displayName }) }}
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
                <span class="flex size-7 items-center justify-center rounded-lg bg-[var(--pill-media-ebook)]/10 text-[var(--pill-media-ebook)]"
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
                  :disabled="controlsLocked"
                  @change="handleEbookLibrary"
                >
                  <option value="">{{ t('monitored.modal.noLibrary') }}</option>
                  <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                </select>
              </label>
              <label class="space-y-1.5 text-xs font-medium text-foreground">
                {{ t('monitored.modal.monitoringMode') }}
                <select
                  :value="ebook.mode"
                  class="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
                  :disabled="controlsLocked"
                  @change="handleEbookMode"
                >
                  <option v-for="mode in modeOptions" :key="mode" :value="mode">{{ t(`monitored.modes.${mode}`) }}</option>
                </select>
              </label>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">{{ t(`monitored.modeHelp.${ebook.mode}`) }}</p>
            <p v-if="staleDestination.ebook" class="mt-1 text-[11px] text-destructive">{{ t('monitored.modal.destinationGone') }}</p>
            <p v-else-if="editing && needsLibrary(ebook)" class="mt-1 text-[11px] text-destructive">{{ t('monitored.modal.libraryRequired') }}</p>
          </section>

          <section class="rounded-xl border border-border bg-background/40 p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span
                  class="flex size-7 items-center justify-center rounded-lg bg-[var(--pill-media-audiobook)]/10 text-[var(--pill-media-audiobook)]"
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
                  :disabled="controlsLocked"
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
                  :disabled="controlsLocked"
                  @change="handleAudiobookMode"
                >
                  <option v-for="mode in modeOptions" :key="mode" :value="mode">{{ t(`monitored.modes.${mode}`) }}</option>
                </select>
              </label>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">{{ t(`monitored.modeHelp.${audiobook.mode}`) }}</p>
            <p v-if="staleDestination.audiobook" class="mt-1 text-[11px] text-destructive">{{ t('monitored.modal.destinationGone') }}</p>
            <p v-else-if="editing && needsLibrary(audiobook)" class="mt-1 text-[11px] text-destructive">{{ t('monitored.modal.libraryRequired') }}</p>
          </section>
        </div>

        <p v-if="librariesUnavailable" class="mt-3 text-sm text-destructive">{{ t('monitored.modal.librariesUnavailable') }}</p>
        <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
        <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <p class="min-w-0 flex-1 text-xs text-muted-foreground">{{ summary }}</p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" :disabled="saving" @click="handleClose">{{ t('common.cancel') }}</Button>
            <Button :disabled="saving || loading || saveBlocked" @click="handleSubmit">
              <Loader2 v-if="saving || loading" class="animate-spin" />
              {{ editing ? t('monitored.modal.save') : t('monitored.modal.start') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
