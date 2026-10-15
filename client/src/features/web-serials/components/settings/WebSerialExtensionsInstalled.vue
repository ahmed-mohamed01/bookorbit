<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { WebSerialMangaExtension } from '@bookorbit/types'
import { useWebSerialExtensionsContext } from './extensionsContext'
import WebSerialExtensionRow from './WebSerialExtensionRow.vue'

const { t } = useI18n()
const state = useWebSerialExtensionsContext()
const { installed, installedTotal, installedLoading, installedError, busy } = state
const hasMore = computed(() => installed.value.length < installedTotal.value)

function handleUpdate(extension: WebSerialMangaExtension) {
  void state.update(extension)
}

function handleMore() {
  state.loadMoreInstalled()
}

function handleUninstall(extension: WebSerialMangaExtension) {
  state.requestUninstall(extension)
}
</script>

<template>
  <div>
    <div v-if="installedLoading && installed.length === 0" class="flex justify-center py-8">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('webSerials.settings.extensions.loading') }}</span>
    </div>
    <p v-else-if="installedError && installed.length === 0" role="alert" class="text-xs text-destructive">{{ installedError }}</p>
    <p v-else-if="installed.length === 0" class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      {{ t('webSerials.settings.extensions.installedEmpty') }}
    </p>
    <ul v-else class="divide-y divide-border">
      <WebSerialExtensionRow
        v-for="extension in installed"
        :key="extension.pkgName"
        :extension="extension"
        :busy="busy[extension.pkgName] ?? null"
        mode="installed"
        @update="handleUpdate(extension)"
        @uninstall="handleUninstall(extension)"
      />
    </ul>
    <div v-if="hasMore" class="flex flex-col items-center gap-1.5 pt-2">
      <p v-if="installedError && installed.length > 0" role="alert" class="text-xs text-destructive">{{ installedError }}</p>
      <p class="text-xs text-muted-foreground tabular-nums">
        {{ t('webSerials.settings.extensions.installedShowing', { shown: installed.length, total: installedTotal }) }}
      </p>
      <Button size="sm" variant="outline" :disabled="installedLoading" @click="handleMore">
        <Loader2 v-if="installedLoading" class="animate-spin" aria-hidden="true" />
        {{ t('webSerials.settings.extensions.loadMore') }}
      </Button>
    </div>
  </div>
</template>
