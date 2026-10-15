<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Library, WebSerialKind, WebSerialPackaging } from '@bookorbit/types'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { MAX_CONCURRENT_JOBS, MIN_CONCURRENT_JOBS } from '../../lib/settingsDraft'
import { useWebSerialSettingsContext } from './settingsContext'
import { libraryAcceptsKind } from './settingsLib'

type NovelPackaging = Extract<WebSerialPackaging, 'volume' | 'series'>

const KINDS: WebSerialKind[] = ['manga', 'novel']
const PACKAGINGS: NovelPackaging[] = ['volume', 'series']
const JOB_OPTIONS = Array.from({ length: MAX_CONCURRENT_JOBS - MIN_CONCURRENT_JOBS + 1 }, (_, index) => MIN_CONCURRENT_JOBS + index)

const { t } = useI18n()
const { libraries } = useLibraries()
const { draft } = useWebSerialSettingsContext()

const bookLibraries = computed(() => libraries.value.filter((library) => library.type === 'books'))

function optionsFor(kind: WebSerialKind): Library[] {
  const accepted = bookLibraries.value.filter((library) => libraryAcceptsKind(library, kind))
  const current = bookLibraries.value.find((library) => library.id === draft[kind].targetLibraryId)
  return current && !accepted.includes(current) ? [...accepted, current] : accepted
}

function foldersFor(kind: WebSerialKind) {
  return bookLibraries.value.find((library) => library.id === draft[kind].targetLibraryId)?.folders ?? []
}

function handleLibrary(kind: WebSerialKind, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  draft[kind].targetLibraryId = value === '' ? null : Number(value)
  draft[kind].targetFolderId = foldersFor(kind)[0]?.id ?? null
}

function handleFolder(kind: WebSerialKind, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  draft[kind].targetFolderId = value === '' ? null : Number(value)
}

function handlePackaging(event: Event) {
  draft.novel.defaultPackaging = (event.target as HTMLInputElement).value as NovelPackaging
}

function handleMaxJobs(event: Event) {
  draft.maxConcurrentJobs = Number((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <section aria-labelledby="web-serials-defaults" class="space-y-2">
    <h3 id="web-serials-defaults" class="settings-group-label">{{ t('webSerials.settings.defaults.title') }}</h3>

    <div class="settings-card">
      <div v-for="kind in KINDS" :key="kind" class="settings-row">
        <div class="min-w-0 settings-prose">
          <label :for="`web-serials-${kind}-library`" class="settings-label block">{{ t(`webSerials.settings.defaults.${kind}.label`) }}</label>
          <p class="settings-hint">{{ t('webSerials.settings.defaults.libraryHint') }}</p>
        </div>
        <div class="flex shrink-0 flex-col gap-2 md:w-56">
          <select
            :id="`web-serials-${kind}-library`"
            class="select-field w-full"
            :value="draft[kind].targetLibraryId ?? ''"
            @change="handleLibrary(kind, $event)"
          >
            <option value="">{{ t('webSerials.settings.defaults.noLibrary') }}</option>
            <option v-for="library in optionsFor(kind)" :key="library.id" :value="library.id">{{ library.name }}</option>
          </select>
          <select
            v-if="foldersFor(kind).length > 1"
            class="select-field w-full"
            :aria-label="t('webSerials.settings.defaults.folder')"
            :value="draft[kind].targetFolderId ?? ''"
            @change="handleFolder(kind, $event)"
          >
            <option v-if="draft[kind].targetFolderId === null" value="">{{ t('webSerials.settings.defaults.folderDefault') }}</option>
            <option v-for="folder in foldersFor(kind)" :key="folder.id" :value="folder.id" :title="folder.path">{{ folder.path }}</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <div class="min-w-0 settings-prose">
          <p id="web-serials-packaging-label" class="settings-label">{{ t('webSerials.settings.defaults.packaging.label') }}</p>
          <p class="settings-hint">{{ t('webSerials.settings.defaults.packaging.hint') }}</p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="web-serials-packaging-label"
          class="inline-flex shrink-0 gap-0.5 self-start rounded-lg border border-border bg-muted p-0.5 md:self-auto"
        >
          <label
            v-for="packaging in PACKAGINGS"
            :key="packaging"
            class="cursor-pointer rounded-md px-3 py-1 text-[13px] font-medium transition-colors focus-within:ring-2 focus-within:ring-ring"
            :class="draft.novel.defaultPackaging === packaging ? 'bg-background text-primary shadow-xs' : 'text-foreground hover:bg-background/60'"
          >
            <input
              type="radio"
              name="web-serials-packaging"
              class="sr-only"
              :value="packaging"
              :checked="draft.novel.defaultPackaging === packaging"
              @change="handlePackaging"
            />
            {{ t(`webSerials.settings.defaults.packaging.${packaging}`) }}
          </label>
        </div>
      </div>

      <div class="settings-row">
        <div class="min-w-0 settings-prose">
          <label for="web-serials-max-jobs" class="settings-label block">{{ t('webSerials.settings.defaults.maxJobs.label') }}</label>
          <p class="settings-hint">{{ t('webSerials.settings.defaults.maxJobs.hint') }}</p>
        </div>
        <select id="web-serials-max-jobs" class="select-field w-full shrink-0 md:w-56" :value="draft.maxConcurrentJobs" @change="handleMaxJobs">
          <option v-for="count in JOB_OPTIONS" :key="count" :value="count">{{ count }}</option>
        </select>
      </div>
    </div>
  </section>
</template>
