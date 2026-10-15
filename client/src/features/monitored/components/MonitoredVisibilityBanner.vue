<script setup lang="ts">
import { computed } from 'vue'
import { CirclePause, EyeOff, ShieldQuestion, UserCheck } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MonitoredWork } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatList } from '@/i18n/formatters'
import { monitoredVisibilityState } from '../lib/visibility-state'

/** Shown only while a work is out of its normal state, with the way back beside the reason. */
const props = defineProps<{
  work: MonitoredWork
  authorName: string
  authorPaused?: boolean
  /** The monitored author page, when the panel knows which author this is. */
  authorRoute?: { name: string; params: Record<string, string> } | null
  canManage: boolean
  /** Whether the page behind the panel can resume the author in place. */
  canResumeAuthor?: boolean
}>()
const emit = defineEmits<{
  keep: []
  hide: []
  unhide: []
  automatic: []
  'resume-author': []
}>()

const { t } = useI18n()

const state = computed(() => monitoredVisibilityState(props.work, props.authorPaused))

const reasons = computed(() => {
  const parts: string[] = []
  if (props.work.verdict !== 'verified') parts.push(t(`monitored.panel.banner.verdict.${props.work.verdict}`))
  for (const flag of props.work.flags) parts.push(t(`monitored.panel.flags.${flag}`).toLowerCase())
  if (!parts.length) parts.push(t('monitored.panel.banner.reviewUnverified'))
  return formatList(parts)
})

const message = computed(() => {
  switch (state.value) {
    case 'author-paused':
      return t('monitored.panel.banner.authorPaused', { author: props.authorName })
    case 'work-paused':
      return t('monitored.panel.banner.workPaused')
    case 'work-stopped':
      return t('monitored.panel.banner.workStopped')
    case 'hidden':
      return t('monitored.panel.banner.hidden')
    case 'kept':
      return t('monitored.panel.banner.kept')
    case 'review':
      return t('monitored.panel.banner.review', { reasons: reasons.value })
    default:
      return ''
  }
})

const icon = computed(() => {
  if (state.value === 'hidden') return EyeOff
  if (state.value === 'kept') return UserCheck
  if (state.value === 'review') return ShieldQuestion
  return CirclePause
})

const pausedState = computed(() => state.value === 'author-paused' || state.value === 'work-paused' || state.value === 'work-stopped')
const showResume = computed(() => state.value === 'author-paused' && props.canManage && props.canResumeAuthor)
const showOpenAuthor = computed(() => pausedState.value && !showResume.value && props.authorRoute != null)

function handleKeep() {
  emit('keep')
}

function handleHide() {
  emit('hide')
}

function handleUnhide() {
  emit('unhide')
}

function handleAutomatic() {
  emit('automatic')
}

function handleResume() {
  emit('resume-author')
}
</script>

<template>
  <div
    v-if="state"
    role="status"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[var(--pill-warning)]/40 bg-[var(--pill-warning)]/10 px-3.5 py-2.5"
    :data-state="state"
  >
    <component :is="icon" :size="14" class="shrink-0 text-[var(--pill-warning)]" aria-hidden="true" />
    <p class="min-w-0 flex-1 basis-48 text-xs text-foreground">{{ message }}</p>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <template v-if="state === 'review' && canManage">
        <Button size="sm" variant="outline" class="h-7 text-xs" @click="handleHide">{{ t('monitored.panel.hide') }}</Button>
        <Button size="sm" class="h-7 text-xs" @click="handleKeep">{{ t('monitored.panel.banner.keep') }}</Button>
      </template>
      <Button v-else-if="state === 'hidden' && canManage" size="sm" class="h-7 text-xs" @click="handleUnhide">{{
        t('monitored.panel.unhide')
      }}</Button>
      <Button v-else-if="state === 'kept' && canManage" size="sm" variant="outline" class="h-7 text-xs" @click="handleAutomatic">
        {{ t('monitored.panel.backToAutomatic') }}
      </Button>
      <Button v-else-if="showResume" size="sm" class="h-7 text-xs" @click="handleResume">{{ t('monitored.panel.banner.resumeAuthor') }}</Button>
      <Button v-else-if="showOpenAuthor" as-child size="sm" variant="outline" class="h-7 text-xs">
        <RouterLink :to="authorRoute!">{{ t('monitored.panel.banner.openAuthor') }}</RouterLink>
      </Button>
    </div>
  </div>
</template>
