<script setup lang="ts">
import { computed } from 'vue'
import { Link2 } from '@lucide/vue'
import type { EditionLinkCandidate } from '@bookorbit/types'
import type { EditionFilledSlot, EditionSlot, LinkEditionPhase, PairSyncState } from '@/features/book/composables/useLinkEditionPanel'
import EditionSlotCard from './EditionSlotCard.vue'
import EditionSlotSearch from './EditionSlotSearch.vue'

const props = defineProps<{
  phase: LinkEditionPhase
  slots: [EditionSlot, EditionSlot]
  readAlong?: EditionFilledSlot | null
  syncState?: PairSyncState
  readAlongRebuildLabel?: string | null
  readAlongRebuildDisabled?: boolean
  canSearch: boolean
  query: string
  candidates: EditionLinkCandidate[]
  searching: boolean
  searchError: string | null
  hasSearched: boolean
  searchAutofocus: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  change: []
  pick: [candidate: EditionLinkCandidate]
  'update:query': [value: string]
  'rebuild-read-along': []
}>()

const merged = computed(() => props.phase === 'linked')
const linking = computed(() => props.phase === 'linking')

const pairClass = computed(() => {
  if (merged.value) return 'gap-0'
  return linking.value ? 'gap-[5px]' : 'gap-[7px]'
})

// The connector rides on the covers' centre line, so once linked it becomes a node on the timeline rail
// that runs through the covers. Separate cards keep their border and padding, which shifts that line.
const connectorPlacement = computed(() => (merged.value ? 'left-5 size-5' : 'left-[31px] size-6'))

// Once linked, the node and rail follow position sync, so a rebuild or a broken map never shows as a
// settled green link beside the header's own status.
const railSyncState = computed<PairSyncState>(() => props.syncState ?? 'synced')
const rebuilding = computed(() => merged.value && railSyncState.value === 'syncing')

const railClass = computed(() => {
  if (!merged.value) return 'opacity-0 bg-success/40'
  if (railSyncState.value === 'syncing') return 'opacity-100 animate-pulse bg-info/40'
  if (railSyncState.value === 'unsynced') return 'opacity-100 bg-border'
  return 'opacity-100 bg-success/40'
})

const connectorClass = computed(() => {
  if (rebuilding.value) return 'border-2 border-popover bg-info text-info-foreground ring-2 ring-info/25'
  if (merged.value && railSyncState.value === 'unsynced') return 'border border-border bg-popover text-muted-foreground'
  if (merged.value) return 'border-2 border-popover bg-success text-success-foreground ring-2 ring-success/25'
  if (linking.value) return 'border border-border bg-popover text-info'
  return 'border border-border bg-popover text-muted-foreground'
})

// A detached read-along shows beside its unlinked pair, so its stop takes the pair's styling: settled
// green only once the three are linked.
const readAlongRailClass = computed(() => (merged.value ? 'opacity-100 bg-success/40' : 'opacity-0 bg-success/40'))
const readAlongConnectorClass = computed(() =>
  merged.value
    ? 'border-2 border-popover bg-success text-success-foreground ring-2 ring-success/25'
    : 'border border-border bg-popover text-muted-foreground',
)

function cardPosition(index: number): 'top' | 'middle' | 'bottom' {
  if (index === 0) return 'top'
  return index === 1 && props.readAlong ? 'middle' : 'bottom'
}

function handleRebuildReadAlong() {
  emit('rebuild-read-along')
}

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
    class="relative flex flex-col transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
    :class="pairClass"
    :data-phase="phase"
    data-testid="edition-pair"
  >
    <template v-for="(edition, index) in slots" :key="edition.format">
      <div v-if="index === 1" class="relative h-0">
        <div
          aria-hidden="true"
          class="pointer-events-none absolute -top-8 left-5 h-16 w-0.5 -translate-x-1/2 rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          :class="railClass"
          data-testid="edition-rail"
        />
        <div
          aria-hidden="true"
          class="pointer-events-none absolute top-0 right-0 left-9.5 h-px bg-border/60 transition-opacity duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          :class="merged ? 'opacity-100' : 'opacity-0'"
          data-testid="edition-row-divider"
        />
        <div
          v-show="phase !== 'nomatch'"
          aria-hidden="true"
          class="absolute top-0 z-[2] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          :class="[connectorPlacement, connectorClass]"
          data-testid="edition-connector"
        >
          <span
            v-if="linking || rebuilding"
            class="absolute -inset-[3px] animate-spin rounded-full border-2 border-transparent border-t-info"
            data-testid="edition-connector-spinner"
          />
          <Link2 class="size-3" aria-hidden="true" />
        </div>
      </div>
      <EditionSlotCard v-if="edition.kind === 'filled'" :edition="edition" :merged="merged" :position="cardPosition(index)" @change="handleChange" />
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
    <Transition
      enter-active-class="transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      enter-from-class="opacity-0 -translate-y-3 scale-95"
      leave-active-class="transition-all duration-300 ease-in"
      leave-to-class="opacity-0 -translate-y-3 scale-95"
    >
      <div v-if="readAlong" data-testid="edition-read-along">
        <div class="relative h-0">
          <div
            class="pointer-events-none absolute -top-8 left-5 h-16 w-0.5 -translate-x-1/2 rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
            :class="readAlongRailClass"
            aria-hidden="true"
          />
          <div
            class="pointer-events-none absolute top-0 right-0 left-9.5 h-px bg-border/60 transition-opacity duration-700"
            :class="merged ? 'opacity-100' : 'opacity-0'"
            aria-hidden="true"
          />
          <div
            aria-hidden="true"
            class="absolute top-0 z-[2] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
            :class="[connectorPlacement, readAlongConnectorClass]"
            data-testid="edition-connector-read-along"
          >
            <Link2 class="size-3" aria-hidden="true" />
          </div>
        </div>
        <EditionSlotCard
          :edition="readAlong"
          :merged="merged"
          position="bottom"
          :rebuild-label="readAlongRebuildLabel"
          :rebuild-disabled="readAlongRebuildDisabled"
          @rebuild="handleRebuildReadAlong"
        />
      </div>
    </Transition>
  </div>
</template>
