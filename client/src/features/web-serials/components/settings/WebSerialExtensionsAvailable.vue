<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw, Search } from '@lucide/vue'
import type { WebSerialMangaExtension } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useWebSerialExtensionsContext } from './extensionsContext'
import WebSerialExtensionRow from './WebSerialExtensionRow.vue'
import { languageName } from './settingsLib'

const emit = defineEmits<{ goToRepositories: [] }>()

const { t, locale } = useI18n()
const state = useWebSerialExtensionsContext()
const { available, availableTotal, languages, availableLoading, availableError, search, lang, showAdult, refreshing, hasMore, repos, busy } = state

const languageOptions = computed(() =>
  languages.value.map((code) => ({
    code,
    label: code === 'all' ? t('webSerials.settings.extensions.multiLanguage') : languageName(code, locale.value),
  })),
)
const noRepos = computed(() => repos.value.length === 0)
const initialLoading = computed(() => availableLoading.value && available.value.length === 0)

function handleGoToRepositories() {
  emit('goToRepositories')
}

function handleSearch(event: Event) {
  state.setSearch((event.target as HTMLInputElement).value)
}

function handleLang(value: string | number) {
  state.setLang(String(value))
}

function handleAdult(value: boolean) {
  state.setShowAdult(value)
}

function handleRefresh() {
  void state.refreshList()
}

function handleMore() {
  state.loadMore()
}

function handleInstall(extension: WebSerialMangaExtension) {
  void state.install(extension)
}

function handleUpdate(extension: WebSerialMangaExtension) {
  void state.update(extension)
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="noRepos && !state.reposLoading.value" class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      <p>{{ t('webSerials.settings.extensions.noRepos') }}</p>
      <Button size="sm" variant="outline" class="mt-3" @click="handleGoToRepositories">
        {{ t('webSerials.settings.extensions.goToRepositories') }}
      </Button>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <label class="relative min-w-40 flex-1 basis-48">
          <span class="sr-only">{{ t('webSerials.settings.extensions.searchLabel') }}</span>
          <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            :value="search"
            type="search"
            autocomplete="off"
            :placeholder="t('webSerials.settings.extensions.searchPlaceholder')"
            class="settings-control ps-8"
            @input="handleSearch"
          />
        </label>
        <Select :model-value="lang" class="w-44" :aria-label="t('webSerials.settings.extensions.languageLabel')" @update:model-value="handleLang">
          <option value="">{{ t('webSerials.settings.extensions.allLanguages') }}</option>
          <option v-for="option in languageOptions" :key="option.code" :value="option.code">{{ option.label }}</option>
        </Select>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="flex items-center gap-2 text-xs text-foreground">
          <ToggleSwitch :model-value="showAdult" @update:model-value="handleAdult" />
          {{ t('webSerials.settings.extensions.showAdult') }}
        </label>
        <div class="flex items-center gap-3">
          <span class="text-xs text-muted-foreground" role="status">
            {{ t('webSerials.settings.extensions.count', { count: availableTotal }) }}
          </span>
          <Button size="sm" variant="ghost" :disabled="refreshing" @click="handleRefresh">
            <Loader2 v-if="refreshing" class="animate-spin" aria-hidden="true" />
            <RefreshCw v-else :size="14" aria-hidden="true" />
            {{ refreshing ? t('webSerials.settings.extensions.refreshing') : t('webSerials.settings.extensions.refresh') }}
          </Button>
        </div>
      </div>

      <div v-if="initialLoading" class="flex justify-center py-8">
        <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span class="sr-only">{{ t('webSerials.settings.extensions.loading') }}</span>
      </div>
      <p v-else-if="availableError" role="alert" class="text-xs text-destructive">{{ availableError }}</p>
      <p v-else-if="available.length === 0" class="text-sm text-muted-foreground">{{ t('webSerials.settings.extensions.noMatch') }}</p>
      <template v-else>
        <ul class="divide-y divide-border">
          <WebSerialExtensionRow
            v-for="extension in available"
            :key="extension.pkgName"
            :extension="extension"
            :busy="busy[extension.pkgName] ?? null"
            mode="available"
            @install="handleInstall(extension)"
            @update="handleUpdate(extension)"
          />
        </ul>
        <div v-if="hasMore" class="flex justify-center pt-1">
          <Button size="sm" variant="outline" :disabled="availableLoading" @click="handleMore">
            <Loader2 v-if="availableLoading" class="animate-spin" aria-hidden="true" />
            {{ t('webSerials.settings.extensions.loadMore') }}
          </Button>
        </div>
      </template>
    </template>
  </div>
</template>
