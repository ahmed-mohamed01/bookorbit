<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Info } from '@lucide/vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const { t } = useI18n()

const open = ref(false)
let lastPointerType = 'mouse'

function handlePointerDown(event: PointerEvent) {
  lastPointerType = event.pointerType
}

function handleClick() {
  if (lastPointerType === 'mouse') return
  open.value = !open.value
}
</script>

<template>
  <Tooltip v-model:open="open" disable-closing-trigger>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="t('webSerials.sources.disclaimerLabel')"
        @pointerdown="handlePointerDown"
        @click="handleClick"
      >
        <Info :size="13" aria-hidden="true" />
      </button>
    </TooltipTrigger>
    <TooltipContent class="max-w-72">{{ t('webSerials.sources.disclaimer') }}</TooltipContent>
  </Tooltip>
</template>
