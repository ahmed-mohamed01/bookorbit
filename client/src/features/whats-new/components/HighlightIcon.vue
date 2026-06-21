<script setup lang="ts">
import { computed, type Component } from 'vue'
import * as Icons from '@lucide/vue'
import { Sparkles } from '@lucide/vue'
import { isIconNameShape } from '../lib/whats-new.logic'

const props = withDefaults(defineProps<{ name: string | null; size?: number }>(), { size: 18 })

const iconComponent = computed<Component>(() => {
  const name = props.name
  if (isIconNameShape(name) && name! in Icons) {
    return (Icons as Record<string, unknown>)[name!] as Component
  }
  return Sparkles
})
</script>

<template>
  <component :is="iconComponent" :size="size" />
</template>
