<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { cleanSourceName, effectiveSourceIds, groupSourcesByLanguage, languageName, setSourcesSelected, toggleSource } from './settingsLib'
import { useWebSerialSettingsContext } from './settingsContext'
import WebSerialSourcesDisclaimer from '../WebSerialSourcesDisclaimer.vue'

const GROUP_COLORS = ['--format-ebook', '--format-kindle', '--format-document', '--format-comic', '--format-audio']

const { t, locale } = useI18n()
const state = useWebSerialSettingsContext()
const { draft, mangaSources, mangaSourcesLoading, mangaSourcesError } = state

const groups = computed(() => groupSourcesByLanguage(mangaSources.value))
const selectedIds = computed(() => new Set(effectiveSourceIds(mangaSources.value, draft.manga.sourceIds, draft.manga.languages)))
const searchedCount = computed(() => mangaSources.value.filter((source) => selectedIds.value.has(source.id)).length)

function groupColor(index: number): string {
  return `var(${GROUP_COLORS[index % GROUP_COLORS.length]})`
}

function isSelected(id: string): boolean {
  return selectedIds.value.has(id)
}

function groupSelectedCount(ids: readonly string[]): number {
  return ids.filter((id) => selectedIds.value.has(id)).length
}

function currentSelection(): string[] {
  return effectiveSourceIds(mangaSources.value, draft.manga.sourceIds, draft.manga.languages)
}

function handleToggle(id: string) {
  draft.manga.sourceIds = toggleSource(currentSelection(), id)
}

function handleGroupAll(ids: string[]) {
  draft.manga.sourceIds = setSourcesSelected(currentSelection(), ids, true)
}

function handleGroupNone(ids: string[]) {
  draft.manga.sourceIds = setSourcesSelected(currentSelection(), ids, false)
}
</script>

<template>
  <div>
    <div class="mb-2.5 flex items-center gap-2.5">
      <div class="flex items-center gap-1.5">
        <h4 id="web-serials-manga-sources" class="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('webSerials.settings.sources.mangaTitle') }}
        </h4>
        <WebSerialSourcesDisclaimer />
      </div>
      <span v-if="groups.length" class="ms-auto text-xs text-muted-foreground">
        {{ t('webSerials.settings.sources.mangaMeta', { selected: searchedCount, total: mangaSources.length }) }}
      </span>
    </div>

    <p v-if="mangaSourcesLoading" class="text-xs text-muted-foreground">{{ t('webSerials.settings.sources.loading') }}</p>
    <p v-else-if="mangaSourcesError" role="alert" class="text-xs text-destructive">{{ mangaSourcesError }}</p>
    <p v-else-if="groups.length === 0" class="text-xs text-muted-foreground">{{ t('webSerials.settings.sources.mangaEmpty') }}</p>

    <template v-else>
      <div class="grid gap-2 md:grid-cols-2" aria-labelledby="web-serials-manga-sources" role="group">
        <div v-for="(group, index) in groups" :key="group.lang" class="rounded-lg border border-border bg-background px-3 py-2.5">
          <div class="mb-2 flex items-center gap-2">
            <span class="size-1.5 rounded-[2px]" :style="{ backgroundColor: groupColor(index) }" aria-hidden="true" />
            <p :id="`web-serials-lang-${group.lang}`" class="text-xs font-semibold text-foreground">{{ languageName(group.lang, locale) }}</p>
            <span class="text-xs text-muted-foreground">
              {{ t('webSerials.settings.sources.groupCount', { selected: groupSelectedCount(group.ids), total: group.ids.length }) }}
            </span>
            <span class="ms-auto flex items-center gap-2">
              <button
                type="button"
                class="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="handleGroupAll(group.ids)"
              >
                {{ t('webSerials.settings.sources.selectAll') }}
              </button>
              <button
                type="button"
                class="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="handleGroupNone(group.ids)"
              >
                {{ t('webSerials.settings.sources.selectNone') }}
              </button>
            </span>
          </div>
          <ul class="flex flex-wrap gap-1.5" :aria-labelledby="`web-serials-lang-${group.lang}`">
            <li v-for="source in group.sources" :key="source.id">
              <button
                type="button"
                class="rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :class="
                  isSelected(source.id)
                    ? 'border-transparent bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground hover:text-foreground'
                "
                :aria-pressed="isSelected(source.id)"
                @click="handleToggle(source.id)"
              >
                {{ cleanSourceName(source.name) }}
              </button>
            </li>
          </ul>
        </div>
      </div>
      <p class="settings-hint mt-2.5">{{ t('webSerials.settings.sources.mangaHint') }}</p>
    </template>
  </div>
</template>
