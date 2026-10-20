<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WebSerialPrintVolume, WebSerialViewerRole } from '@bookorbit/types'
const props = withDefaults(
  defineProps<{ volumes: WebSerialPrintVolume[]; selected?: Set<number>; planned?: Set<number>; role?: WebSerialViewerRole }>(),
  { selected: () => new Set(), planned: () => new Set(), role: 'approver' },
)
const emit = defineEmits<{ toggle: [volume: number]; 'show-missing': []; clear: [] }>()
const { t } = useI18n()
const tones = {
  owned: 'bg-success/10 border-success/40 text-success',
  in_dock: 'bg-info/10 border-info/40 text-info',
  downloading: 'bg-warning/10 border-warning/40 text-warning',
  requested: 'bg-primary/10 border-primary/40 text-primary',
  missing: 'bg-card border-border text-foreground',
}
const legend = computed(() =>
  props.role === 'requester' ? (['owned', 'requested', 'missing'] as const) : (['owned', 'in_dock', 'downloading', 'missing'] as const),
)
const summary = computed(() =>
  legend.value.map((state) => t(`webSerials.acquisition.count.${state}`, props.volumes.filter((v) => v.state === state).length)).join(' · '),
)
function toggle(volume: WebSerialPrintVolume) {
  if (props.role === 'approver' || volume.state === 'missing') emit('toggle', volume.volume)
}
function showMissing() {
  emit('show-missing')
}
function clear() {
  emit('clear')
}
function label(volume: WebSerialPrintVolume) {
  return (
    t('webSerials.acquisition.cell', { volume: volume.volume, state: t(`webSerials.acquisition.state.${volume.state}`) }) +
    (props.planned.has(volume.volume) ? ', ' + t('webSerials.acquisition.willDownload') : '')
  )
}
</script>
<template>
  <section class="flex flex-col gap-3.5">
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('webSerials.acquisition.volumes') }}</h2>
      <span class="text-xs text-muted-foreground">{{ summary }}</span>
    </div>
    <div class="grid grid-cols-10 gap-1.5 sm:grid-cols-13">
      <button
        v-for="volume in volumes"
        :key="volume.volume"
        type="button"
        class="relative flex h-11 items-center justify-center rounded-lg border p-0 text-sm font-semibold tabular-nums focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
        :class="[
          tones[volume.state],
          selected.has(volume.volume) ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : '',
          planned.has(volume.volume) ? 'border-2 border-dashed border-primary' : '',
        ]"
        :aria-pressed="selected.has(volume.volume)"
        :aria-label="label(volume)"
        :title="volume.error ?? label(volume)"
        :disabled="role === 'requester' && volume.state !== 'missing'"
        @click="toggle(volume)"
      >
        <span>{{ volume.volume }}</span
        ><span v-if="volume.state === 'owned'" class="absolute top-1 right-1 size-1 rounded-full bg-success" /><span
          v-if="volume.state === 'downloading'"
          class="absolute inset-x-2 bottom-1.5 h-0.5 rounded bg-warning"
        />
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span v-for="state in legend" :key="state" class="inline-flex items-center gap-1.5"
        ><span class="size-3 rounded-sm border" :class="tones[state]" />{{ t(`webSerials.acquisition.legend.${state}`) }}</span
      ><span class="inline-flex items-center gap-1.5"
        ><span class="size-3 rounded-sm border-2 border-primary" :class="role === 'approver' ? 'border-dashed' : ''" />{{
          t(role === 'approver' ? 'webSerials.acquisition.willDownload' : 'webSerials.acquisition.selected')
        }}</span
      ><template v-if="role === 'approver'"
        ><button type="button" class="ms-auto h-8 rounded-lg border border-border px-3 text-foreground" @click="showMissing">
          {{ t('webSerials.acquisition.showMissing') }}</button
        ><button v-if="selected.size" type="button" class="h-8 text-primary" @click="clear">
          {{ t('webSerials.acquisition.clearFilter') }}
        </button></template
      >
    </div>
  </section>
</template>
