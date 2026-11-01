<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarClock, Hourglass } from '@lucide/vue'
import { EDITION_SYNC_DEFAULT_CRON, EDITION_SYNC_RUN_HOURS_MAX, EDITION_SYNC_RUN_HOURS_MIN, isFiveFieldCronExpression } from '@bookorbit/types'
import { parseCronToHuman } from '@/features/library/utils/cron'

const { t, locale } = useI18n()

const CUSTOM = '__custom__'
const NEVER = '__never__'
const KEY = 'editionSync.admin.schedule.'

const props = defineProps<{ cronExpression: string | null; runHours: number }>()

const emit = defineEmits<{
  'update:cronExpression': [value: string | null]
  'update:runHours': [value: number]
  'update:valid': [value: boolean]
}>()

const presets = computed(() => [
  { label: t(`${KEY}presets.never`), value: NEVER },
  { label: t(`${KEY}presets.daily`), value: EDITION_SYNC_DEFAULT_CRON },
  { label: t(`${KEY}presets.weekly`), value: '0 2 * * 0' },
  { label: t(`${KEY}presets.custom`), value: CUSTOM },
])

function isPresetCron(cron: string): boolean {
  return presets.value.some((preset) => preset.value === cron)
}

const customMode = ref(props.cronExpression !== null && !isPresetCron(props.cronExpression))

watch(
  () => props.cronExpression,
  (cron) => {
    if (cron !== null && !isPresetCron(cron)) customMode.value = true
  },
)

const selectedPreset = computed(() => {
  if (customMode.value) return CUSTOM
  return props.cronExpression === null ? NEVER : props.cronExpression
})
const hoursUnitCount = computed(() => (Number.isFinite(props.runHours) ? props.runHours : 0))
const isCustom = computed(() => customMode.value)
const isCronValid = computed(() => !isCustom.value || (!!props.cronExpression && isFiveFieldCronExpression(props.cronExpression)))
const isHoursValid = computed(
  () => Number.isInteger(props.runHours) && props.runHours >= EDITION_SYNC_RUN_HOURS_MIN && props.runHours <= EDITION_SYNC_RUN_HOURS_MAX,
)

watch([isCronValid, isHoursValid], ([cronOk, hoursOk]) => emit('update:valid', cronOk && hoursOk), { immediate: true })

const humanSchedule = computed(() => {
  const cron = props.cronExpression
  if (!cron) return t(`${KEY}human.never`)
  const description = parseCronToHuman(cron, locale.value)
  return !description || description === cron ? t(`${KEY}human.invalid`) : description
})

function selectPreset(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  customMode.value = value === CUSTOM
  if (value === NEVER) emit('update:cronExpression', null)
  else if (value === CUSTOM) emit('update:cronExpression', '0 3 * * *')
  else emit('update:cronExpression', value)
}

function handleCronInput(event: Event) {
  emit('update:cronExpression', (event.target as HTMLInputElement).value || null)
}

function handleHoursInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  emit('update:runHours', raw.trim() === '' ? Number.NaN : Number(raw))
}
</script>

<template>
  <section class="divide-y divide-border rounded-xl border border-border bg-card">
    <div class="flex items-start gap-3.5 px-4 py-3.5">
      <CalendarClock :size="17" class="mt-0.5 shrink-0 text-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <label for="edition-sync-preset" class="text-sm font-semibold text-foreground">{{ t(`${KEY}title`) }}</label>
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <select
            id="edition-sync-preset"
            :value="selectedPreset"
            class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            aria-describedby="edition-sync-summary"
            @change="selectPreset"
          >
            <option v-for="preset in presets" :key="preset.value" :value="preset.value">{{ preset.label }}</option>
          </select>
          <p id="edition-sync-summary" class="text-xs text-muted-foreground" aria-live="polite">{{ humanSchedule }}</p>
        </div>

        <div v-if="isCustom" class="mt-3">
          <label for="edition-sync-cron" class="mb-1.5 block text-xs font-medium text-muted-foreground">{{ t(`${KEY}cronExpression`) }}</label>
          <input
            id="edition-sync-cron"
            type="text"
            dir="ltr"
            :value="cronExpression ?? ''"
            placeholder="0 2 * * *"
            class="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 sm:w-60"
            :class="isCronValid ? 'border-input focus:ring-ring' : 'border-destructive focus:ring-destructive'"
            :aria-invalid="!isCronValid"
            aria-describedby="edition-sync-cron-help"
            @input="handleCronInput"
          />
          <p v-if="!isCronValid" id="edition-sync-cron-help" class="mt-1 text-xs text-destructive">{{ t(`${KEY}cronInvalid`) }}</p>
          <p v-else id="edition-sync-cron-help" class="mt-1 text-xs text-muted-foreground">{{ t(`${KEY}cronFormat`) }}</p>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">{{ t(`${KEY}timezoneHint`) }}</p>
      </div>
    </div>

    <div class="flex items-start gap-3.5 px-4 py-3.5">
      <Hourglass :size="17" class="mt-0.5 shrink-0 text-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <label for="edition-sync-hours" class="text-sm font-semibold text-foreground">{{ t(`${KEY}runHours.title`) }}</label>
        <div class="mt-2 flex items-center gap-2">
          <input
            id="edition-sync-hours"
            type="number"
            inputmode="numeric"
            :min="EDITION_SYNC_RUN_HOURS_MIN"
            :max="EDITION_SYNC_RUN_HOURS_MAX"
            :value="Number.isFinite(runHours) ? runHours : ''"
            class="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            @input="handleHoursInput"
          />
          <span class="text-xs text-muted-foreground">{{ t(`${KEY}runHours.unit`, { count: hoursUnitCount }) }}</span>
        </div>
        <p v-if="!isHoursValid" class="mt-2 text-xs text-destructive" role="alert">
          {{ t(`${KEY}runHours.invalid`, { min: EDITION_SYNC_RUN_HOURS_MIN, max: EDITION_SYNC_RUN_HOURS_MAX }) }}
        </p>
        <p v-else class="mt-2 text-xs text-muted-foreground">{{ t(`${KEY}runHours.hint`) }}</p>
      </div>
    </div>
  </section>
</template>
