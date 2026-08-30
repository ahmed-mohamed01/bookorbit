<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Library, Loader2, Save, WandSparkles } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type { AudiobookshelfPathMapping, AudiobookshelfPathMappingSuggestion, UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import AudiobookshelfConnectionCard from './AudiobookshelfConnectionCard.vue'
import AudiobookshelfLinkedBooks from './AudiobookshelfLinkedBooks.vue'
import AudiobookshelfSyncProgress from './AudiobookshelfSyncProgress.vue'
import AudiobookshelfPathMappings from './AudiobookshelfPathMappings.vue'
import { useAudiobookshelfSettings } from '../composables/useAudiobookshelfSettings'
import { PATH_MAPPING_MAX_ROWS } from '../audiobookshelf.constants'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const {
  settings,
  saving,
  suggestingMappings,
  error,
  libraries,
  librariesLoading,
  librariesError,
  localFolderPaths,
  fetchSettings,
  fetchLibraries,
  saveSettings,
  suggestPathMappings,
} = useAudiobookshelfSettings()

const syncOptions = reactive({ syncStatus: true, syncPosition: true, syncSessions: true })
const excludedLibraryIds = ref<string[]>([])
const pathMappings = ref<AudiobookshelfPathMapping[]>([])
// Follows the local toggle state, not the saved one, so deselecting a library above immediately
// removes its folders from the mapping suggestions below.
const absFolderPaths = computed(() => {
  const excluded = new Set(excludedLibraryIds.value)
  const paths = libraries.value.filter((library) => !excluded.has(library.id)).flatMap((library) => library.folderPaths)
  return [...new Set(paths)].sort()
})
const includedLibraryCount = computed(() => libraries.value.filter((library) => !excludedLibraryIds.value.includes(library.id)).length)

type SyncOptions = { syncStatus: boolean; syncPosition: boolean; syncSessions: boolean }

function pickSyncOptions(source: SyncOptions): SyncOptions {
  return { syncStatus: source.syncStatus, syncPosition: source.syncPosition, syncSessions: source.syncSessions }
}

function copyMappings(mappings: AudiobookshelfPathMapping[]): AudiobookshelfPathMapping[] {
  return mappings.map((mapping) => ({ absPrefix: mapping.absPrefix, localPrefix: mapping.localPrefix }))
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameIds(left: string[], right: string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000')
}

// Snapshot of what was last written into the editor from the saved settings, per slice.
const lastApplied = {
  syncOptions: pickSyncOptions(syncOptions),
  excludedLibraryIds: [...excludedLibraryIds.value],
  pathMappings: copyMappings(pathMappings.value),
}

// A sync run refetches the settings on both success and failure, so this watch fires while the user
// may be mid-edit (suggested mappings, flipped toggles). A slice therefore only follows the server
// while it still equals what was last written into it; unsaved edits keep their value, and the
// snapshot always moves to the newest saved state so dirtiness is measured against that.
watch(
  settings,
  (value) => {
    if (!value) return
    const incoming = {
      syncOptions: pickSyncOptions(value),
      excludedLibraryIds: [...value.excludedLibraryIds],
      pathMappings: copyMappings(value.pathMappings),
    }
    if (sameValue(pickSyncOptions(syncOptions), lastApplied.syncOptions)) Object.assign(syncOptions, incoming.syncOptions)
    if (sameIds(excludedLibraryIds.value, lastApplied.excludedLibraryIds)) excludedLibraryIds.value = [...incoming.excludedLibraryIds]
    if (sameValue(copyMappings(pathMappings.value), lastApplied.pathMappings)) pathMappings.value = copyMappings(incoming.pathMappings)
    lastApplied.syncOptions = incoming.syncOptions
    lastApplied.excludedLibraryIds = incoming.excludedLibraryIds
    lastApplied.pathMappings = incoming.pathMappings
  },
  { immediate: true },
)

onMounted(async () => {
  if (!settings.value) await fetchSettings()
  if (settings.value?.serverUrl && settings.value.tokenConfigured) await fetchLibraries()
})

function handleLibraryToggle(library: { id: string }): void {
  if (excludedLibraryIds.value.includes(library.id)) {
    excludedLibraryIds.value = excludedLibraryIds.value.filter((id) => id !== library.id)
    return
  }
  if (includedLibraryCount.value <= 1) return
  excludedLibraryIds.value = [...excludedLibraryIds.value, library.id]
}

function mappingKey(mapping: AudiobookshelfPathMapping): string {
  return JSON.stringify([mapping.absPrefix.trim(), mapping.localPrefix.trim()])
}

// Suggestions land as ordinary rows the user can still edit, reorder or drop, and are only persisted
// by the usual save. Rows already present are skipped and the editor's row cap still applies.
function appendSuggestedMappings(suggestions: AudiobookshelfPathMappingSuggestion[]): AudiobookshelfPathMappingSuggestion[] {
  const present = new Set(pathMappings.value.map(mappingKey))
  const rows = [...pathMappings.value]
  const added: AudiobookshelfPathMappingSuggestion[] = []
  for (const suggestion of suggestions) {
    if (rows.length >= PATH_MAPPING_MAX_ROWS) break
    const key = mappingKey(suggestion)
    if (present.has(key)) continue
    present.add(key)
    rows.push({ absPrefix: suggestion.absPrefix, localPrefix: suggestion.localPrefix })
    added.push(suggestion)
  }
  pathMappings.value = rows
  return added
}

function suggestionSummary(added: AudiobookshelfPathMappingSuggestion[], scannedItems: number): string {
  const mappings = added.length === 1 ? '1 mapping' : `${added.length} mappings`
  const books = scannedItems === 1 ? '1 book' : `${scannedItems} books`
  const support = added.map((suggestion) => suggestion.supportCount).join(', ')
  return `${mappings} suggested from ${books} (${support} matching items)`
}

async function handleSuggestMappings(): Promise<void> {
  const result = await suggestPathMappings()
  if (!result) {
    toast.error(error.value ?? 'Failed to suggest folder mappings')
    return
  }
  const added = appendSuggestedMappings(result.suggestions)
  if (added.length === 0) {
    toast.info(`No new folder mappings found in ${result.scannedItems} books`)
    return
  }
  toast.success(suggestionSummary(added, result.scannedItems))
}

function savedPathMappings(): AudiobookshelfPathMapping[] {
  return pathMappings.value
    .map((mapping) => ({ absPrefix: mapping.absPrefix.trim(), localPrefix: mapping.localPrefix.trim() }))
    .filter((mapping) => mapping.absPrefix && mapping.localPrefix)
}

async function handleSaveSyncOptions(): Promise<void> {
  const payload: UpsertAudiobookshelfSettingsPayload = {
    ...(syncOptions.syncStatus !== settings.value?.syncStatus ? { syncStatus: syncOptions.syncStatus } : {}),
    ...(syncOptions.syncPosition !== settings.value?.syncPosition ? { syncPosition: syncOptions.syncPosition } : {}),
    ...(syncOptions.syncSessions !== settings.value?.syncSessions ? { syncSessions: syncOptions.syncSessions } : {}),
    ...(!sameIds(excludedLibraryIds.value, settings.value?.excludedLibraryIds ?? []) ? { excludedLibraryIds: excludedLibraryIds.value } : {}),
    ...(!sameValue(savedPathMappings(), settings.value?.pathMappings ?? []) ? { pathMappings: savedPathMappings() } : {}),
  }
  const saved = await saveSettings(payload)
  if (saved) toast.success('Audiobookshelf sync options saved')
  else toast.error(error.value ?? 'Failed to save Audiobookshelf sync options')
}
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader
      v-if="!props.embedded"
      title="Audiobookshelf"
      subtitle="Pull listening status, playback position, and sessions from Audiobookshelf."
    />

    <AudiobookshelfConnectionCard />
    <AudiobookshelfSyncProgress v-if="settings?.tokenConfigured" />

    <section v-if="settings?.tokenConfigured" class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
      <div>
        <p class="text-sm font-medium">Data to sync</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Choose which Audiobookshelf activity BookOrbit imports.</p>
      </div>

      <div class="space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Reading status</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Promote books to reading or read without downgrading local status.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncStatus" :disabled="!settings.enabled" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Playback position</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Resume BookOrbit audiobooks from the latest Audiobookshelf position.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncPosition" :disabled="!settings.enabled" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Listening sessions</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Import listening time into reading statistics and achievements.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncSessions" :disabled="!settings.enabled" />
        </div>
      </div>

      <div class="space-y-3 border-t border-border pt-4">
        <div>
          <p class="text-sm font-medium">Libraries to sync</p>
          <p class="mt-0.5 text-xs text-muted-foreground">Exclude collections that should not appear in BookOrbit.</p>
        </div>

        <div v-if="librariesLoading" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" />
          Loading libraries
        </div>
        <p v-else-if="librariesError" class="text-sm text-destructive">{{ librariesError }}</p>
        <div v-else class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="library in libraries"
            :key="library.id"
            class="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5"
          >
            <div class="flex min-w-0 items-center gap-2">
              <Library class="size-4 shrink-0 text-muted-foreground" />
              <span class="truncate text-sm">{{ library.name }}</span>
            </div>
            <ToggleSwitch
              :model-value="!excludedLibraryIds.includes(library.id)"
              :disabled="!settings.enabled || (!excludedLibraryIds.includes(library.id) && includedLibraryCount <= 1)"
              @update:model-value="handleLibraryToggle(library)"
            />
          </div>
        </div>
      </div>

      <AudiobookshelfPathMappings
        v-model="pathMappings"
        :disabled="saving || suggestingMappings || !settings.enabled"
        :abs-folder-paths="absFolderPaths"
        :local-folder-paths="localFolderPaths"
      >
        <template #actions>
          <button
            type="button"
            :disabled="saving || suggestingMappings || !settings.enabled"
            data-testid="suggest-path-mappings"
            class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="handleSuggestMappings"
          >
            <Loader2 v-if="suggestingMappings" class="size-3 animate-spin" />
            <WandSparkles v-else class="size-3" />
            {{ suggestingMappings ? 'Scanning' : 'Suggest mappings' }}
          </button>
        </template>
      </AudiobookshelfPathMappings>

      <div class="flex justify-end border-t border-border pt-3">
        <button
          type="button"
          :disabled="saving"
          class="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSaveSyncOptions"
        >
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          Save sync options
        </button>
      </div>
    </section>

    <AudiobookshelfLinkedBooks v-if="settings?.tokenConfigured" />
  </div>
</template>
