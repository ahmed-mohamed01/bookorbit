<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Download, Loader2, Puzzle, RefreshCw, Trash2 } from '@lucide/vue'
import type { WebSerialMangaExtension } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import type { WebSerialExtensionAction } from '../../api/webSerials'
import { languageName } from './settingsLib'

const props = defineProps<{
  extension: WebSerialMangaExtension
  busy: WebSerialExtensionAction | null
  /** The Installed tab offers Uninstall; the Available tab offers Install. */
  mode: 'installed' | 'available'
}>()

const emit = defineEmits<{ install: []; uninstall: []; update: [] }>()

const { t, locale } = useI18n()

const language = computed(() =>
  props.extension.lang === 'all' ? t('webSerials.settings.extensions.multiLanguage') : languageName(props.extension.lang, locale.value),
)
const working = computed(() => props.busy !== null)

function handleInstall() {
  emit('install')
}

function handleUninstall() {
  emit('uninstall')
}

function handleUpdate() {
  emit('update')
}
</script>

<template>
  <li class="flex items-center gap-3 py-2.5">
    <span class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
      <img v-if="extension.iconUrl" :src="extension.iconUrl" alt="" loading="lazy" class="size-full object-cover" />
      <Puzzle v-else :size="16" />
    </span>

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p class="truncate text-sm font-medium text-foreground">{{ extension.name }}</p>
        <span class="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{{ language }}</span>
        <span v-if="extension.adult" class="rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">
          {{ t('webSerials.settings.extensions.adult') }}
        </span>
        <span v-if="extension.hasUpdate" class="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
          {{ t('webSerials.settings.extensions.updateAvailable') }}
        </span>
      </div>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ t('webSerials.settings.extensions.version', { version: extension.versionName }) }}</p>
    </div>

    <div class="flex shrink-0 items-center gap-1.5">
      <Button v-if="extension.hasUpdate && extension.installed" size="sm" variant="outline" :disabled="working" @click="handleUpdate">
        <Loader2 v-if="busy === 'update'" class="animate-spin" aria-hidden="true" />
        <RefreshCw v-else :size="14" aria-hidden="true" />
        {{ t('webSerials.settings.extensions.update') }}
      </Button>

      <template v-if="mode === 'installed'">
        <Button size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="working" @click="handleUninstall">
          <Loader2 v-if="busy === 'uninstall'" class="animate-spin" aria-hidden="true" />
          <Trash2 v-else :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.extensions.uninstall') }}
        </Button>
      </template>
      <template v-else>
        <span v-if="extension.installed" class="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Check :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.extensions.installedLabel') }}
        </span>
        <Button v-else size="sm" :disabled="working" @click="handleInstall">
          <Loader2 v-if="busy === 'install'" class="animate-spin" aria-hidden="true" />
          <Download v-else :size="14" aria-hidden="true" />
          {{ busy === 'install' ? t('webSerials.settings.extensions.installing') : t('webSerials.settings.extensions.install') }}
        </Button>
      </template>
    </div>
  </li>
</template>
