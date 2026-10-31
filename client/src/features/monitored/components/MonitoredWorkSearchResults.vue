<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { monitoredAcquisitionState, type MonitoredFormat, type MonitoredWork, type MonitoredWorkSearchItem } from '@bookorbit/types'
import { isMonitoredAcquisitionState, watchedFormats } from '../lib/monitored-format-state'
import MonitoredVirtualGrid from './MonitoredVirtualGrid.vue'
import MonitoredWorkCard from './MonitoredWorkCard.vue'
import EmptyState from '@/components/EmptyState.vue'

const props = defineProps<{
  items: MonitoredWorkSearchItem[]
  loading: boolean
  error: string | null
  canManage: boolean
  cardSize: number
  gridGap: number
}>()
const emit = defineEmits<{
  preview: [item: MonitoredWorkSearchItem]
  'quick-view': [work: MonitoredWork]
  'download-ebook': [work: MonitoredWork]
  'download-audiobook': [work: MonitoredWork]
  stop: [work: MonitoredWork]
}>()
const { t } = useI18n()
const cards = computed(() => props.items.map((item) => ({ ...item, id: item.work.id })))
function formats(item: MonitoredWorkSearchItem): MonitoredFormat[] {
  return watchedFormats(item.authorModes)
}
function queued(work: MonitoredWork, format: MonitoredFormat): boolean {
  return isMonitoredAcquisitionState(monitoredAcquisitionState(work.requestStatuses?.[format]) ?? 'wanted')
}
function preview(item: MonitoredWorkSearchItem) {
  emit('preview', item)
}
function quickView(work: MonitoredWork) {
  emit('quick-view', work)
}
function downloadEbook(work: MonitoredWork) {
  emit('download-ebook', work)
}
function downloadAudiobook(work: MonitoredWork) {
  emit('download-audiobook', work)
}
function stop(work: MonitoredWork) {
  emit('stop', work)
}
</script>

<template>
  <MonitoredVirtualGrid v-if="cards.length" :items="cards" :card-size="cardSize" :grid-gap="gridGap">
    <template #default="{ item }">
      <MonitoredWorkCard
        :work="item.work"
        :author-name="item.authorName"
        :monitored-formats="formats(item)"
        :format-modes="item.authorModes"
        :can-manage="canManage && item.isOwner"
        :ebook-queued="queued(item.work, 'ebook')"
        :audiobook-queued="queued(item.work, 'audiobook')"
        @preview="preview(item)"
        @quick-view="quickView"
        @download-ebook="downloadEbook"
        @download-audiobook="downloadAudiobook"
        @stop="stop"
      />
    </template>
  </MonitoredVirtualGrid>
  <EmptyState v-else-if="!loading && !error" icon="Bell" :title="t('monitored.search.empty')" :hint="t('monitored.search.emptyDescription')" />
</template>
