<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import '@/lib/echarts-register'
import VChart from 'vue-echarts'
import { useChartTokens } from '@/composables/useChartTokens'
import { buildChartTheme } from '@/lib/echarts'

defineOptions({ inheritAttrs: false })
const INIT_OPTIONS = { renderer: 'svg' as const }
const tokens = useChartTokens()
const theme = computed(() => buildChartTheme(tokens.value))
const chart = useTemplateRef<InstanceType<typeof VChart>>('chart')
const convertFromPixel = (
  ...args: Parameters<InstanceType<typeof VChart>['convertFromPixel']>
): ReturnType<InstanceType<typeof VChart>['convertFromPixel']> | null => chart.value?.convertFromPixel(...args) ?? null
const containPixel: InstanceType<typeof VChart>['containPixel'] = (...args) => chart.value?.containPixel(...args) ?? false

defineExpose({ convertFromPixel, containPixel })
</script>

<template>
  <VChart ref="chart" v-bind="$attrs" :theme="theme" :init-options="INIT_OPTIONS" />
</template>
