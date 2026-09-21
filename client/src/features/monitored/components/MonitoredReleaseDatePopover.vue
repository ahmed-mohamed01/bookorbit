<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Loader2, Pencil } from '@lucide/vue'
import type { MonitoredFormat, MonitoredReleaseDateCandidate, MonitoredReleaseDateSource, MonitoredReleaseLookupSource } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatList } from '@/i18n/formatters'
import { useMonitoredDateLabel } from '../composables/useMonitoredDateLabel'
import type { MonitoredReleaseDateState, MonitoredReleaseDateSuggestion, MonitoredReleaseDateUnavailable } from '../composables/useWorkReleaseDates'

/**
 * The release date of one format, and the only place it can be changed. An unverified date with no
 * way to verify it is not an answer, so the value itself opens the lookup that produced it.
 */
const props = defineProps<{
  format: MonitoredFormat
  open: boolean
  /** What the row already shows, including "Not announced yet" and TBA. */
  label: string
  muted: boolean
  /** The date behind the label, when it is a full one, so the manual field opens on it. */
  currentDate: string | null
  source: MonitoredReleaseDateSource | null
  /** Where the shown date came from and how fresh it is; hover-only on the row, so the open panel repeats it for touch. */
  details: string[]
  /** A listing that disagrees with the owner's own date; answering it either way settles the alert. */
  suggestion: MonitoredReleaseDateSuggestion | null
  state: MonitoredReleaseDateState
}>()

const emit = defineEmits<{
  openChange: [format: MonitoredFormat, open: boolean]
  set: [format: MonitoredFormat, releaseDate: string]
  clear: [format: MonitoredFormat]
}>()

const { t } = useI18n()
const monitoredDateLabel = useMonitoredDateLabel()

const manualInputId = useId()
const manualDate = ref('')
const approximate = ref(false)

const formatName = computed(() => t(`monitored.formats.${props.format}`))
const title = computed(() => t('monitored.panel.releaseDates.title', { format: formatName.value }))
const triggerLabel = computed(() => t('monitored.panel.releaseDates.change', { format: formatName.value, value: props.label }))
const ownDate = computed(() => props.source === 'user')
const nothingFoundLine = computed(() =>
  props.state.empty.length ? t('monitored.panel.releaseDates.nothingFound', { sources: formatList(props.state.empty.map(sourceName)) }) : null,
)
const actionHint = computed(() => {
  if (ownDate.value) return t('monitored.panel.releaseDates.hintChangeOwn')
  return props.source ? t('monitored.panel.releaseDates.hintSearchOthers') : t('monitored.panel.releaseDates.hintSearch')
})

// A full date behind the row is the most likely starting point for an adjustment, so the field
// opens on it rather than on an empty box the owner has to fill from memory.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    manualDate.value = props.currentDate?.length === 10 ? props.currentDate : ''
    approximate.value = false
  },
)

function candidateKey(candidate: MonitoredReleaseDateCandidate): string {
  return `${candidate.source}:${candidate.releaseDate}:${candidate.label ?? ''}`
}

function candidateDate(candidate: MonitoredReleaseDateCandidate): string {
  return monitoredDateLabel(candidate.releaseDate, candidate.precision) ?? candidate.releaseDate
}

function sourceName(source: MonitoredReleaseLookupSource): string {
  return t(`monitored.panel.source.${source}`)
}

function listingLabel(candidate: MonitoredReleaseDateCandidate): string {
  return t('monitored.panel.releaseDates.openListing', { source: sourceName(candidate.source) })
}

function unavailableText(entry: MonitoredReleaseDateUnavailable): string {
  const source = sourceName(entry.source)
  if (entry.reason === 'not_configured') return t('monitored.panel.releaseDates.unavailableNotConfigured', { source })
  if (entry.reason === 'throttled') return t('monitored.panel.releaseDates.unavailableThrottled', { source })
  return t('monitored.panel.releaseDates.unavailableFailed', { source })
}

/** The API only takes a full date, so a month or a year becomes a starting point to adjust. */
function periodStart(value: string): string {
  const [year, month] = value.split('-')
  return `${year}-${month ?? '01'}-01`
}

function handleOpenChange(open: boolean) {
  emit('openChange', props.format, open)
}

function handleSelect(candidate: MonitoredReleaseDateCandidate) {
  if (props.state.saving) return
  if (candidate.precision === 'day') {
    emit('set', props.format, candidate.releaseDate)
    return
  }
  manualDate.value = periodStart(candidate.releaseDate)
  approximate.value = true
}

function handleManualSet() {
  if (!manualDate.value || props.state.saving) return
  emit('set', props.format, manualDate.value)
}

function handleUseSuggestion() {
  const date = props.suggestion?.applicableDate
  if (!date || props.state.saving) return
  emit('set', props.format, date)
}

// Setting the date the row already carries is how the owner says "I have seen it": the server
// takes any set as the answer to whatever the automatic check had found.
function handleKeepMine() {
  if (!props.currentDate || props.state.saving) return
  emit('set', props.format, props.currentDate)
}

function handleClear() {
  if (props.state.saving) return
  emit('clear', props.format)
}
</script>

<template>
  <TooltipProvider>
    <Tooltip :disabled="open">
      <Popover :open="open" @update:open="handleOpenChange">
        <TooltipTrigger as-child>
          <PopoverTrigger as-child>
            <button
              type="button"
              class="-mx-1 inline-flex max-w-full items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-left text-sm transition-colors hover:border-primary/60 hover:bg-muted"
              :class="muted ? 'text-muted-foreground' : 'text-foreground'"
              :aria-label="triggerLabel"
            >
              <span class="truncate">{{ label }}</span>
              <Pencil :size="11" class="shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>

        <PopoverContent align="start" class="w-80 max-w-[calc(100vw-2rem)] p-0">
          <div class="border-b border-border px-3 py-2.5">
            <p class="text-sm font-semibold text-foreground">{{ title }}</p>
            <p v-if="details.length" data-testid="release-date-details" class="mt-0.5 text-xs text-foreground">
              <span v-for="line in details" :key="line" class="block">{{ line }}</span>
            </p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('monitored.panel.releaseDates.subtitle') }}</p>
          </div>

          <div v-if="suggestion" data-testid="release-date-suggestion-banner" class="border-b border-border bg-primary/5 px-3 py-2.5">
            <p class="text-xs text-foreground">{{ suggestion.text }}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <Button v-if="suggestion.applicableDate" size="sm" :disabled="state.saving" @click="handleUseSuggestion">
                {{ t('monitored.panel.releaseDates.useSuggested') }}
              </Button>
              <Button size="sm" variant="outline" :disabled="state.saving" @click="handleKeepMine">
                {{ t('monitored.panel.releaseDates.keepMine') }}
              </Button>
            </div>
          </div>

          <div class="max-h-64 overflow-y-auto px-2 py-2">
            <p v-if="state.loading" role="status" class="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <Loader2 class="size-4 animate-spin" aria-hidden="true" />
              {{ t('monitored.panel.releaseDates.loading') }}
            </p>
            <p v-else-if="state.error" role="alert" class="px-1 py-2 text-sm text-destructive">{{ state.error }}</p>
            <template v-else>
              <ul v-if="state.candidates.length" class="space-y-0.5">
                <li v-for="candidate in state.candidates" :key="candidateKey(candidate)" class="flex items-center gap-1">
                  <button
                    type="button"
                    class="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-60"
                    :disabled="state.saving"
                    @click="handleSelect(candidate)"
                  >
                    <span class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span class="text-sm font-medium text-foreground">{{ candidateDate(candidate) }}</span>
                      <span
                        v-if="candidate.weak"
                        class="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning"
                      >
                        {{ t('monitored.panel.releaseDates.placeholder') }}
                      </span>
                    </span>
                    <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                      {{ candidate.label ? `${sourceName(candidate.source)} · ${candidate.label}` : sourceName(candidate.source) }}
                    </span>
                  </button>
                  <a
                    v-if="candidate.url"
                    :href="candidate.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    :aria-label="listingLabel(candidate)"
                  >
                    <ExternalLink :size="14" aria-hidden="true" />
                  </a>
                </li>
              </ul>
              <p v-else-if="state.loaded" class="px-1 py-2 text-sm text-muted-foreground">{{ t('monitored.panel.releaseDates.empty') }}</p>
              <p v-if="state.loaded && nothingFoundLine" data-testid="release-date-nothing-found" class="px-1 pt-2 text-xs text-muted-foreground">
                {{ nothingFoundLine }}
              </p>
              <div v-if="state.loaded && state.unavailable.length" class="px-1 pb-1 pt-2">
                <p class="text-xs font-medium text-foreground">{{ t('monitored.panel.releaseDates.unavailableIntro') }}</p>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="entry in state.unavailable" :key="entry.source" class="text-xs text-muted-foreground">{{ unavailableText(entry) }}</li>
                </ul>
              </div>
            </template>
          </div>

          <div class="space-y-2 border-t border-border p-3">
            <label :for="manualInputId" class="block text-xs font-medium text-foreground">{{ t('monitored.panel.releaseDates.manualLabel') }}</label>
            <p v-if="approximate" class="text-xs text-muted-foreground">{{ t('monitored.panel.releaseDates.approximate') }}</p>
            <div class="flex items-center gap-2">
              <Input :id="manualInputId" v-model="manualDate" type="date" class="min-w-0 flex-1" :disabled="state.saving" />
              <Button size="sm" class="shrink-0" :disabled="!manualDate || state.saving" @click="handleManualSet">
                <Loader2 v-if="state.saving" class="size-3.5 animate-spin" aria-hidden="true" />
                {{ t('monitored.panel.releaseDates.set') }}
              </Button>
            </div>
            <div v-if="ownDate" class="pt-1">
              <button
                type="button"
                class="text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
                :disabled="state.saving"
                @click="handleClear"
              >
                {{ t('monitored.panel.releaseDates.clear') }}
              </button>
              <p class="mt-1 text-xs text-muted-foreground">{{ t('monitored.panel.releaseDates.clearHint') }}</p>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <TooltipContent class="max-w-64">
        <div data-testid="release-date-hint">
          <span v-for="line in details" :key="line" class="block">{{ line }}</span>
          <span class="block">{{ actionHint }}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
