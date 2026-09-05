<script setup lang="ts" generic="T extends { id: string }">
import { computed, nextTick, ref, watch } from 'vue'
import { useElementSize, useWindowSize, watchDebounced } from '@vueuse/core'
import { RecycleScroller } from 'vue-virtual-scroller'

const props = withDefaults(
  defineProps<{
    items: T[]
    cardSize: number
    gridGap: number
    aspectRatio?: number
    extraHeight?: number
    /** Grouped views render many bounded sections; a scroller per section costs more than it saves. */
    virtualized?: boolean
  }>(),
  { aspectRatio: 1.5, extraHeight: 0, virtualized: true },
)

defineSlots<{ default(props: { item: T }): unknown }>()

const containerRef = ref<HTMLElement | null>(null)
const scrollerRef = ref<{ scrollToItem: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void } | null>(null)
const firstVisibleIndex = ref(0)
const { width: containerWidth } = useElementSize(containerRef)
const { width: windowWidth } = useWindowSize()
const settledWidth = ref(0)

watch(
  containerWidth,
  (width) => {
    const rounded = Math.round(Number(width))
    if (rounded > 0 && settledWidth.value === 0) settledWidth.value = rounded
  },
  { immediate: true },
)
watchDebounced(
  containerWidth,
  (width) => {
    const rounded = Math.round(Number(width))
    if (rounded > 0) settledWidth.value = rounded
  },
  { debounce: 120 },
)

const coverSize = computed(() => Math.max(1, Math.round(props.cardSize)))
const gap = computed(() => Math.max(1, Math.round(props.gridGap)))
const availableWidth = computed(() => {
  if (settledWidth.value > 0) return settledWidth.value
  const direct = Number(containerRef.value?.getBoundingClientRect().width ?? 0)
  if (direct > 0) return Math.round(direct)
  return Math.max(coverSize.value, Math.round(Number(windowWidth.value) - 48))
})
const gridItems = computed(() => Math.max(1, Math.floor((availableWidth.value + gap.value) / (coverSize.value + gap.value))))
const itemSecondarySize = computed(() => Math.max(1, Math.floor((availableWidth.value + gap.value) / gridItems.value)))
const cardWidth = computed(() => Math.max(1, itemSecondarySize.value - gap.value))
const cardHeight = computed(() => Math.max(1, Math.round(cardWidth.value * props.aspectRatio)))
const itemSize = computed(() => cardHeight.value + Math.max(0, props.extraHeight) + gap.value)
const buffer = computed(() => Math.max(itemSize.value * 2, 240))
const scrollerStyle = computed(() => ({
  '--monitored-card-height': `${cardHeight.value + Math.max(0, props.extraHeight)}px`,
  '--monitored-grid-gap': `${gap.value}px`,
}))
const plainGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${coverSize.value}px), 1fr))`,
  gap: `${gap.value}px`,
}))

function handleScrollerUpdate(startIndex: number) {
  firstVisibleIndex.value = startIndex
}

// Re-anchor on column-count changes so a relayout keeps the same cards in view. firstVisibleIndex
// still holds the pre-relayout value here because it only updates from the scroller's own events.
watch(gridItems, (next, prev) => {
  if (!props.virtualized || !prev || next === prev) return
  const anchor = firstVisibleIndex.value
  if (anchor <= 0) return
  void nextTick(() => {
    scrollerRef.value?.scrollToItem(anchor)
  })
})
</script>

<template>
  <div ref="containerRef" class="w-full">
    <RecycleScroller
      v-if="virtualized"
      ref="scrollerRef"
      :items="items"
      key-field="id"
      page-mode
      :item-size="itemSize"
      :grid-items="gridItems"
      :item-secondary-size="itemSecondarySize"
      :buffer="buffer"
      :style="scrollerStyle"
      class="monitored-grid-scroller"
      @update="handleScrollerUpdate"
    >
      <template #default="{ item }">
        <div class="monitored-grid-cell">
          <slot :item="item" />
        </div>
      </template>
    </RecycleScroller>
    <div v-else class="grid" :style="plainGridStyle">
      <div v-for="item in items" :key="item.id">
        <slot :item="item" />
      </div>
    </div>
  </div>
</template>

<style>
@import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';
</style>

<style scoped>
.monitored-grid-scroller {
  width: 100%;
  max-width: 100%;
  overflow-x: clip;
  overscroll-behavior-x: none;
}

@media (pointer: coarse) {
  .monitored-grid-scroller {
    touch-action: pan-y;
  }
}

.monitored-grid-cell {
  display: grid;
  align-items: start;
  height: calc(var(--monitored-card-height) + var(--monitored-grid-gap));
  box-sizing: border-box;
  padding-right: var(--monitored-grid-gap);
  padding-bottom: var(--monitored-grid-gap);
}
</style>
