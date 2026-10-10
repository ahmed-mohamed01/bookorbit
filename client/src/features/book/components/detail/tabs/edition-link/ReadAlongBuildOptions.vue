<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Info, Loader2, Sparkles } from '@lucide/vue'
import type { StorytellerExistingMatch } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const props = withDefaults(
  defineProps<{
    keepRemoteCopy: boolean
    reclaimable: boolean
    targetLibraryName: string | null
    targetLibraries: { id: number; name: string }[]
    chosenTargetLibraryId: number | null
    existingMatch?: StorytellerExistingMatch | null
    busy?: boolean
  }>(),
  { existingMatch: null, busy: false },
)

const emit = defineEmits<{
  'update:keepRemoteCopy': [value: boolean]
  'update:targetLibraryId': [value: number | null]
  generate: []
  importExisting: []
  cancel: []
}>()

const { t } = useI18n()
const keepCopyLabelId = `read-along-keep-copy-${useId()}`
const destinationSelectId = `read-along-destination-${useId()}`

const KEEP_COPY_HINT_KEYS = {
  keep: 'book.detail.editionLink.readAlong.keepCopy.hintKeep',
  remove: 'book.detail.editionLink.readAlong.keepCopy.hintRemove',
} as const

const keepCopyHint = computed(() => t(KEEP_COPY_HINT_KEYS[props.keepRemoteCopy ? 'keep' : 'remove']))
const destinationText = computed(() =>
  props.targetLibraryName
    ? t('book.detail.editionLink.readAlong.destination.willBeAdded', { library: props.targetLibraryName })
    : t('book.detail.editionLink.readAlong.destination.willBeAddedDefault'),
)

// Only an aligned Storyteller book can be imported: an unaligned one still has to be processed.
const importMatch = computed(() => (props.existingMatch?.aligned ? props.existingMatch : null))

const destinationOpen = ref(false)
const destinationModel = computed({
  get: () => props.chosenTargetLibraryId,
  set: (value: number | null) => emit('update:targetLibraryId', value),
})

function handleKeepCopy(value: boolean) {
  emit('update:keepRemoteCopy', value)
}

function handleRevealDestination() {
  destinationOpen.value = true
}

function handleGenerate() {
  emit('generate')
}

function handleImportExisting() {
  emit('importExisting')
}

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5" data-testid="read-along-build-options">
    <p class="text-xs text-pretty text-muted-foreground">{{ t('book.detail.editionLink.chain.available.readAlong.optionsHint') }}</p>

    <div v-if="reclaimable" class="flex items-center gap-2.5" data-testid="read-along-keep-copy-row">
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <p :id="keepCopyLabelId" class="truncate text-xs text-foreground">{{ t('book.detail.editionLink.readAlong.keepCopy.label') }}</p>
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              :aria-label="keepCopyHint"
              data-testid="read-along-keep-copy-info"
            >
              <Info class="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent class="max-w-60">{{ keepCopyHint }}</TooltipContent>
        </Tooltip>
      </div>
      <ToggleSwitch
        :model-value="keepRemoteCopy"
        :disabled="busy"
        :aria-labelledby="keepCopyLabelId"
        data-testid="read-along-keep-copy"
        @update:model-value="handleKeepCopy"
      />
    </div>

    <div class="text-xs text-muted-foreground" data-testid="read-along-destination">
      <p class="flex flex-wrap items-center gap-x-1.5">
        <span>{{ destinationText }}</span>
        <button
          v-if="!destinationOpen && targetLibraries.length"
          type="button"
          class="text-info hover:underline"
          data-testid="read-along-destination-change"
          @click="handleRevealDestination"
        >
          {{ t('book.detail.editionLink.readAlong.destination.change') }}
        </button>
      </p>
      <template v-if="destinationOpen">
        <label :for="destinationSelectId" class="sr-only">{{ t('book.detail.editionLink.readAlong.destination.label') }}</label>
        <select
          :id="destinationSelectId"
          v-model="destinationModel"
          class="mt-1.5 h-8 w-full rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          data-testid="read-along-destination-select"
        >
          <option :value="null">{{ t('book.detail.editionLink.readAlong.destination.placeholder') }}</option>
          <option v-for="library in targetLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
        </select>
      </template>
    </div>

    <button
      v-if="importMatch"
      type="button"
      class="block max-w-full text-start text-xs text-pretty text-info hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="busy"
      data-testid="read-along-import"
      @click="handleImportExisting"
    >
      {{ t('book.detail.editionLink.readAlong.importExisting', { title: importMatch.title }) }}
    </button>

    <div class="flex items-center justify-end gap-1.5 pt-0.5">
      <Button variant="ghost" size="sm" class="h-8 px-2.5 text-xs" data-testid="read-along-options-cancel" @click="handleCancel">
        {{ t('book.detail.editionLink.chain.action.cancel') }}
      </Button>
      <Button size="sm" class="h-8 px-2.5 text-xs" :disabled="busy" data-testid="read-along-generate" @click="handleGenerate">
        <Loader2 v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />
        <Sparkles v-else class="size-3.5" aria-hidden="true" />
        {{ t('book.detail.editionLink.readAlong.generate') }}
      </Button>
    </div>
  </div>
</template>
