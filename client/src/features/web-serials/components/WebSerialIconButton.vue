<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import type { Component } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

withDefaults(
  defineProps<{
    icon: Component
    label: string
    tooltip?: string
    busy?: boolean
    disabled?: boolean
    variant?: 'outline' | 'destructive-outline'
  }>(),
  { busy: false, disabled: false, variant: 'outline' },
)
const emit = defineEmits<{ click: [] }>()

function handleClick() {
  emit('click')
}
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button :variant="variant" size="icon-sm" :disabled="disabled || busy" :aria-label="label" @click="handleClick">
        <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
        <component :is="icon" v-else :size="14" aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip ?? label }}</TooltipContent>
  </Tooltip>
</template>
