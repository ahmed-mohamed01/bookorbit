<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WebSerialPrintVolume } from '@bookorbit/types'
const props = defineProps<{ volumes: WebSerialPrintVolume[]; selected: Set<number>; requestSummary?: string; busy?: boolean }>()
const emit = defineEmits<{ 'update:selected': [volumes: Set<number>]; request: [volumes: number[]]; cancel: [] }>()
const { t } = useI18n()
const missing = computed(() => props.volumes.filter((v) => v.state === 'missing').map((v) => v.volume))
const chosen = computed(() => missing.value.filter((v) => props.selected.has(v)))
function allMissing() {
  emit('update:selected', new Set(missing.value))
}
function request() {
  if (chosen.value.length && !props.busy) emit('request', chosen.value)
}
function cancel() {
  emit('cancel')
}
</script>
<template>
  <div class="flex flex-1 flex-col gap-4">
    <section class="space-y-1.5 rounded-xl border border-border bg-card p-4">
      <h3 class="text-sm font-semibold">{{ t('webSerials.acquisition.requestTitle') }}</h3>
      <p class="text-xs text-muted-foreground">{{ t('webSerials.acquisition.requestHelp') }}</p>
    </section>
    <section v-if="requestSummary" class="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3.5">
      <span class="size-2 shrink-0 rounded-full bg-primary" />
      <p class="flex-1 text-xs">{{ requestSummary }}</p>
      <button type="button" class="rounded-lg border border-border px-3 py-2 text-xs" :disabled="busy" @click="cancel">
        {{ t('webSerials.acquisition.cancelRequest') }}
      </button>
    </section>
    <footer class="mt-auto flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3.5">
      <div class="flex-1">
        <p class="text-sm font-semibold">{{ t('webSerials.acquisition.volumesSelected', chosen.length) }}</p>
        <p class="text-xs text-muted-foreground">{{ t('webSerials.acquisition.requestDetail') }}</p>
      </div>
      <button type="button" class="h-10 rounded-lg border border-border px-3 text-sm" :disabled="busy || !missing.length" @click="allMissing">
        {{ t('webSerials.acquisition.allMissing') }}</button
      ><button
        type="button"
        class="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        :disabled="busy || !chosen.length"
        @click="request"
      >
        {{ t('webSerials.acquisition.requestVolumes', chosen.length) }}
      </button>
    </footer>
  </div>
</template>
