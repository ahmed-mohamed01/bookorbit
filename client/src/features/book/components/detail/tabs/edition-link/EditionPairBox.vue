<script setup lang="ts">
import { computed } from 'vue'
import { Link2 } from '@lucide/vue'
import type { EditionLinkCandidate } from '@bookorbit/types'
import type { EditionSlot, LinkEditionPhase } from '@/features/book/composables/useLinkEditionPanel'
import EditionSlotCard from './EditionSlotCard.vue'
import EditionSlotSearch from './EditionSlotSearch.vue'

const props = defineProps<{
  phase: LinkEditionPhase
  slots: [EditionSlot, EditionSlot]
  canSearch: boolean
  query: string
  candidates: EditionLinkCandidate[]
  searching: boolean
  searchError: string | null
  hasSearched: boolean
  searchAutofocus: boolean
  disabled: boolean
}>()

const emit = defineEmits<{ change: []; pick: [candidate: EditionLinkCandidate]; 'update:query': [value: string] }>()

const merged = computed(() => props.phase === 'linked')
const linking = computed(() => props.phase === 'linking')

const pairClass = computed(() => {
  if (merged.value) return 'gap-0 p-0.5 border-success/50 bg-success/5 ring-4 ring-success/10'
  return `${linking.value ? 'gap-3.5' : 'gap-5'} p-0 border-transparent bg-transparent ring-0 ring-transparent`
})

const connectorClass = computed(() => {
  if (merged.value) return 'scale-120 border-2 border-popover bg-success text-success-foreground ring-4 ring-success/20'
  if (linking.value) return 'border border-border bg-popover text-info'
  return 'border border-border bg-popover text-muted-foreground'
})

function handleChange() {
  emit('change')
}

function handlePick(candidate: EditionLinkCandidate) {
  emit('pick', candidate)
}

function handleQuery(value: string) {
  emit('update:query', value)
}
</script>

<template>
  <div
    class="relative flex flex-col rounded-2xl border transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
    :class="pairClass"
    :data-phase="phase"
    data-testid="edition-pair"
  >
    <div
      class="pointer-events-none absolute inset-x-4 top-1/2 h-px bg-success/25 transition-opacity duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      :class="merged ? 'opacity-100' : 'opacity-0'"
      aria-hidden="true"
    />
    <template v-for="(edition, index) in slots" :key="edition.format">
      <EditionSlotCard
        v-if="edition.kind === 'filled'"
        :edition="edition"
        :merged="merged"
        :position="index === 0 ? 'top' : 'bottom'"
        @change="handleChange"
      />
      <EditionSlotSearch
        v-else
        :format="edition.format"
        :can-search="canSearch"
        :query="query"
        :candidates="candidates"
        :searching="searching"
        :search-error="searchError"
        :has-searched="hasSearched"
        :autofocus="searchAutofocus"
        :disabled="disabled"
        @pick="handlePick"
        @update:query="handleQuery"
      />
    </template>
    <div
      v-show="phase !== 'nomatch'"
      class="absolute top-1/2 left-1/2 z-[2] flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      :class="connectorClass"
      aria-hidden="true"
      data-testid="edition-connector"
    >
      <span
        v-if="linking"
        class="absolute -inset-[3px] animate-spin rounded-full border-2 border-transparent border-t-info"
        data-testid="edition-connector-spinner"
      />
      <Link2 class="size-3" />
    </div>
  </div>
</template>
