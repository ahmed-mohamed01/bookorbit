<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from '@lucide/vue'
import { Button, type ButtonVariants } from '@/components/ui/button'
import type { ChainAction, ChainActionId } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'
import { CHAIN_ACTION_ICON } from './chain-ui'

type ActionVariant = 'outline' | 'link' | 'cancel'

const props = withDefaults(defineProps<{ action: ChainAction; variant?: ActionVariant; busy?: boolean; disabled?: boolean; keepFocus?: boolean }>(), {
  variant: 'outline',
  busy: false,
  disabled: false,
  keepFocus: false,
})
const emit = defineEmits<{ action: [id: ChainActionId] }>()

const { t } = useI18n()

const BUTTON: Record<ActionVariant, { variant: ButtonVariants['variant']; size: ButtonVariants['size']; class: string }> = {
  outline: { variant: 'outline', size: 'sm', class: 'h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2' },
  link: { variant: 'link', size: 'sm', class: 'h-7 gap-1 px-0.5 text-xs font-semibold text-info has-[>svg]:px-0.5' },
  cancel: { variant: 'destructive-ghost', size: 'icon-sm', class: 'size-7' },
}

const held = computed(() => props.disabled || props.busy)
const nativeDisabled = computed(() => props.action.disabled || (!props.keepFocus && held.value))

const label = computed(() => chainText(props.action.label, t))
const iconOnly = computed(() => props.variant === 'cancel')
const icon = computed(() => (iconOnly.value ? X : CHAIN_ACTION_ICON[props.action.id]))
const iconClass = computed(() => (iconOnly.value ? 'size-4' : 'size-3.5'))

function handleClick() {
  if (props.keepFocus && held.value) return
  emit('action', props.action.id)
}
</script>

<template>
  <Button
    type="button"
    :variant="BUTTON[variant].variant"
    :size="BUTTON[variant].size"
    :class="[BUTTON[variant].class, keepFocus ? 'aria-disabled:pointer-events-none aria-disabled:opacity-50' : '']"
    :disabled="nativeDisabled"
    :aria-disabled="keepFocus && held ? 'true' : undefined"
    :aria-busy="busy"
    :aria-label="iconOnly ? label : undefined"
    :title="iconOnly ? label : undefined"
    :data-action="action.id"
    data-testid="sync-chain-action"
    @click="handleClick"
  >
    <Loader2 v-if="busy" :class="iconClass" class="animate-spin" aria-hidden="true" />
    <component :is="icon" v-else-if="icon" :class="iconClass" aria-hidden="true" />
    <span v-if="!iconOnly">{{ label }}</span>
  </Button>
</template>
