<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, X } from '@lucide/vue'
import { Permission, type BookKnowledgeScope, type BookKnowledgePassage, type BookKnowledgeTermType } from '@bookorbit/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { useBookKnowledge } from '../composables/useBookKnowledge'
import KnowledgePassages from './KnowledgePassages.vue'
const props = defineProps<{ bookId: number; sessionScope?: BookKnowledgeScope; chapters?: TocItem[]; navigationLocked?: boolean }>()
const emit = defineEmits<{ 'update:sessionScope': [scope: BookKnowledgeScope]; close: []; jump: [passage: BookKnowledgePassage] }>()
const { t } = useI18n()
const { hasPermission } = usePermissions()
const {
  scope,
  status,
  query,
  type,
  terms,
  total,
  selectedKey,
  detail,
  card,
  cardFailed,
  answer,
  error,
  busy,
  asking,
  enabled,
  pending,
  indexing,
  hasMore,
  refreshStatus,
  build,
  loadMore,
  selectTerm,
  closeTerm,
  loadCard,
  ask,
} = useBookKnowledge(() => props.bookId)
scope.value = props.sessionScope ?? 'position'
watch(query, closeTerm)
watch(scope, (value) => emit('update:sessionScope', value))
const question = ref('')
const tabs: BookKnowledgeTermType[] = ['concept', 'person', 'place']
const wholeBook = computed({
  get: () => scope.value === 'full',
  set: (value) => {
    scope.value = value ? 'full' : 'position'
  },
})
const needsBuild = computed(() => status.value && ['none', 'stale', 'failed'].includes(status.value.status))
const isAdmin = computed(() => hasPermission(Permission.ManageAppSettings))
const passages = computed(() => card.value?.passages ?? detail.value?.passages ?? [])
const cutoffChapter = computed(() => (detail.value?.scope === 'position' ? detail.value.cutoffSpineIndex : null))
const chapterTitles = computed(() => {
  const titles = new Map<string, string>()
  function walk(chapters: TocItem[]) {
    for (const chapter of chapters) {
      const href = chapter.href.split('#')[0]!
      if (!titles.has(href)) titles.set(href, chapter.label)
      walk(chapter.subitems ?? [])
    }
  }
  walk(props.chapters ?? [])
  return new Map((detail.value?.spineHrefs ?? []).map((item) => [item.spineIndex, titles.get(item.href.split('#')[0]!)]))
})
function chapterTitle(spineIndex: number) {
  return chapterTitles.value.get(spineIndex) ?? t('bookKnowledge.section', { number: spineIndex + 1 })
}
function close() {
  emit('close')
}
function jump(passage: BookKnowledgePassage) {
  emit('jump', passage)
}
function setType(value: BookKnowledgeTermType) {
  closeTerm()
  type.value = value
}
function submitQuestion() {
  void ask(question.value)
}
</script>
<template>
  <div class="fixed inset-0 z-50 flex justify-end">
    <button class="flex-1" :aria-label="t('common.close')" @click="close" />
    <section
      role="dialog"
      aria-modal="true"
      :aria-label="t('bookKnowledge.title')"
      class="flex h-full w-[19rem] flex-col border-l border-border bg-card text-card-foreground shadow-2xl sm:w-[20rem] md:w-[21.5rem] lg:w-[22.5rem]"
    >
      <header class="flex items-center justify-between border-b border-border p-3">
        <h2 class="font-semibold">{{ t('bookKnowledge.title') }}</h2>
        <button :aria-label="t('common.close')" @click="close"><X class="size-5" /></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto p-3" :aria-busy="busy">
        <label class="block text-sm"
          >{{ t('bookKnowledge.search')
          }}<input v-model="query" maxlength="200" type="search" class="mt-1 w-full rounded-md border border-input bg-background p-2"
        /></label>
        <div role="tablist" :aria-label="t('bookKnowledge.types')" class="flex gap-2">
          <button
            v-for="tab in tabs"
            :key="tab"
            role="tab"
            :aria-selected="type === tab"
            class="rounded-md px-2 py-1 text-sm"
            :class="type === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'"
            @click="setType(tab)"
          >
            {{ t(`bookKnowledge.${tab}`) }}
          </button>
        </div>
        <p v-if="!status && pending.has('status')" role="status">{{ t('bookKnowledge.loading') }}</p>
        <div v-if="error" role="alert" class="space-y-2 text-sm text-destructive">
          <p>{{ t(`bookKnowledge.${error}`) }}</p>
          <button @click="refreshStatus">{{ t('bookKnowledge.retry') }}</button>
        </div>
        <div v-if="needsBuild" class="space-y-2 text-sm">
          <p>{{ t(status?.status === 'failed' ? 'bookKnowledge.failed' : 'bookKnowledge.notIndexed') }}</p>
          <button v-if="enabled" :disabled="busy" class="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" @click="build">
            {{ t(status?.status === 'failed' ? 'bookKnowledge.retry' : 'bookKnowledge.build') }}
          </button>
        </div>
        <div v-if="indexing" role="status" class="text-sm">
          <p>{{ t('bookKnowledge.indexing') }} {{ status?.progress }}%</p>
          <progress :value="status?.progress" max="100" class="w-full" />
        </div>
        <p v-if="status?.noProgress" class="text-sm text-muted-foreground">{{ t('bookKnowledge.noProgress') }}</p>
        <template v-if="status?.status === 'ready' && !selectedKey">
          <ul class="divide-y divide-border">
            <li v-for="term in terms" :key="term.key">
              <button class="flex w-full justify-between gap-2 py-2 text-left text-sm" @click="selectTerm(term.key)">
                <span>{{ term.displayName }}</span><span class="text-muted-foreground">{{ t('bookKnowledge.mentions', { count: term.count }) }}</span>
              </button>
            </li>
          </ul>
          <p v-if="!terms.length && !pending.has('terms')" class="text-sm text-muted-foreground">
            {{ t(type === 'concept' ? 'bookKnowledge.empty' : `bookKnowledge.empty_${type}`) }}
          </p>
          <button v-if="hasMore" :disabled="pending.has('terms')" class="text-sm text-primary" @click="loadMore">
            {{ t('bookKnowledge.more', { total }) }}
          </button>
        </template>
        <div v-if="selectedKey" class="space-y-3 border-t border-border pt-3">
          <button class="text-sm text-primary" @click="closeTerm">{{ t('bookKnowledge.back') }}</button>
          <p v-if="pending.has('detail') || pending.has('card')" role="status" class="text-sm">{{ t('bookKnowledge.loading') }}</p>
          <template v-if="detail">
            <h3 class="font-semibold">{{ detail.term.displayName }}</h3>
            <p class="text-sm text-muted-foreground">{{ t(`bookKnowledge.${detail.term.type}`) }}: {{ detail.term.aliases.join(', ') }}</p>
            <template v-if="card">
              <p v-if="card.card.insufficient" class="text-sm">{{ t('bookKnowledge.insufficient') }}</p>
              <p v-else class="text-sm">
                {{ card.card.meaning }}
                <Tooltip v-if="!card.checks.meaningVerified"
                  ><TooltipTrigger as-child
                    ><span tabindex="0" :aria-label="t('bookKnowledge.unverified')" :title="t('bookKnowledge.unverified')"
                      ><AlertTriangle class="inline size-4 text-destructive" /></span></TooltipTrigger
                  ><TooltipContent>{{ t('bookKnowledge.unverified') }}</TooltipContent></Tooltip
                >
              </p>
              <blockquote v-if="card.card.meaningQuote" class="border-l-2 border-primary pl-2 text-sm">
                {{ card.card.meaningQuote }} ({{ card.card.meaningPassage }})
              </blockquote>
              <div v-for="(point, index) in card.card.points" :key="index" class="text-sm">
                <p>{{ point.text }}</p>
                <blockquote class="border-l-2 border-primary pl-2">{{ point.quote }} ({{ point.passage }})</blockquote>
              </div>
            </template>
            <button v-if="status?.modelConfigured && cardFailed" :disabled="busy" class="text-sm text-primary" @click="loadCard">
              {{ t('bookKnowledge.retry') }}
            </button>
            <h4 class="text-sm font-medium">{{ t('bookKnowledge.chart') }}</h4>
            <ol class="space-y-1 text-xs">
              <li v-for="chapter in detail.histogram" :key="chapter.spineIndex" class="flex items-center gap-2">
                <span>{{ chapterTitle(chapter.spineIndex) }}</span><meter
                  min="0"
                  :max="detail.term.count"
                  :value="chapter.count"
                  class="min-w-0 flex-1"
                /><span>{{ chapter.count }}</span
                ><span v-if="chapter.spineIndex === cutoffChapter" class="text-primary">{{ t('bookKnowledge.here') }}</span>
              </li>
            </ol>
            <h4 class="text-sm font-medium">{{ t('bookKnowledge.oftenWith') }}</h4>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="related in detail.related"
                :key="related.key"
                class="rounded-md bg-muted px-2 py-1 text-xs"
                @click="selectTerm(related.key)"
              >
                {{ related.displayName }} ({{ related.count }})
              </button>
            </div>
            <KnowledgePassages :passages="passages" :chapters="chapters" :navigation-locked="navigationLocked" @jump="jump" />
          </template>
        </div>
        <form class="space-y-2" @submit.prevent="submitQuestion">
          <label class="block text-sm"
            >{{ t('bookKnowledge.ask')
            }}<textarea
              v-model="question"
              maxlength="2000"
              class="mt-1 w-full rounded-md border border-input bg-background p-2"
              :disabled="!status?.modelConfigured || status.status !== 'ready'"
            />
          </label>
          <button
            :disabled="asking || !question.trim() || !status?.modelConfigured || status.status !== 'ready'"
            class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {{ t('bookKnowledge.ask') }}
          </button>
        </form>
        <div v-if="answer" class="space-y-3 text-sm">
          <p>{{ answer.answer.notInBook ? t('bookKnowledge.notInBook') : answer.answer.answer }}</p>
          <div v-for="(point, index) in answer.answer.points" :key="index">
            <p>{{ point.text }}</p>
            <blockquote class="border-l-2 border-primary pl-2">{{ point.quote }} ({{ point.passage }})</blockquote>
          </div>
          <KnowledgePassages :passages="answer.passages" :chapters="chapters" :navigation-locked="navigationLocked" @jump="jump" />
        </div>
        <p v-if="status && !enabled" class="text-sm text-muted-foreground">
          {{ t('bookKnowledge.disabled') }} <span v-if="isAdmin">{{ t('bookKnowledge.disabledHint') }}</span>
        </p>
        <p v-else-if="status && !status.modelConfigured" class="text-sm text-muted-foreground">
          {{ t('bookKnowledge.noModel') }} <span v-if="isAdmin">{{ t('bookKnowledge.adminHint') }}</span>
        </p>
        <label class="flex items-center gap-2 text-sm"><input v-model="wholeBook" type="checkbox" />{{ t('bookKnowledge.wholeBook') }}</label>
        <p class="text-xs text-muted-foreground">{{ t('bookKnowledge.spoilers') }}</p>
      </div>
      <p class="border-t border-border p-3 text-xs text-muted-foreground">{{ t('bookKnowledge.note') }}</p>
    </section>
  </div>
</template>
