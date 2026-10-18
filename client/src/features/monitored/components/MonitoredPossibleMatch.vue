<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleHelp } from '@lucide/vue'
import type { MonitoredFormat, MonitoredPossibleMatch, MonitoredWork } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MonitoredMatchAnswer } from '../composables/useWorkMatch'

/**
 * A library book with this work's title whose other evidence disagrees, usually its number in the
 * series. It is neither owned nor missing until the owner says which, and saying so is one click.
 */
const props = defineProps<{
  work: MonitoredWork
  format: MonitoredFormat
  possible: MonitoredPossibleMatch
  /** May give the answer; anyone else only sees the question. */
  canAnswer: boolean
  saving: boolean
}>()
const emit = defineEmits<{ answer: [format: MonitoredFormat, answer: MonitoredMatchAnswer] }>()

const { t } = useI18n()
const tooltipId = computed(() => `${props.work.id}-${props.format}-possible-match`)

function seriesLabel(name: string | null, index: string | null): string | null {
  if (!name) return null
  return index ? `${name} #${index}` : name
}

const libraryLabel = computed(() => {
  const series = seriesLabel(props.possible.seriesName, props.possible.seriesIndex)
  const title = props.possible.title ?? t('monitored.slot.match.untitled')
  return series ? `${title} (${series})` : title
})

const reason = computed(() => {
  const library = seriesLabel(props.possible.seriesName, props.possible.seriesIndex)
  const catalog = seriesLabel(props.work.seriesName, props.work.seriesIndex)
  if (library && catalog) return t('monitored.slot.match.reasonSeries', { library, catalog })
  return t('monitored.slot.match.reasonOther')
})

function handleSame() {
  emit('answer', props.format, { decision: 'link', bookId: props.possible.bookId })
}

function handleDifferent() {
  emit('answer', props.format, { decision: 'reject', bookId: props.possible.bookId })
}
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-1.5 rounded-md border border-dashed border-[var(--pill-warning)]/50 bg-[var(--pill-warning)]/5 px-2.5 py-1.5"
    role="group"
    :aria-label="t('monitored.slot.match.title')"
    data-testid="possible-match"
  >
    <div class="flex min-w-0 items-start gap-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger as-child>
            <span tabindex="0" class="mt-px inline-flex shrink-0 rounded-sm text-[var(--pill-warning)]" :aria-describedby="tooltipId">
              <CircleHelp :size="14" aria-hidden="true" />
              <span class="sr-only">{{ t('monitored.slot.match.title') }}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent class="max-w-64">{{ reason }}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span :id="tooltipId" class="sr-only">{{ reason }}</span>
      <p class="min-w-0 text-xs text-foreground">
        <span class="font-medium">{{ t('monitored.slot.match.title') }}</span>
        &middot;
        <span class="break-words" data-testid="possible-match-book">{{ libraryLabel }}</span>
      </p>
    </div>
    <div v-if="canAnswer" class="flex min-w-0 flex-wrap items-center gap-1.5">
      <Button size="sm" class="h-6 px-2 text-[11px]" :disabled="saving" data-testid="possible-match-same" @click="handleSame">
        {{ t('monitored.slot.match.same') }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="h-6 px-2 text-[11px]"
        :disabled="saving"
        data-testid="possible-match-different"
        @click="handleDifferent"
      >
        {{ t('monitored.slot.match.different') }}
      </Button>
      <!-- Room for picking another library book when this one is not it. -->
      <slot />
    </div>
  </div>
</template>
