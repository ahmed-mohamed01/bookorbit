<script setup lang="ts">
import { computed, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BookKnowledgePassage, BookKnowledgeScope } from '@bookorbit/types'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { useReadAloudDelivery } from '@/features/delivery/composables/useReadAloudDelivery'
import { useKnowledgeVisit } from '../composables/useKnowledgeVisit'
import { useKnowledgeNavigation, type KnowledgeReaderView } from '../composables/useKnowledgeNavigation'
import BookKnowledgePanel from './BookKnowledgePanel.vue'

const props = defineProps<{
  bookId: number
  epub: boolean
  chapters: TocItem[]
  navigationLocked: boolean
  view?: unknown
  canNavigate: () => boolean
  goTo: (target: string) => unknown
  goToFraction: (fraction: number) => unknown
  navigateToTarget: (target: string) => unknown
  progress: { cfi: Ref<string | null>; fraction: Ref<number>; save: () => unknown }
}>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()

const isOpen = ref(false)
const scope = ref<BookKnowledgeScope>('position')
const { supported } = useReadAloudDelivery('book-knowledge')
const available = computed(() => supported.value && props.epub)
const visit = useKnowledgeVisit(
  () => ({ cfi: props.progress.cfi.value, fraction: props.progress.fraction.value }),
  (priorCfi, priorFraction) => (priorCfi ? props.goTo(priorCfi) : props.goToFraction(priorFraction)),
)
const navigation = useKnowledgeNavigation(
  () => (props.view ?? null) as KnowledgeReaderView | null,
  () => props.canNavigate(),
  async (target) => {
    visit.begin()
    await props.navigateToTarget(target)
  },
)

function toggle() {
  isOpen.value = !isOpen.value
  if (isOpen.value) emit('open')
}
function close() {
  navigation.cancel()
  isOpen.value = false
}
function updateScope(value: BookKnowledgeScope) {
  scope.value = value
}
async function jump(passage: BookKnowledgePassage) {
  if (await navigation.jump(passage)) close()
}
function back() {
  if (props.canNavigate()) void visit.back()
}
function continueHere() {
  if (visit.continueHere()) void props.progress.save()
}

defineExpose({ available, isOpen, visitActive: visit.active, toggle, close })
</script>
<template>
  <div
    v-if="visit.active.value"
    class="fixed bottom-16 left-1/2 z-50 flex -translate-x-1/2 gap-3 rounded-md border border-border bg-card p-2 text-xs text-card-foreground shadow"
  >
    <button @click="back">{{ t('bookKnowledge.return') }}</button>
    <button @click="continueHere">{{ t('bookKnowledge.continue') }}</button>
  </div>
  <BookKnowledgePanel
    v-if="isOpen && available"
    :book-id="bookId"
    :chapters="chapters"
    :navigation-locked="navigationLocked"
    :session-scope="scope"
    @update:session-scope="updateScope"
    @close="close"
    @jump="jump"
  />
</template>
