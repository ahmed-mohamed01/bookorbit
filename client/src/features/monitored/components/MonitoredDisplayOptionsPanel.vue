<script setup lang="ts">
import { computed } from 'vue'
import { Check, ChevronDown, ChevronRight, RotateCcw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import {
  isDefaultDisplay,
  isEveryReviewKindSelected,
  isReviewKindSelected,
  MONITORED_REVIEW_KINDS,
  toggleReviewKind,
  type MonitoredDisplayClassCounts,
  type MonitoredDisplayOptions,
  type MonitoredReviewKind,
  type MonitoredReviewKindCounts,
} from '../lib/work-visibility'

const props = defineProps<{
  modelValue: MonitoredDisplayOptions
  counts: MonitoredDisplayClassCounts
  reviewKindCounts: MonitoredReviewKindCounts
  /** Curation is the owner's own view of their catalog; a shared viewer is never sent those works. */
  canCurate: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: MonitoredDisplayOptions]; reset: [] }>()

const { t } = useI18n()

type ToggleKey = 'released' | 'upcoming' | 'hidden' | 'placeholders'

const releaseToggles: { key: ToggleKey; label: string }[] = [
  { key: 'released', label: 'monitored.display.released' },
  { key: 'upcoming', label: 'monitored.display.upcoming' },
]

const extraToggles = computed(() => [
  { key: 'hidden' as ToggleKey, label: 'monitored.display.hidden', count: props.counts.hidden },
  { key: 'placeholders' as ToggleKey, label: 'monitored.display.placeholders', count: props.counts.placeholder },
])

const presentKinds = computed<MonitoredReviewKind[]>(() => MONITORED_REVIEW_KINDS.filter((kind) => props.reviewKindCounts[kind] > 0))

const reviewKinds = computed(() =>
  presentKinds.value.map((kind) => ({
    value: kind,
    label: t(`monitored.review.kinds.${kind}`),
    count: props.reviewKindCounts[kind],
    selected: isReviewKindSelected(props.modelValue.reviewKinds, kind),
  })),
)

const allKindsSelected = computed(() => isEveryReviewKindSelected(props.modelValue.reviewKinds, presentKinds.value))

const isDefault = computed(() => isDefaultDisplay(props.modelValue))

function toggle(key: ToggleKey) {
  emit('update:modelValue', { ...props.modelValue, [key]: !props.modelValue[key] })
}

function toggleReview() {
  // Collapsing drops the selection too: one left behind would silently narrow the next expansion.
  emit('update:modelValue', { ...props.modelValue, review: !props.modelValue.review, reviewKinds: 'all' })
}

function resetDisplay() {
  emit('reset')
}

function selectAllKinds() {
  emit('update:modelValue', { ...props.modelValue, review: true, reviewKinds: 'all' })
}

function toggleKind(kind: MonitoredReviewKind) {
  const reviewKinds = toggleReviewKind(props.modelValue.reviewKinds, kind, presentKinds.value)
  // Unticking the last kind asks for no review work at all, which is what the switch itself says.
  // Keeping it on with an empty selection is a state nothing could round-trip through storage.
  if (reviewKinds !== 'all' && reviewKinds.length === 0) {
    emit('update:modelValue', { ...props.modelValue, review: false, reviewKinds: 'all' })
    return
  }
  emit('update:modelValue', { ...props.modelValue, review: true, reviewKinds })
}
</script>

<template>
  <div>
    <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">{{ t('monitored.display.title') }}</div>

    <div class="flex flex-col gap-0.5">
      <button
        v-for="option in releaseToggles"
        :key="option.key"
        type="button"
        role="checkbox"
        :aria-checked="modelValue[option.key]"
        class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="modelValue[option.key] ? 'font-medium text-foreground' : 'text-muted-foreground'"
        @click="toggle(option.key)"
      >
        <Check :size="14" :class="modelValue[option.key] ? 'text-primary' : 'invisible'" aria-hidden="true" />
        <span class="flex-1 text-left">{{ t(option.label) }}</span>
      </button>
    </div>

    <div v-if="canCurate" class="my-2 border-t border-border" />

    <div v-if="canCurate" class="flex flex-col gap-0.5">
      <button
        v-for="option in extraToggles"
        :key="option.key"
        type="button"
        role="checkbox"
        :aria-checked="modelValue[option.key]"
        class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="modelValue[option.key] ? 'font-medium text-foreground' : 'text-muted-foreground'"
        @click="toggle(option.key)"
      >
        <Check :size="14" :class="modelValue[option.key] ? 'text-primary' : 'invisible'" aria-hidden="true" />
        <span class="flex-1 text-left">{{ t(option.label) }}</span>
        <span class="text-xs tabular-nums text-muted-foreground">{{ option.count }}</span>
      </button>

      <button
        type="button"
        role="checkbox"
        :aria-checked="modelValue.review"
        class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        :class="modelValue.review ? 'font-medium text-foreground' : 'text-muted-foreground'"
        @click="toggleReview"
      >
        <Check :size="14" :class="modelValue.review ? 'text-primary' : 'invisible'" aria-hidden="true" />
        <span class="flex-1 text-left">{{ t('monitored.display.review') }}</span>
        <span class="text-xs tabular-nums text-muted-foreground">{{ counts.review }}</span>
        <ChevronDown v-if="modelValue.review" :size="13" aria-hidden="true" />
        <ChevronRight v-else :size="13" aria-hidden="true" />
      </button>

      <div
        v-if="modelValue.review"
        class="ml-3 flex flex-col gap-0.5 border-l border-border pl-2"
        role="group"
        :aria-label="t('monitored.review.filter')"
      >
        <button
          type="button"
          role="checkbox"
          :aria-checked="allKindsSelected"
          class="flex items-center gap-2 rounded-sm px-2 py-1 text-sm transition-colors hover:bg-muted"
          :class="allKindsSelected ? 'font-medium text-foreground' : 'text-muted-foreground'"
          @click="selectAllKinds"
        >
          <Check :size="13" :class="allKindsSelected ? 'text-primary' : 'invisible'" aria-hidden="true" />
          <span class="flex-1 text-left">{{ t('monitored.review.kinds.all') }}</span>
          <span class="text-xs tabular-nums text-muted-foreground">{{ reviewKindCounts.all }}</span>
        </button>
        <button
          v-for="kind in reviewKinds"
          :key="kind.value"
          type="button"
          role="checkbox"
          :aria-checked="kind.selected"
          class="flex items-center gap-2 rounded-sm px-2 py-1 text-sm transition-colors hover:bg-muted"
          :class="kind.selected ? 'font-medium text-foreground' : 'text-muted-foreground'"
          @click="toggleKind(kind.value)"
        >
          <Check :size="13" :class="kind.selected ? 'text-primary' : 'invisible'" aria-hidden="true" />
          <span class="flex-1 text-left">{{ kind.label }}</span>
          <span class="text-xs tabular-nums text-muted-foreground">{{ kind.count }}</span>
        </button>
      </div>
    </div>

    <template v-if="!isDefault">
      <div class="my-2 border-t border-border" />
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        @click="resetDisplay"
      >
        <RotateCcw :size="13" aria-hidden="true" />
        <span class="flex-1 text-left">{{ t('monitored.display.reset') }}</span>
      </button>
    </template>
  </div>
</template>
