<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from '@lucide/vue'
import type { ChainAction, ChainActionId } from '@/features/book/lib/sync-chain'
import { chainText } from '@/features/book/lib/sync-chain-messages'

type ActionVariant = 'outline' | 'link' | 'cancel'

const props = withDefaults(defineProps<{ action: ChainAction; variant?: ActionVariant; busy?: boolean; disabled?: boolean }>(), {
  variant: 'outline',
  busy: false,
  disabled: false,
})
const emit = defineEmits<{ action: [id: ChainActionId] }>()

const { t } = useI18n()

const VARIANT_CLASS: Record<ActionVariant, string> = {
  outline:
    'h-7 gap-1 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
  link: 'h-7 gap-1 px-0.5 text-xs font-semibold text-info hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline',
  cancel:
    'size-7 justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50',
}

const label = computed(() => chainText(props.action.label, t))

function handleClick() {
  emit('action', props.action.id)
}
</script>

<template>
  <button
    type="button"
    class="inline-flex shrink-0 items-center whitespace-nowrap"
    :class="VARIANT_CLASS[variant]"
    :disabled="action.disabled || disabled || busy"
    :aria-busy="busy"
    :aria-label="variant === 'cancel' ? label : undefined"
    :title="variant === 'cancel' ? label : undefined"
    :data-action="action.id"
    data-testid="sync-chain-action"
    @click="handleClick"
  >
    <Loader2 v-if="busy" class="size-3 animate-spin" aria-hidden="true" />
    <X v-else-if="variant === 'cancel'" class="size-4" aria-hidden="true" />
    <template v-if="variant !== 'cancel'">{{ label }}</template>
  </button>
</template>
