<script setup lang="ts">
import { computed } from 'vue'
import { Headphones } from '@lucide/vue'
import type { WorkVariantRole } from '@bookorbit/types'
import { ROLE_COLOR } from '../lib/work-roles'

const props = withDefaults(defineProps<{ role: WorkVariantRole; label: string; dashed?: boolean }>(), { dashed: false })

const style = computed(() => {
  const color = ROLE_COLOR[props.role]
  return {
    color,
    backgroundColor: `color-mix(in oklch, ${color} 13%, transparent)`,
    borderColor: `color-mix(in oklch, ${color} ${props.dashed ? 60 : 30}%, transparent)`,
  }
})
</script>

<template>
  <span
    class="inline-flex h-5 min-w-13 shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[10px] leading-none font-bold tracking-wider uppercase"
    :class="dashed ? 'border-dashed' : ''"
    :style="style"
  >
    {{ label }}
    <Headphones v-if="role === 'readAlong'" class="size-[1.1em] shrink-0" :stroke-width="2.5" aria-hidden="true" />
  </span>
</template>
