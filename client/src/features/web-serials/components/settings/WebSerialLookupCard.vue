<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Library, Loader2, Plug, TriangleAlert } from '@lucide/vue'
import type { WebSerialLookupHealth } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatDateTime, formatRelativeFromNow } from '@/i18n/formatters'

const props = defineProps<{
  enabled: boolean
  health: WebSerialLookupHealth | null
  testing: boolean
  testError: string | null
}>()

const emit = defineEmits<{ test: []; 'update:enabled': [value: boolean] }>()

const { t } = useI18n()
const explained = ref(false)

const EXPLAINED = ['does', 'sends', 'off'] as const

type Tone = 'ok' | 'failed' | 'paused' | 'untested' | 'off'

const TONES: Record<Tone, string> = {
  ok: 'border-success/40 bg-success/10 text-success',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  paused: 'border-warning/40 bg-warning/10 text-warning',
  untested: 'border-border bg-muted text-muted-foreground',
  off: 'border-border bg-muted text-muted-foreground',
}

const pausedUntil = computed(() => {
  const value = props.health?.pausedUntil
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now() ? null : date
})
const tone = computed<Tone>(() => {
  if (!props.enabled) return 'off'
  if (pausedUntil.value) return 'paused'
  if (props.testError !== null) return 'failed'
  if (!props.health) return 'untested'
  return props.health.ok ? 'ok' : 'failed'
})
const label = computed(() => {
  if (tone.value === 'paused' && pausedUntil.value) {
    return t('webSerials.settings.lookup.paused', { time: formatTime(pausedUntil.value) })
  }
  return t(`webSerials.settings.lookup.status.${tone.value}`)
})
const errorText = computed(() => props.testError ?? props.health?.error ?? t('webSerials.settings.lookup.failedFallback'))
const showError = computed(() => props.enabled && (tone.value === 'failed' || tone.value === 'paused'))
const checkedAt = computed(() => (props.health ? new Date(props.health.checkedAt) : null))
const checkedLabel = computed(() =>
  checkedAt.value && !Number.isNaN(checkedAt.value.getTime())
    ? t('webSerials.settings.lookup.checked', { time: formatRelativeFromNow(checkedAt.value) })
    : null,
)
const checkedTitle = computed(() => (checkedAt.value && !Number.isNaN(checkedAt.value.getTime()) ? formatDateTime(checkedAt.value) : undefined))

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function handleToggleExplained() {
  explained.value = !explained.value
}

function handleTest() {
  emit('test')
}

function handleToggle(value: boolean) {
  emit('update:enabled', value)
}
</script>

<template>
  <section class="settings-card" aria-labelledby="web-serials-lookup-title">
    <div class="bg-card px-4 py-3.5 md:px-5 md:py-4" :class="showError && tone === 'failed' ? 'rounded-[inherit] ring-1 ring-destructive/40' : ''">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 basis-72 gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-lg"
            :class="showError && tone === 'failed' ? 'bg-destructive/12 text-destructive' : 'bg-muted text-muted-foreground'"
            aria-hidden="true"
          >
            <TriangleAlert v-if="showError && tone === 'failed'" :size="17" />
            <Library v-else :size="17" />
          </span>

          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 id="web-serials-lookup-title" class="settings-label">{{ t('webSerials.settings.lookup.title') }}</h3>
              <span class="inline-flex items-center gap-1.5">
                <span
                  data-testid="lookup-status"
                  class="inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap"
                  :class="TONES[tone]"
                >
                  <Check v-if="tone === 'ok'" :size="12" :stroke-width="2.5" aria-hidden="true" />
                  <TriangleAlert v-else-if="tone === 'failed' || tone === 'paused'" :size="12" aria-hidden="true" />
                  <span v-else class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                  {{ label }}
                </span>
                <span v-if="checkedLabel && enabled" class="text-xs text-muted-foreground" :title="checkedTitle">{{ checkedLabel }}</span>
              </span>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('webSerials.settings.lookup.subtitle') }}</p>
            <button
              type="button"
              class="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-controls="web-serials-lookup-explained"
              :aria-expanded="explained"
              @click="handleToggleExplained"
            >
              {{ t('webSerials.settings.lookup.howTitle') }}
              <ChevronDown
                :size="13"
                class="transition-transform motion-reduce:transition-none"
                :class="explained ? 'rotate-180' : ''"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-3">
          <Button size="sm" variant="outline" :disabled="testing || !enabled" @click="handleTest">
            <Loader2 v-if="testing" class="animate-spin" aria-hidden="true" />
            <Plug v-else :size="14" aria-hidden="true" />
            {{ t('webSerials.settings.card.test') }}
          </Button>
          <ToggleSwitch :model-value="enabled" :aria-label="t('webSerials.settings.lookup.toggle')" @update:model-value="handleToggle" />
        </div>
      </div>

      <dl v-if="explained" id="web-serials-lookup-explained" class="mt-3 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <div v-for="part in EXPLAINED" :key="part">
          <dt class="font-semibold text-foreground">{{ t(`webSerials.settings.lookup.how.${part}.title`) }}</dt>
          <dd class="mt-0.5 text-muted-foreground">{{ t(`webSerials.settings.lookup.how.${part}.body`) }}</dd>
        </div>
      </dl>

      <div v-if="showError" role="alert" class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{{ errorText }}</p>
        <p class="mt-1 text-xs">{{ tone === 'paused' ? t('webSerials.settings.lookup.pausedHint') : t('webSerials.settings.lookup.failedHint') }}</p>
      </div>
    </div>
  </section>
</template>
