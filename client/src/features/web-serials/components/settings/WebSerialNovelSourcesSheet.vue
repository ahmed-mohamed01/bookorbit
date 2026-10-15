<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Download, Loader2, RefreshCw, Search, Trash2, X } from '@lucide/vue'
import type { WebSerialNovelSourceEntry } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { formatLanguageName } from '@/i18n/formatters'
import { useWebSerialNovelSources } from '../../composables/useWebSerialNovelSources'
import { useWebSerialSettingsContext } from './settingsContext'
import WebSerialSourcesDisclaimer from '../WebSerialSourcesDisclaimer.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const { t } = useI18n()
const settings = useWebSerialSettingsContext()
const state = useWebSerialNovelSources(() => emit('changed'))
const selected = computed(() => new Set(settings.draft.novel.sourceIds))
// The source service filters by the English language name; the code only names it in the reader's language.
const LANGUAGES = [
  { value: 'English', code: 'en' },
  { value: 'Chinese', code: 'zh' },
  { value: 'French', code: 'fr' },
  { value: 'Indonesian', code: 'id' },
  { value: 'Japanese', code: 'ja' },
  { value: 'Korean', code: 'ko' },
  { value: 'Spanish', code: 'es' },
  { value: 'Vietnamese', code: 'vi' },
] as const
const languages = computed(() => LANGUAGES.map((language) => ({ value: language.value, label: formatLanguageName(language.code) })))
const pendingRemoval = ref<WebSerialNovelSourceEntry | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) void state.load()
  },
  { immediate: true },
)

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}

function handleClose() {
  emit('close')
}

function handleLanguage(event: Event) {
  state.setLanguage((event.target as HTMLSelectElement).value)
}

async function handleInstall(source: WebSerialNovelSourceEntry) {
  if (await state.act(source, 'install')) settings.draft.novel.sourceIds = [...new Set([...settings.draft.novel.sourceIds, source.id])]
}

function handleReinstall(source: WebSerialNovelSourceEntry) {
  void state.act(source, 'install')
}

function handleUpdate(source: WebSerialNovelSourceEntry) {
  void state.act(source, 'update')
}

function handleRemove(source: WebSerialNovelSourceEntry) {
  pendingRemoval.value = source
}

async function handleConfirmRemove() {
  const source = pendingRemoval.value
  if (!source) return
  if (await state.act(source, 'remove')) settings.draft.novel.sourceIds = settings.draft.novel.sourceIds.filter((id) => id !== source.id)
  pendingRemoval.value = null
}

function handleCancelRemove() {
  pendingRemoval.value = null
}

function toggleLabel(source: WebSerialNovelSourceEntry): string {
  return t('webSerials.settings.novelSources.searchSource', { name: source.name })
}

function handleToggle(source: WebSerialNovelSourceEntry) {
  settings.draft.novel.sourceIds = selected.value.has(source.id)
    ? settings.draft.novel.sourceIds.filter((id) => id !== source.id)
    : [...settings.draft.novel.sourceIds, source.id]
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent side="right" hide-close class="w-full gap-0 p-0 sm:max-w-2xl">
      <div class="flex min-h-0 flex-1 flex-col">
        <header class="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
          <div>
            <div class="flex items-center gap-1.5">
              <SheetTitle class="settings-label">{{ t('webSerials.settings.novelSources.title') }}</SheetTitle>
              <WebSerialSourcesDisclaimer />
            </div>
            <SheetDescription class="mt-1 text-xs text-muted-foreground">
              {{ t('webSerials.settings.novelSources.description') }}
            </SheetDescription>
          </div>
          <Button size="sm" variant="outline" @click="handleClose"
            ><X :size="15" aria-hidden="true" /><span class="sr-only">{{ t('common.close') }}</span></Button
          >
        </header>

        <div class="flex flex-wrap gap-2 border-b border-border px-4 py-3 md:px-5">
          <div class="relative min-w-48 flex-1">
            <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <label for="web-serial-novel-sources-search" class="sr-only">{{ t('webSerials.settings.novelSources.search') }}</label>
            <input
              id="web-serial-novel-sources-search"
              v-model="state.query.value"
              type="search"
              class="settings-control ps-8"
              :placeholder="t('webSerials.settings.novelSources.search')"
            />
          </div>
          <label for="web-serial-novel-sources-language" class="sr-only">{{ t('webSerials.settings.novelSources.language') }}</label>
          <select id="web-serial-novel-sources-language" class="settings-control w-auto" :value="state.language.value" @change="handleLanguage">
            <option v-for="language in languages" :key="language.value" :value="language.value">{{ language.label }}</option>
          </select>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
          <p v-if="state.error.value" role="alert" class="mb-3 text-xs text-destructive">{{ state.error.value }}</p>
          <p v-if="state.loading.value" class="text-sm text-muted-foreground">{{ t('webSerials.settings.novelSources.loading') }}</p>
          <p v-else-if="state.filtered.value.length === 0" class="text-sm text-muted-foreground">{{ t('webSerials.settings.novelSources.empty') }}</p>
          <ul v-else class="divide-y divide-border">
            <li v-for="source in state.filtered.value" :key="source.id" class="flex flex-wrap items-center gap-3 py-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="font-medium text-foreground">{{ source.name }}</p>
                  <span v-if="source.installed" class="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{{
                    t('webSerials.settings.novelSources.installed')
                  }}</span>
                  <span v-if="source.broken" class="rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">{{
                    t('webSerials.settings.novelSources.broken')
                  }}</span>
                  <span
                    v-if="source.updateAvailable && !source.broken"
                    class="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary"
                    >{{ t('webSerials.settings.novelSources.updateAvailable') }}</span
                  >
                </div>
                <p class="truncate text-xs text-muted-foreground">{{ source.site }}</p>
                <p v-if="source.broken" class="mt-0.5 text-xs text-destructive">{{ t('webSerials.settings.novelSources.brokenHint') }}</p>
              </div>

              <button
                v-if="source.installed"
                type="button"
                role="switch"
                :aria-checked="selected.has(source.id)"
                :aria-label="toggleLabel(source)"
                class="rounded-md border border-border px-2 py-1 text-xs font-medium"
                @click="handleToggle(source)"
              >
                <Check v-if="selected.has(source.id)" class="me-1 inline size-3.5" aria-hidden="true" />
                {{ selected.has(source.id) ? t('webSerials.settings.novelSources.enabled') : t('webSerials.settings.novelSources.disabled') }}
              </button>
              <Button
                v-if="source.broken"
                size="sm"
                variant="outline"
                :disabled="Boolean(state.busy[source.id])"
                :aria-label="t('webSerials.settings.novelSources.reinstallSource', { name: source.name })"
                @click="handleReinstall(source)"
              >
                <Loader2 v-if="state.busy[source.id] === 'install'" class="animate-spin" aria-hidden="true" /><RefreshCw
                  v-else
                  :size="14"
                  aria-hidden="true"
                />
                {{ t('webSerials.settings.novelSources.reinstall') }}
              </Button>
              <Button
                v-else-if="source.updateAvailable"
                size="sm"
                variant="outline"
                :disabled="Boolean(state.busy[source.id])"
                :aria-label="t('webSerials.settings.novelSources.updateSource', { name: source.name })"
                @click="handleUpdate(source)"
              >
                <Loader2 v-if="state.busy[source.id] === 'update'" class="animate-spin" aria-hidden="true" /><RefreshCw
                  v-else
                  :size="14"
                  aria-hidden="true"
                />
                {{ t('webSerials.settings.novelSources.update') }}
              </Button>
              <Button
                v-if="source.installed"
                size="sm"
                variant="outline"
                class="text-destructive"
                :disabled="Boolean(state.busy[source.id])"
                :aria-label="t('webSerials.settings.novelSources.removeSource', { name: source.name })"
                @click="handleRemove(source)"
              >
                <Loader2 v-if="state.busy[source.id] === 'remove'" class="animate-spin" aria-hidden="true" /><Trash2
                  v-else
                  :size="14"
                  aria-hidden="true"
                />
                {{ t('webSerials.settings.novelSources.remove') }}
              </Button>
              <Button
                v-else
                size="sm"
                :disabled="Boolean(state.busy[source.id])"
                :aria-label="t('webSerials.settings.novelSources.installSource', { name: source.name })"
                @click="handleInstall(source)"
              >
                <Loader2 v-if="state.busy[source.id] === 'install'" class="animate-spin" aria-hidden="true" /><Download
                  v-else
                  :size="14"
                  aria-hidden="true"
                />
                {{ t('webSerials.settings.novelSources.install') }}
              </Button>
            </li>
          </ul>
        </div>
      </div>
    </SheetContent>
  </Sheet>
  <ConfirmDialog
    :open="pendingRemoval !== null"
    :title="t('webSerials.settings.novelSources.removeTitle', { name: pendingRemoval?.name ?? '' })"
    :description="t('webSerials.settings.novelSources.removeDescription', { name: pendingRemoval?.name ?? '' })"
    :confirm-label="t('webSerials.settings.novelSources.remove')"
    :busy="pendingRemoval !== null && Boolean(state.busy[pendingRemoval.id])"
    @confirm="handleConfirmRemove"
    @cancel="handleCancelRemove"
  />
</template>
