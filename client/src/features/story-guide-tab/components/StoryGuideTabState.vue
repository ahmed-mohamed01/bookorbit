<script setup lang="ts">
import { computed, useId } from 'vue'
import { AlertTriangle, Check, Circle, Loader2, Orbit, Sparkles } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import {
  storyGuideActionLabel,
  storyGuideEstimateLine,
  storyGuideNoticeSentence,
  storyGuidePhaseText,
  storyGuideProgressTitle,
} from '@/features/story-guide/lib/story-guide-copy'
import type { StoryGuideAction, StoryGuidePresentation } from '@/features/story-guide/lib/story-guide-presentation'
import { formatPercent } from '@/i18n/formatters'
import { storyGuideJobActions } from '../lib/story-guide-tab-state'
import { storyGuideTabSteps } from '../lib/story-guide-tab-steps'

const props = defineProps<{
  presentation: StoryGuidePresentation
  pending: StoryGuideAction | null
  mayBuild: boolean
  hasGuide: boolean
}>()
const emit = defineEmits<{ request: [action: StoryGuideAction] }>()
const { t } = useI18n()
const headingId = useId()

const row = computed(() => props.presentation.rows[0])
const progress = computed(() => (row.value?.kind === 'progress' ? row.value : null))
const waiting = computed(() => (row.value?.kind === 'waiting' ? row.value : null))
const notice = computed(() => (row.value?.kind === 'notice' ? row.value : null))
const buildCard = computed(() => (row.value?.kind === 'buildCard' ? row.value : null))
const checking = computed(() => row.value?.kind === 'checking')
const running = computed(() => !!(progress.value || waiting.value))
const busy = computed(() => props.pending !== null)
const actions = computed(() => storyGuideJobActions(props.presentation))
const estimate = computed(() => (buildCard.value ? storyGuideEstimateLine(buildCard.value.estimate) : null))
const jobTitle = computed(() => {
  const title = progress.value?.title ?? waiting.value?.title ?? notice.value?.title
  return title ? storyGuideProgressTitle(title) : ''
})
const steps = computed(() => (progress.value ? storyGuideTabSteps(progress.value.phase, progress.value.fraction) : []))
const detail = computed(() => {
  if (progress.value?.phase.kind === 'building') {
    return storyGuidePhaseText(steps.value.find((step) => step.state === 'now')?.phase ?? progress.value.phase)
  }
  if (progress.value) return storyGuidePhaseText(progress.value.phase)
  if (waiting.value) return t('book.detail.storyGuide.waiting')
  return notice.value ? storyGuideNoticeSentence(notice.value.notice) : ''
})
const aside = computed(() => {
  if (progress.value?.minutesLeft != null) return t('book.detail.storyGuide.minutesLeft', { count: progress.value.minutesLeft })
  if (waiting.value?.ahead != null) return t('book.detail.storyGuide.ahead', { count: waiting.value.ahead })
  return ''
})
const fraction = computed(() => progress.value?.fraction ?? null)
const percent = computed(() => Math.round((fraction.value ?? 0) * 100))
const percentLabel = computed(() => formatPercent(fraction.value ?? 0))

function handleBuild() {
  emit('request', 'build')
}

function handleAction(action: StoryGuideAction) {
  emit('request', action)
}
</script>

<template>
  <div
    v-if="hasGuide && (running || notice)"
    class="flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm"
    :class="notice ? 'border-warning/35 bg-warning/10' : 'border-info/35 bg-info/10'"
    role="status"
    data-testid="story-guide-tab-job"
  >
    <AlertTriangle v-if="notice" class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <Loader2 v-else class="size-4 shrink-0 animate-spin text-info motion-reduce:animate-none" aria-hidden="true" />
    <p class="min-w-36 flex-1">
      <strong class="font-semibold">{{ jobTitle }}</strong>{{ ' ' }}<span class="text-muted-foreground">{{ detail }}</span>
      <span v-if="aside" class="ms-2 text-xs tabular-nums text-muted-foreground">{{ aside }}</span>
    </p>
    <button
      v-for="action in actions"
      :key="action"
      type="button"
      :disabled="busy"
      :data-action="action"
      class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
      @click="handleAction(action)"
    >
      <Loader2 v-if="pending === action" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{{
        storyGuideActionLabel(action)
      }}
    </button>
    <div
      v-if="fraction !== null"
      class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
      :aria-valuetext="percentLabel"
      :aria-label="detail"
    >
      <div class="h-full rounded-full bg-info transition-[width] duration-500 motion-reduce:transition-none" :style="{ width: `${percent}%` }" />
    </div>
    <p v-if="notice?.stillTheCase" class="w-full text-xs text-muted-foreground">{{ t('book.detail.storyGuide.stillTheCase') }}</p>
    <RouterLink
      v-if="notice?.settingsHint"
      :to="{ name: 'settings-admin-ai' }"
      class="w-full text-xs underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {{ t('book.detail.storyGuide.settingsHint') }}
    </RouterLink>
  </div>

  <section
    v-else-if="!hasGuide"
    class="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-5 py-12 text-center"
    :aria-labelledby="headingId"
    :role="running ? 'status' : undefined"
    data-testid="story-guide-tab-empty"
  >
    <span class="mb-1.5 flex size-11 items-center justify-center rounded-xl bg-muted" aria-hidden="true">
      <Loader2 v-if="running" class="size-5 animate-spin motion-reduce:animate-none" />
      <Orbit v-else class="size-5" />
    </span>
    <h2 :id="headingId" class="text-base font-semibold">
      {{ running ? t('book.detail.storyGuideTab.state.buildingTitle') : t('book.detail.storyGuideTab.state.emptyTitle') }}
    </h2>
    <p class="max-w-[46ch] text-[13.5px] text-muted-foreground">
      {{ running ? t('book.detail.storyGuideTab.state.buildingBody') : t('book.detail.storyGuideTab.state.emptyBody') }}
    </p>

    <div v-if="running" class="mt-3.5 w-full max-w-90 text-start">
      <div class="flex justify-between gap-3 text-[12.5px]">
        <span>{{ detail }}</span>
        <span v-if="aside" class="shrink-0 tabular-nums text-muted-foreground">{{ aside }}</span>
      </div>
      <div
        v-if="fraction !== null"
        class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent"
        :aria-valuetext="percentLabel"
        :aria-label="detail"
      >
        <div class="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" :style="{ width: `${percent}%` }" />
      </div>
      <ul v-if="steps.length" class="mt-3.5 grid gap-1.5 text-[12.5px]" data-testid="story-guide-tab-steps">
        <li
          v-for="step in steps"
          :key="step.kind"
          class="flex items-center gap-2"
          :class="{ 'text-muted-foreground': step.state === 'pending', 'font-medium': step.state === 'now' }"
          :aria-current="step.state === 'now' ? 'step' : undefined"
          :data-state="step.state"
        >
          <Check v-if="step.state === 'done'" class="size-3.5 shrink-0" aria-hidden="true" />
          <Loader2 v-else-if="step.state === 'now'" class="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <Circle v-else class="size-3.5 shrink-0" aria-hidden="true" />
          {{ storyGuidePhaseText(step.phase) }}
        </li>
      </ul>
    </div>
    <template v-else-if="notice">
      <p class="mt-2 max-w-[46ch] text-[13px] text-foreground" role="status">{{ detail }}</p>
      <p v-if="notice.stillTheCase" class="text-[11.5px] text-muted-foreground">{{ t('book.detail.storyGuide.stillTheCase') }}</p>
      <RouterLink
        v-if="notice.settingsHint"
        :to="{ name: 'settings-admin-ai' }"
        class="text-[11.5px] underline decoration-border underline-offset-2 hover:decoration-foreground"
      >
        {{ t('book.detail.storyGuide.settingsHint') }}
      </RouterLink>
    </template>
    <p v-else-if="checking" class="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
      <Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {{ t('book.detail.storyGuide.checking') }}
    </p>

    <div v-if="buildCard || actions.length" class="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
      <Button v-if="buildCard" :disabled="busy" data-testid="story-guide-tab-build" @click="handleBuild">
        <Loader2 v-if="pending === 'build'" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <Sparkles v-else aria-hidden="true" />
        {{ storyGuideActionLabel('build') }}
      </Button>
      <Button
        v-for="action in actions"
        :key="action"
        size="sm"
        variant="outline"
        :disabled="busy"
        :data-action="action"
        @click="handleAction(action)"
      >
        <Loader2 v-if="pending === action" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {{ storyGuideActionLabel(action) }}
      </Button>
    </div>
    <p v-if="estimate" class="mt-1.5 text-[11.5px] tabular-nums text-muted-foreground" data-testid="story-guide-tab-estimate">{{ estimate }}</p>
    <p v-if="buildCard" class="mt-2.5 max-w-[46ch] text-[11.5px] text-muted-foreground">
      {{ t('book.detail.storyGuideTab.state.privacy') }}
    </p>
    <p v-if="!mayBuild" class="mt-2 max-w-[46ch] text-[13px] text-muted-foreground">
      {{ t('book.detail.storyGuideTab.state.needsPermission') }}
    </p>
  </section>
</template>
