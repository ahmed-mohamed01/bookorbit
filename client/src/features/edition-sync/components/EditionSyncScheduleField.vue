<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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
  return !description || description === cron ? t(`${KEY}human.invalid`) : t(`${KEY}description`, { when: description })
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
  <div class="px-4 py-3.5">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div class="min-w-0">
        <label for="edition-sync-preset" class="text-sm">{{ t(`${KEY}title`) }}</label>
        <p id="edition-sync-summary" class="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{{ humanSchedule }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <select
          id="edition-sync-preset"
          :value="selectedPreset"
          class="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          aria-describedby="edition-sync-summary"
          @change="selectPreset"
        >
          <option v-for="preset in presets" :key="preset.value" :value="preset.value">{{ preset.label }}</option>
        </select>
        <span class="text-sm text-muted-foreground">{{ t(`${KEY}runHours.prefix`) }}</span>
        <input
          id="edition-sync-hours"
          type="number"
          inputmode="numeric"
          :min="EDITION_SYNC_RUN_HOURS_MIN"
          :max="EDITION_SYNC_RUN_HOURS_MAX"
          :value="Number.isFinite(runHours) ? runHours : ''"
          :aria-label="t(`${KEY}runHours.title`)"
          :aria-invalid="!isHoursValid"
          class="w-16 rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2"
          :class="isHoursValid ? 'border-border focus:ring-primary/50' : 'border-destructive focus:ring-destructive'"
          @input="handleHoursInput"
        />
        <span class="text-sm text-muted-foreground">{{ t(`${KEY}runHours.unit`, { count: hoursUnitCount }) }}</span>
      </div>
    </div>

    <p v-if="!isHoursValid" class="mt-2 text-xs text-destructive sm:text-right" role="alert">
      {{ t(`${KEY}runHours.invalid`, { min: EDITION_SYNC_RUN_HOURS_MIN, max: EDITION_SYNC_RUN_HOURS_MAX }) }}
    </p>

    <div v-if="isCustom" class="mt-3 flex flex-col gap-1.5 sm:items-end">
      <input
        id="edition-sync-cron"
        type="text"
        dir="ltr"
        :value="cronExpression ?? ''"
        placeholder="0 2 * * *"
        :aria-label="t(`${KEY}cronExpression`)"
        class="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 sm:w-60"
        :class="isCronValid ? 'border-border focus:ring-primary/50' : 'border-destructive focus:ring-destructive'"
        :aria-invalid="!isCronValid"
        aria-describedby="edition-sync-cron-help"
        @input="handleCronInput"
      />
      <p v-if="!isCronValid" id="edition-sync-cron-help" class="text-xs text-destructive">{{ t(`${KEY}cronInvalid`) }}</p>
      <p v-else id="edition-sync-cron-help" class="text-xs text-muted-foreground">{{ t(`${KEY}cronFormat`) }}</p>
    </div>
  </div>
</template>
