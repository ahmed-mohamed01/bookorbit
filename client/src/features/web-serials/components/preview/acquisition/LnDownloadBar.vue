<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { formatBytes } from '@/lib/formatting'
defineProps<{ volumeCount: number; releaseCount: number; sizeBytes: number; canSend: boolean; sending?: boolean }>()
const emit = defineEmits<{ download: [] }>()
const { t } = useI18n()
function download() {
  emit('download')
}
</script>
<template>
  <footer class="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3.5 sm:px-8">
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold">
        {{
          releaseCount
            ? t('webSerials.acquisition.barTitle', { count: volumeCount, releases: releaseCount }, volumeCount)
            : t('webSerials.acquisition.nothingSelected')
        }}
      </p>
      <p class="text-xs text-muted-foreground">
        {{ releaseCount ? t('webSerials.acquisition.barDetail', { size: formatBytes(sizeBytes) }) : t('webSerials.acquisition.pickHint') }}
      </p>
    </div>
    <slot />
    <button
      type="button"
      class="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:bg-muted disabled:text-muted-foreground"
      :disabled="!canSend || !releaseCount || !volumeCount || sending"
      @click="download"
    >
      {{ t(sending ? 'webSerials.acquisition.downloading' : 'webSerials.acquisition.download', volumeCount) }}
    </button>
  </footer>
</template>
