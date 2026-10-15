<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, BookText, Loader2, Pencil, Plug, Plus, Puzzle, ShieldCheck, TriangleAlert } from '@lucide/vue'
import type { WebSerialEngineHealth, WebSerialKind, WebSerialNovelEngine } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConnectionHealth from '@/features/settings/ConnectionHealth.vue'

const props = defineProps<{
  kind: WebSerialKind
  url: string | null
  health: WebSerialEngineHealth | null
  testing: boolean
  testError: string | null
  novelEngine?: WebSerialNovelEngine
}>()

const emit = defineEmits<{ test: []; edit: []; manage: [] }>()

const { t } = useI18n()

const configured = computed(() => Boolean(props.url))
const failed = computed(() => configured.value && (props.health?.ok === false || props.testError !== null))
const errorText = computed(() => props.testError ?? props.health?.error ?? t('webSerials.settings.card.failedFallback'))
const metaParts = computed(() => {
  const parts: string[] = []
  if (props.url) parts.push(props.url)
  if (props.health?.ok) {
    if (props.health.version) parts.push(props.health.version)
    parts.push(t(`webSerials.settings.card.sources.${props.kind}`, { count: props.health.searchableSources }))
  }
  return parts
})
const solverDetected = computed(() => props.kind === 'novel' && props.health?.ok === true && props.health.solver === true)
const titleId = computed(() => `web-serials-engine-${props.kind}`)
const engineLabel = computed(() =>
  props.kind === 'novel' && props.novelEngine
    ? t(`webSerials.settings.card.novel.engines.${props.novelEngine}`)
    : t(`webSerials.settings.card.${props.kind}.engine`),
)

function handleTest() {
  emit('test')
}

function handleManage() {
  emit('manage')
}

function handleEdit() {
  emit('edit')
}
</script>

<template>
  <section class="settings-card" :aria-labelledby="titleId">
    <div class="bg-card px-4 py-3.5 md:px-5 md:py-4" :class="failed ? 'rounded-[inherit] ring-1 ring-destructive/40' : ''">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 basis-72 gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-lg"
            :class="failed ? 'bg-destructive/12 text-destructive' : 'bg-muted text-muted-foreground'"
            aria-hidden="true"
          >
            <TriangleAlert v-if="failed" :size="17" />
            <BookOpen v-else-if="kind === 'manga'" :size="17" />
            <BookText v-else :size="17" />
          </span>

          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 :id="titleId" class="settings-label">{{ t(`webSerials.settings.card.${kind}.title`) }}</h3>
              <span class="text-xs text-muted-foreground">{{ engineLabel }}</span>
              <ConnectionHealth :last-tested-at="health?.checkedAt ?? null" :last-test-ok="health?.ok ?? null" :enabled="configured" />
              <span
                v-if="solverDetected"
                class="inline-flex h-[22px] items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 text-xs font-medium whitespace-nowrap text-success"
                :title="t('webSerials.settings.card.solverHint')"
                data-testid="engine-solver"
              >
                <ShieldCheck :size="12" aria-hidden="true" />
                {{ t('webSerials.settings.card.solver') }}
              </span>
            </div>
            <div v-if="metaParts.length" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <template v-for="(part, index) in metaParts" :key="index">
                <span v-if="index > 0" class="size-[3px] rounded-full bg-border" aria-hidden="true"></span>
                <span :class="index === 0 ? 'font-mono break-all' : ''">{{ part }}</span>
              </template>
            </div>
          </div>
        </div>

        <div v-if="configured" class="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" :disabled="testing" @click="handleTest">
            <Loader2 v-if="testing" class="animate-spin" aria-hidden="true" />
            <Plug v-else :size="14" aria-hidden="true" />
            {{ t('webSerials.settings.card.test') }}
          </Button>
          <Button size="sm" variant="outline" @click="handleManage">
            <Puzzle :size="14" aria-hidden="true" />
            {{ t('webSerials.settings.card.manageSources') }}
          </Button>
          <Button size="sm" variant="outline" @click="handleEdit">
            <Pencil :size="14" aria-hidden="true" />
            {{ t('webSerials.settings.card.edit') }}
          </Button>
        </div>
      </div>

      <div v-if="failed" role="alert" class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{{ errorText }}</p>
        <p class="mt-1 text-xs">{{ t('webSerials.settings.card.failedHint') }}</p>
      </div>

      <div v-if="!configured" class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border p-3">
        <p class="text-sm text-muted-foreground">{{ t(`webSerials.settings.card.${kind}.empty`) }}</p>
        <Button size="sm" @click="handleEdit">
          <Plus :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.card.connect') }}
        </Button>
      </div>

      <div v-if="configured && $slots.default" class="mt-3.5 border-t border-border pt-3.5">
        <slot />
      </div>
    </div>
  </section>
</template>
