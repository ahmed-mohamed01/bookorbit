<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { WebSerialPrintSuggestion } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'
defineProps<{ suggestion: WebSerialPrintSuggestion; disabled?: boolean }>()
const emit = defineEmits<{ select: [] }>()
const { t } = useI18n()
function select() {
  emit('select')
}
</script>
<template>
  <section class="flex flex-wrap items-center gap-4 rounded-xl border border-primary/40 bg-primary/10 p-4">
    <div class="min-w-0 flex-1 space-y-1">
      <p class="text-sm font-semibold">
        {{
          t(
            'webSerials.acquisition.suggestion',
            { count: suggestion.volumes.length, releases: suggestion.releases.length },
            suggestion.volumes.length,
          )
        }}
      </p>
      <p class="text-xs text-muted-foreground">
        {{ suggestion.sizeBytes === null ? '' : t('webSerials.acquisition.totalSize', { size: formatBytes(suggestion.sizeBytes) }) }}
      </p>
    </div>
    <button
      type="button"
      class="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      :disabled="disabled"
      @click="select"
    >
      {{ t('webSerials.acquisition.selectThese', suggestion.releases.length) }}
    </button>
  </section>
</template>
