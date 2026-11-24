<script setup lang="ts">
import { computed, provide } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { JobListItem } from '@bookorbit/types'
import RequestDrawer from '@/features/book-requests/components/RequestDrawer.vue'
import { useRequestQueue } from '@/features/book-requests/composables/useRequestQueue'
import { REQUEST_DRAWER } from '@/features/book-requests/requestDrawerContext'
import { jobRequestRoute, requestIdFromJobUrl } from '../lib/job-subject-route'

const props = defineProps<{ items: JobListItem[] }>()

const route = useRoute()
const router = useRouter()
const open = computed(() => route.name === 'jobs-request-detail')
const currentId = computed(() => (open.value ? Number(route.params.id) : null))
const requests = computed(() => {
  const ids = new Set<number>()
  for (const item of props.items) {
    if (item.type !== 'request-download') continue
    const id = requestIdFromJobUrl(item.subject.url)
    if (id !== null) ids.add(id)
  }
  return Array.from(ids, (id) => ({ id }))
})
const { position, total, hasPrevious, hasNext, previousId, nextId } = useRequestQueue(requests, currentId)

function close() {
  void router.push({ name: 'jobs-activity', query: route.query })
}

function goPrevious() {
  if (previousId.value !== null) void router.push(jobRequestRoute(previousId.value, route.query))
}

function goNext() {
  if (nextId.value !== null) void router.push(jobRequestRoute(nextId.value, route.query))
}

provide(REQUEST_DRAWER, { position, total, hasPrevious, hasNext, goPrevious, goNext, close })
</script>

<template>
  <RequestDrawer :open="open" :level="1" @close="close">
    <router-view />
  </RequestDrawer>
</template>
