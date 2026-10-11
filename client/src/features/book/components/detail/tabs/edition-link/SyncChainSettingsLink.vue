<script setup lang="ts">
import { ABS_SETTINGS_ROUTE } from './chain-ui'

defineProps<{ label: string }>()
</script>

<template>
  <RouterLink :to="ABS_SETTINGS_ROUTE" class="font-semibold text-info hover:underline">{{ label }}</RouterLink>
</template>
