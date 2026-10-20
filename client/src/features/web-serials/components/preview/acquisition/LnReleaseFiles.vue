<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReleaseSelectionManifest, WebSerialPrintVolume } from '@bookorbit/types'
import ReleaseFileTree from '@/features/book-requests/components/ReleaseFileTree.vue'
import { useReleaseFileSelection } from '@/features/book-requests/composables/useReleaseFileSelection'
import { preselectMissingUnits, unitVolumes } from '../../../lib/lnAcquisition'
import { formatBytes } from '@/lib/formatting'
const props = defineProps<{ manifest: ReleaseSelectionManifest; volumes: WebSerialPrintVolume[]; selected?: Set<number> }>()
const emit = defineEmits<{ change: [indexes: Set<number>] }>()
const { t } = useI18n()
const locks = computed(() => {
  const states = new Map(props.volumes.map((v) => [v.volume, v.state]))
  const max = Math.max(0, ...props.volumes.map((v) => v.volume))
  const tags = new Map<number, string>()
  for (const unit of props.manifest.units) {
    const state = unitVolumes(unit, max)
      .map((v) => states.get(v))
      .find((s) => s === 'owned' || s === 'in_dock' || s === 'downloading')
    if (state) tags.set(unit.index, t(`webSerials.acquisition.state.${state}`))
  }
  for (const index of props.manifest.alreadyImported ?? []) tags.set(index, t('webSerials.acquisition.state.in_dock'))
  return tags
})
const manifest = computed(() => ({ ...props.manifest, alreadyImported: [...locks.value.keys()] }))
const { tree, selectedUnits, selectedSizeBytes, toggleUnit, toggleDir, dirState } = useReleaseFileSelection(manifest, (units) => [
  ...preselectMissingUnits(units, props.volumes),
])
watch(
  [manifest, () => props.selected],
  () => {
    if (!props.selected) return
    const valid = new Set(props.manifest.units.map((unit) => unit.index))
    const next = new Set([...props.selected].filter((index) => valid.has(index) && !locks.value.has(index)))
    if (next.size !== selectedUnits.value.size || [...next].some((index) => !selectedUnits.value.has(index))) selectedUnits.value = next
  },
  { immediate: true },
)
watch(selectedUnits, (selected) => emit('change', new Set(selected)), { deep: true, immediate: true })
</script>
<template>
  <div class="space-y-2 border-t border-border px-4 pt-3 pb-3.5">
    <div class="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
      <span>{{ t('webSerials.acquisition.fileHint', manifest.units.length) }}</span
      ><span>{{ t('webSerials.acquisition.ticked', { count: selectedUnits.size, size: formatBytes(selectedSizeBytes) }, selectedUnits.size) }}</span>
    </div>
    <ReleaseFileTree
      v-if="tree"
      :tree="tree"
      selectable
      :selected-units="selectedUnits"
      :dir-state="dirState"
      :locked-labels="locks"
      @toggle-unit="toggleUnit"
      @toggle-dir="toggleDir"
    />
  </div>
</template>
