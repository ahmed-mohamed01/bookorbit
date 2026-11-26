<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildConstellation } from '../lib/constellation'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import { entityGroup, type StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ view: StoryGuideView; percent: string }>()
const emit = defineEmits<{ open: [key: string] }>()
const { t } = useI18n()
const showLinks = ref(true)
const selection = ref<string | null>(null)
const graph = computed(() => buildConstellation(props.view))
const selected = computed(() => (selection.value === null ? undefined : graph.value.byKey.get(selection.value)))
const links = computed(() => (showLinks.value ? graph.value.links : []))
const isConnected = (edge: { a: { entity: { key: string } }; b: { entity: { key: string } } }) =>
  edge.a.entity.key === selected.value?.entity.key || edge.b.entity.key === selected.value?.entity.key
const selectedTies = computed(() => graph.value.ties.filter(isConnected))
const selectedLinks = computed(() => links.value.filter(isConnected))
const neighbours = computed(() => new Set([selected.value, ...[...selectedTies.value, ...selectedLinks.value].flatMap(({ a, b }) => [a, b])]))

const colors = { people: 'fill-star-highlight', places: 'fill-info', terms: 'fill-muted-foreground' } as const

function select(key: string) {
  selection.value = selection.value === key ? null : key
}

function clear() {
  selection.value = null
}

function open() {
  if (selected.value) emit('open', selected.value.entity.key)
}
</script>

<template>
  <div class="space-y-3">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-base font-semibold">{{ t('book.detail.storyGuideTab.sections.constellation') }}</h2>
      <span class="text-xs tabular-nums text-muted-foreground">{{
        t('book.detail.storyGuideTab.graphAside', { stars: graph.stars.length, ties: graph.ties.length, percent })
      }}</span>
    </header>
    <div class="grid min-w-0 gap-3 @[62rem]/book-detail:grid-cols-[minmax(0,1fr)_16.25rem]">
      <section class="overflow-hidden rounded-xl border border-border bg-background">
        <svg viewBox="0 0 820 520" class="block w-full" role="group" :aria-label="t('book.detail.storyGuideTab.sections.constellation')">
          <line
            v-for="edge in links"
            :key="edge.key"
            :x1="edge.a.x"
            :y1="edge.a.y"
            :x2="edge.b.x"
            :y2="edge.b.y"
            stroke-dasharray="4 5"
            :stroke-width="Math.min(2, 0.6 + edge.weight * 1.4)"
            class="stroke-muted-foreground/45"
            :class="{ 'opacity-15': selected && !isConnected(edge) }"
          />
          <line
            v-for="edge in graph.ties"
            :key="edge.key"
            :x1="edge.a.x"
            :y1="edge.a.y"
            :x2="edge.b.x"
            :y2="edge.b.y"
            :stroke-width="Math.min(5.5, 1.2 + Math.log2(edge.weight + 1) * 1.1)"
            class="stroke-primary/55"
            :class="{ 'opacity-15': selected && !isConnected(edge) }"
          />
          <g
            v-for="star in graph.stars"
            :key="star.entity.key"
            role="button"
            tabindex="0"
            class="group cursor-pointer outline-none"
            :class="{ 'opacity-25': selected && !neighbours.has(star) }"
            :aria-label="star.entity.name"
            :aria-pressed="selected === star"
            @click="select(star.entity.key)"
            @keydown.enter.prevent="select(star.entity.key)"
            @keydown.space.prevent="select(star.entity.key)"
          >
            <circle :cx="star.x" :cy="star.y" :r="star.radius * 2.4" class="opacity-15" :class="colors[entityGroup(star.entity.kind)]" />
            <circle
              :cx="star.x"
              :cy="star.y"
              :r="star.radius"
              :class="[
                colors[entityGroup(star.entity.kind)],
                selected === star ? 'stroke-foreground stroke-2' : 'group-focus-visible:stroke-foreground group-focus-visible:stroke-2',
              ]"
            />
            <text
              v-if="graph.stars.length <= 28 || star.entity.importance === 1 || (selected && neighbours.has(star))"
              :x="star.x + (star.x > 600 ? -1 : 1) * (star.radius + 7)"
              :y="star.y + 4"
              :text-anchor="star.x > 600 ? 'end' : 'start'"
              class="pointer-events-none fill-foreground text-[13px]"
            >
              {{ star.entity.name }}
            </text>
          </g>
        </svg>
        <div class="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span v-for="(color, kind) in colors" :key="kind" class="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 8 8" class="size-2" aria-hidden="true"><circle cx="4" cy="4" r="4" :class="color" /></svg>
            {{ t(`book.detail.storyGuideTab.groups.${kind}`) }}
          </span>
          <span class="inline-flex items-center gap-1.5"
            ><span class="w-4 border-t-2 border-primary/55" />{{ t('book.detail.storyGuideTab.tie') }}</span
          >
          <span class="inline-flex items-center gap-1.5"
            ><span class="w-4 border-t border-dashed border-muted-foreground" />{{ t('book.detail.storyGuideTab.together') }}</span
          >
        </div>
      </section>
      <aside class="self-start space-y-3 rounded-xl border border-border bg-card p-3.5 text-sm">
        <template v-if="selected">
          <div>
            <p class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <component
                :is="entityKindIcon(selected.entity.kind)"
                class="size-3 shrink-0"
                :class="entityKindColor(selected.entity.kind)"
                aria-hidden="true"
              />
              {{ t(`book.detail.storyGuideTab.kinds.${selected.entity.kind}`, t('book.detail.storyGuideTab.kinds.term')) }}
            </p>
            <h3 class="text-base font-semibold break-words">{{ selected.entity.name }}</h3>
          </div>
          <p>{{ selected.entity.profiles[0]?.text ?? t('book.detail.storyGuideTab.noProfile') }}</p>
          <p class="text-xs text-muted-foreground">
            {{ t('book.detail.storyGuideTab.connections', { ties: selectedTies.length, links: selectedLinks.length }) }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-muted" @click="open">
              {{ t('book.detail.storyGuideTab.open') }}
            </button>
            <button type="button" class="rounded-md px-2.5 py-1 text-xs hover:bg-muted" @click="clear">
              {{ t('book.detail.storyGuideTab.clear') }}
            </button>
          </div>
        </template>
        <template v-else>
          <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {{ t('book.detail.storyGuideTab.graphHelpTitle') }}
          </h3>
          <p>{{ t('book.detail.storyGuideTab.graphHelp', { percent }) }}</p>
          <p class="text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.selectStar') }}</p>
        </template>
        <label class="flex items-start gap-2 border-t border-border pt-2.5 text-xs">
          <input v-model="showLinks" type="checkbox" class="mt-0.5 accent-primary" />
          {{ t('book.detail.storyGuideTab.toggleLinks') }}
        </label>
      </aside>
    </div>
  </div>
</template>
