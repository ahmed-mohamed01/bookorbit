<script setup lang="ts">
import { computed } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { storyGuideUnavailable } from '../lib/story-guide-unavailable'
import StoryGuideTabContent from './StoryGuideTabContent.vue'
import StoryGuideTabUnavailable from './StoryGuideTabUnavailable.vue'

const props = defineProps<{ book: BookDetail }>()
const unavailable = computed(() => storyGuideUnavailable(props.book))
</script>

<template>
  <StoryGuideTabUnavailable v-if="unavailable" :reason="unavailable" />
  <StoryGuideTabContent v-else :book="book" />
</template>
