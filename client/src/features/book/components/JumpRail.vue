<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { TransitionPresets, useElementBounding, useMediaQuery, useTransition } from '@vueuse/core'
import type { JumpBucket, JumpBucketKind, TemporalJumpBucketGranularity } from '@bookorbit/types'
import { useI18n } from 'vue-i18n'
import { formatDate, formatNumber } from '@/i18n/formatters'

const { t, locale } = useI18n()

const SLOT_PX = 20
const RAIL_PAD_PX = 8
const SCROLL_PULSE_MS = 900
const MAX_TEMPORAL_SLOTS = 64

type RailSlot = {
  key: string
  label: string
  displayLabel: string
  accessibleLabel: string
  bucket: JumpBucket | null
}

const props = defineProps<{
  visible: boolean
  buckets: JumpBucket[]
  kind: JumpBucketKind
  granularity?: TemporalJumpBucketGranularity | null
  activeKey: string | null
  template?: string[]
  maxSlots?: number
  viewport?: HTMLElement | null
}>()

const emit = defineEmits<{
  jump: [bucket: JumpBucket]
  'after-leave': []
}>()

const railEl = ref<HTMLElement | null>(null)
const viewportTarget = computed(() => props.viewport ?? null)
const { top: viewportTop, height: viewportHeight } = useElementBounding(viewportTarget)
const railPositionStyle = computed(() => {
  if (viewportHeight.value <= 0) return undefined
  return {
    top: `${viewportTop.value + viewportHeight.value / 2}px`,
    maxHeight: `${viewportHeight.value * 0.85}px`,
  }
})

function temporalLabels(bucket: JumpBucket): Pick<RailSlot, 'label' | 'displayLabel' | 'accessibleLabel'> {
  if (bucket.isUnknown) {
    return { label: t('book.jumpRail.unknownDate'), displayLabel: '?', accessibleLabel: t('book.jumpRail.unknownDate') }
  }

  const granularity = props.granularity
  if (!granularity) return { label: bucket.label, displayLabel: bucket.label, accessibleLabel: bucket.label }
  if (granularity.unit === 'year') {
    const start = Number(bucket.key)
    if (!Number.isFinite(start)) return { label: bucket.label, displayLabel: bucket.label, accessibleLabel: bucket.label }
    const startLabel = formatNumber(start, { useGrouping: false })
    if (granularity.step === 1) return { label: startLabel, displayLabel: startLabel, accessibleLabel: startLabel }
    const endLabel = formatNumber(start + granularity.step - 1, { useGrouping: false })
    const range = `${startLabel}-${endLabel}`
    return { label: range, displayLabel: startLabel, accessibleLabel: range }
  }

  const dateKey = granularity.unit === 'month' ? `${bucket.key}-01` : bucket.key
  const date = new Date(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return { label: bucket.label, displayLabel: bucket.label, accessibleLabel: bucket.label }
  if (granularity.unit === 'month') {
    const fullLabel = formatDate(date, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    return {
      label: fullLabel,
      displayLabel: bucket.key.endsWith('-01') ? formatDate(date, { year: 'numeric', timeZone: 'UTC' }) : '',
      accessibleLabel: fullLabel,
    }
  }
  const fullLabel = formatDate(date, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return {
    label: fullLabel,
    displayLabel: bucket.key.endsWith('-01-01')
      ? formatDate(date, { year: 'numeric', timeZone: 'UTC' })
      : bucket.key.endsWith('-01')
        ? formatDate(date, { month: 'short', timeZone: 'UTC' })
        : '',
    accessibleLabel: fullLabel,
  }
}

function shiftDateKey(key: string, unit: 'day' | 'month', amount: number): string | null {
  const date = new Date(`${unit === 'month' ? `${key}-01` : key}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount)
  else date.setUTCDate(date.getUTCDate() + amount)
  const shifted = date.toISOString().slice(0, 10)
  return unit === 'month' ? shifted.slice(0, 7) : shifted
}

function temporalDistance(start: string, end: string, granularity: TemporalJumpBucketGranularity): number | null {
  if (granularity.unit === 'year') {
    const startYear = Number(start)
    const endYear = Number(end)
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return null
    return Math.abs((endYear - startYear) / granularity.step)
  }

  const startDate = new Date(`${granularity.unit === 'month' ? `${start}-01` : start}T00:00:00Z`)
  const endDate = new Date(`${granularity.unit === 'month' ? `${end}-01` : end}T00:00:00Z`)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null
  if (granularity.unit === 'month') {
    return Math.abs((endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth())
  }
  return Math.abs((endDate.getTime() - startDate.getTime()) / 86_400_000)
}

function shiftTemporalKey(key: string, granularity: TemporalJumpBucketGranularity, amount: number): string | null {
  if (granularity.unit === 'year') {
    const year = Number(key)
    return Number.isFinite(year) ? String(year + amount * granularity.step) : null
  }
  return shiftDateKey(key, granularity.unit, amount)
}

function temporalTimelineKeys(buckets: JumpBucket[], granularity: TemporalJumpBucketGranularity | null | undefined, maxSlots: number): string[] {
  const known = buckets.filter((bucket) => !bucket.isUnknown)
  if (!granularity || known.length < 2) return known.map((bucket) => bucket.key)

  const capacity = Math.max(known.length, Math.min(MAX_TEMPORAL_SLOTS, Math.max(2, maxSlots)))
  const gaps = known.slice(0, -1).map((bucket, index) => {
    const next = known[index + 1]!
    const distance = temporalDistance(bucket.key, next.key, granularity)
    return { start: bucket.key, end: next.key, distance: distance ?? 1, markers: 0 }
  })
  let remaining = capacity - known.length
  while (remaining > 0) {
    let selected: (typeof gaps)[number] | null = null
    let selectedScore = 0
    for (const gap of gaps) {
      const missing = Math.max(0, Math.floor(gap.distance) - 1)
      if (gap.markers >= missing) continue
      const score = missing / (gap.markers + 1)
      if (score > selectedScore) {
        selected = gap
        selectedScore = score
      }
    }
    if (!selected) break
    selected.markers += 1
    remaining -= 1
  }

  const keys: string[] = []
  for (let index = 0; index < known.length; index++) {
    keys.push(known[index]!.key)
    const gap = gaps[index]
    if (!gap || gap.markers === 0) continue
    const startValue = granularity.unit === 'year' ? Number(gap.start) : gap.start
    const endValue = granularity.unit === 'year' ? Number(gap.end) : gap.end
    const direction = startValue <= endValue ? 1 : -1
    for (let marker = 1; marker <= gap.markers; marker++) {
      const offset = Math.round((gap.distance * marker) / (gap.markers + 1)) * direction
      const key = shiftTemporalKey(gap.start, granularity, offset)
      if (key && key !== gap.start && key !== gap.end) keys.push(key)
    }
  }
  return keys
}

const slots = computed<RailSlot[]>(() => {
  void locale.value
  if (props.kind === 'letter' && props.template) {
    const byKey = new Map(props.buckets.map((bucket) => [bucket.key, bucket]))
    return props.template.map((key) => ({ key, label: key, displayLabel: key, accessibleLabel: key, bucket: byKey.get(key) ?? null }))
  }

  const byKey = new Map(props.buckets.map((bucket) => [bucket.key, bucket]))
  const unknown = props.buckets.find((bucket) => bucket.isUnknown)
  const maxKnownSlots = Math.max(2, (props.maxSlots ?? MAX_TEMPORAL_SLOTS) - (unknown ? 1 : 0))
  const timelineKeys = temporalTimelineKeys(props.buckets, props.granularity, maxKnownSlots)
  if (unknown) timelineKeys.push(unknown.key)
  const temporalSlots: RailSlot[] = timelineKeys.map((key) => {
    const bucket = byKey.get(key) ?? null
    const labels = temporalLabels(bucket ?? { key, label: key, index: -1 })
    return { key, ...labels, displayLabel: bucket ? labels.displayLabel : '', bucket }
  })
  const displayedYears = new Set(temporalSlots.filter((slot) => slot.displayLabel).map((slot) => slot.key.slice(0, 4)))
  for (const index of [0, temporalSlots.length - 1]) {
    const slot = temporalSlots[index]
    if (!slot || slot.displayLabel || slot.bucket?.isUnknown) continue
    const yearKey = slot.key.slice(0, 4)
    if (displayedYears.has(yearKey)) continue
    const year = Number(slot.key.slice(0, 4))
    slot.displayLabel = Number.isFinite(year) ? formatNumber(year, { useGrouping: false }) : slot.label
    displayedYears.add(yearKey)
  }
  return temporalSlots
})

const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

const scrubbing = ref(false)
const hovering = ref(false)
const scrollPulse = ref(false)
let scrollPulseTimer: ReturnType<typeof setTimeout> | null = null

const engaged = computed(() => hovering.value || scrubbing.value || scrollPulse.value)

// The target index never resets to 0 so the hover or scrub indicator moves
// between slots instead of sliding up from the top each time it reappears.
const hoveredIndex = ref<number | null>(null)
const hoverTargetIndex = ref(0)
watch(hoveredIndex, (value) => {
  if (value !== null) hoverTargetIndex.value = value
})
const hoverVisible = computed(() => hoveredIndex.value !== null)
const previewSlot = computed(() => (hoveredIndex.value === null ? null : (slots.value[hoveredIndex.value] ?? null)))
const hoverThumbIndex = useTransition(hoverTargetIndex, {
  duration: 220,
  transition: TransitionPresets.easeOutBack,
  disabled: reducedMotion,
})
const hoverThumbY = computed(() => RAIL_PAD_PX + hoverThumbIndex.value * SLOT_PX)

watch(
  () => props.activeKey,
  () => {
    scrollPulse.value = true
    if (scrollPulseTimer) clearTimeout(scrollPulseTimer)
    scrollPulseTimer = setTimeout(() => {
      scrollPulse.value = false
      scrollPulseTimer = null
    }, SCROLL_PULSE_MS)
  },
)

let lastScrubKey: string | null = null

onBeforeUnmount(() => {
  if (scrollPulseTimer) clearTimeout(scrollPulseTimer)
})

function slotAtClientY(clientY: number): RailSlot | null {
  const el = railEl.value
  const list = slots.value
  if (!el || list.length === 0) return null
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0) return null
  const ratio = Math.min(0.999, Math.max(0, (clientY - rect.top) / rect.height))
  return list[Math.floor(ratio * list.length)] ?? null
}

function nearestAvailable(slot: RailSlot | null): RailSlot | null {
  if (!slot) return null
  if (slot.bucket) return slot
  const list = slots.value
  const start = list.indexOf(slot)
  for (let distance = 1; distance < list.length; distance++) {
    const before = list[start - distance]
    if (before?.bucket) return before
    const after = list[start + distance]
    if (after?.bucket) return after
  }
  return null
}

function pulseHaptics(pointerType: string) {
  if (pointerType === 'mouse') return
  navigator.vibrate?.(5)
}

function scrubTo(clientY: number, pointerType: string) {
  const slot = nearestAvailable(slotAtClientY(clientY))
  if (!slot?.bucket) return
  hoveredIndex.value = slots.value.indexOf(slot)
  if (slot.key === lastScrubKey) return
  lastScrubKey = slot.key
  pulseHaptics(pointerType)
  emit('jump', slot.bucket)
}

function handlePointerDown(event: PointerEvent) {
  railEl.value?.setPointerCapture(event.pointerId)
  scrubbing.value = true
  scrubTo(event.clientY, event.pointerType)
}

function handlePointerMove(event: PointerEvent) {
  if (event.pointerType === 'mouse') {
    const slot = slotAtClientY(event.clientY)
    hoveredIndex.value = slot?.bucket ? slots.value.indexOf(slot) : null
  }
  if (scrubbing.value) scrubTo(event.clientY, event.pointerType)
}

function handlePointerEnter(event: PointerEvent) {
  if (event.pointerType === 'mouse') hovering.value = true
}

function handlePointerEnd(event: PointerEvent) {
  scrubbing.value = false
  if (event.pointerType !== 'mouse') hoveredIndex.value = null
}

function handlePointerLeave() {
  hovering.value = false
  hoveredIndex.value = null
}

function handleSlotClick(slot: RailSlot) {
  if (!slot.bucket) return
  // A tap already jumped via pointerdown scrubbing; skip the duplicate click.
  if (slot.key === lastScrubKey) {
    lastScrubKey = null
    return
  }
  lastScrubKey = null
  emit('jump', slot.bucket)
}

function handleAfterLeave() {
  emit('after-leave')
}
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-200 ease-out"
    leave-active-class="transition-all duration-150 ease-in"
    enter-from-class="opacity-0 translate-x-2"
    leave-to-class="opacity-0 translate-x-2"
    @after-leave="handleAfterLeave"
  >
    <nav
      v-if="visible"
      ref="railEl"
      class="jump-rail fixed right-1.5 top-1/2 z-30 flex max-h-[85vh] -translate-y-1/2 select-none flex-col items-stretch overflow-visible rounded-2xl border border-primary/20 bg-background/80 py-2 shadow-sm backdrop-blur"
      :class="[
        kind === 'temporal' ? 'w-14 px-1' : engaged ? 'w-9 px-1.5' : 'w-8 px-1',
        reducedMotion ? '' : 'transition-[width,padding] duration-300 ease-out',
      ]"
      :style="railPositionStyle"
      :aria-label="t('book.jumpRail.jumpToSection')"
      data-testid="jump-rail"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerenter="handlePointerEnter"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @pointerleave="handlePointerLeave"
    >
      <div
        v-show="hoverVisible"
        class="jump-rail-thumb pointer-events-none absolute inset-x-1 top-0 z-0 h-5 rounded-full bg-foreground/10 transition-opacity duration-150"
        :style="{ transform: `translateY(${hoverThumbY}px)` }"
        aria-hidden="true"
      />

      <div
        v-if="kind === 'temporal' && previewSlot"
        class="pointer-events-none absolute right-full top-0 z-20 mr-2 flex h-7 -translate-y-1 items-center whitespace-nowrap rounded-md border border-border bg-popover px-2.5 text-xs font-medium tabular-nums text-popover-foreground shadow-md"
        :style="{ transform: `translateY(${hoverThumbY - 4}px)` }"
        aria-hidden="true"
        data-testid="jump-rail-preview"
      >
        {{ previewSlot.label }}
      </div>

      <button
        v-for="(slot, index) in slots"
        :key="slot.key"
        type="button"
        class="jump-rail-slot relative z-10 h-5 shrink-0 items-center px-0.5 text-center text-[11px] font-medium tabular-nums transition-colors duration-150"
        :class="[
          'flex justify-center rounded-full',
          slot.bucket ? 'text-muted-foreground hover:text-foreground' : 'cursor-default text-muted-foreground/30',
          index === hoveredIndex && kind === 'letter' ? 'scale-[1.35] font-semibold text-foreground' : '',
        ]"
        :disabled="!slot.bucket"
        :aria-label="t('book.jumpRail.jumpTo', { label: slot.accessibleLabel })"
        :aria-current="slot.key === activeKey ? 'true' : undefined"
        :data-key="slot.key"
        @click="handleSlotClick(slot)"
      >
        <span
          v-if="slot.displayLabel"
          class="rounded-full px-1.5 leading-4"
          :class="slot.key === activeKey ? 'bg-primary font-semibold text-primary-foreground shadow-sm' : ''"
        >
          {{ slot.displayLabel }}
        </span>
        <span
          v-else
          class="rounded-full"
          :class="slot.key === activeKey ? 'size-1.5 bg-primary opacity-100' : 'size-1 bg-current opacity-60'"
          aria-hidden="true"
        />
      </button>
    </nav>
  </Transition>
</template>

<style scoped>
.jump-rail {
  touch-action: none;
  contain: layout style;
}

.jump-rail-slot {
  -webkit-tap-highlight-color: transparent;
}
</style>
