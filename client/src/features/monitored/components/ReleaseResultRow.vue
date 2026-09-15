<script setup lang="ts">
import { computed } from 'vue'
import { Check, Download, Globe, Loader2, Magnet, Newspaper } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { DownloadDelivery, ReleaseCandidateItem } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { protocolChipClass } from '@/features/book-requests/sourceColors'
import { formatBytes } from '@/lib/formatting'
import { formatDate, formatLanguageName } from '@/i18n/formatters'

const props = defineProps<{
  release: ReleaseCandidateItem
  /** What grabbing this release will do, stated by the indexer it came from. */
  delivery: DownloadDelivery
  busy?: boolean
  grabbed?: boolean
  /** Renders the `expansion` slot under the row, for the request this release is downloading under. */
  expanded?: boolean
}>()
const emit = defineEmits<{ grab: [release: ReleaseCandidateItem] }>()
const { t } = useI18n()

/** Rank has to read before the number does, so the score carries a band colour. */
const scoreClass = computed(() => {
  const score = props.release.score
  if (score >= 70) return 'text-success'
  if (score >= 55) return 'text-info'
  if (score >= 40) return 'text-warning'
  return 'text-muted-foreground'
})

const scoreSurfaceClass = computed(() => {
  const score = props.release.score
  if (score >= 70) return 'border-success/45 bg-success/10'
  if (score >= 55) return 'border-info/45 bg-info/10'
  if (score >= 40) return 'border-warning/45 bg-warning/10'
  return 'border-border bg-muted'
})

const protocolClass = computed(() => protocolChipClass(props.delivery))

const protocolText = computed(() => t(`bookRequests.releases.protocol.${props.delivery === 'file' ? 'directPill' : props.delivery}`))

/** Only a swarm has a position to report, "unknown" included; a file source has nothing to be unknown about. */
const showsSeeders = computed(() => props.delivery === 'torrent')

const seederText = computed(() =>
  props.release.seeders === null
    ? t('bookRequests.releases.seederCountUnknown')
    : t('bookRequests.releases.seederCountPlural', { count: props.release.seeders }),
)

/** The facts that separate this release from its neighbours, as one ordered run. */
const metaFacts = computed<string[]>(() => {
  const facts: string[] = []
  if (props.release.language) facts.push(formatLanguageName(props.release.language))
  if (props.release.formats.length > 0) facts.push(props.release.formats.map((value) => value.toUpperCase()).join(' + '))
  if (props.release.sizeBytes) facts.push(formatBytes(props.release.sizeBytes))
  if (props.release.fileCount !== null) facts.push(t('bookRequests.releases.fileCount', { count: props.release.fileCount }))
  if (showsSeeders.value) facts.push(seederText.value)
  if (props.release.publishedAt) facts.push(formatDate(new Date(props.release.publishedAt)))
  return facts
})

function handleGrab() {
  emit('grab', props.release)
}
</script>

<template>
  <li
    class="rounded-xl border bg-card p-3 transition-colors motion-reduce:transition-none"
    :class="expanded ? 'border-primary/45 bg-primary/5' : 'border-border hover:bg-accent/50'"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-3">
      <div class="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <span
          class="flex size-11 shrink-0 items-center justify-center rounded-lg border text-[15px] font-semibold tabular-nums"
          :class="[scoreClass, scoreSurfaceClass]"
        >
          <span aria-hidden="true">{{ release.score }}</span>
          <span class="sr-only">{{ t('bookRequests.releases.scoreLabel', { score: release.score }) }}</span>
        </span>

        <div class="min-w-0 flex-1">
          <p class="line-clamp-2 text-sm font-medium text-foreground">{{ release.title }}</p>

          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium" :class="protocolClass">
              <Magnet v-if="delivery === 'torrent'" :size="11" aria-hidden="true" />
              <Newspaper v-else-if="delivery === 'usenet'" :size="11" aria-hidden="true" />
              <Globe v-else :size="11" aria-hidden="true" />
              {{ protocolText }}
            </span>
            <span class="rounded-full border border-border px-1.5 py-px font-medium text-muted-foreground">{{ release.indexerName }}</span>
            <span v-if="release.tierName" class="rounded-full border border-primary/45 bg-primary/10 px-1.5 py-px font-medium text-primary">
              {{ release.tierName }}
            </span>
            <span v-if="release.freeleech" class="rounded-full border border-success/40 bg-success/10 px-1.5 py-px font-medium text-success">
              {{ t('bookRequests.releases.freeleech') }}
            </span>
            <span v-if="release.vipOnly" class="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px font-medium text-warning">
              {{ t('bookRequests.releases.vipOnly') }}
            </span>
            <span v-if="release.alreadyGrabbed" class="rounded-full border border-border bg-muted px-1.5 py-px font-medium text-muted-foreground">
              {{ t('bookRequests.releases.alreadyGrabbed') }}
            </span>
          </div>

          <div v-if="metaFacts.length" class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <template v-for="(fact, factIndex) in metaFacts" :key="fact">
              <span v-if="factIndex > 0" aria-hidden="true">&middot;</span>
              <span class="tabular-nums">{{ fact }}</span>
            </template>
          </div>
        </div>
      </div>

      <div class="ms-auto flex items-center gap-1.5">
        <Button size="sm" :variant="grabbed ? 'outline' : 'default'" :disabled="busy || grabbed" @click="handleGrab">
          <Loader2 v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />
          <Check v-else-if="grabbed" :size="14" aria-hidden="true" />
          <Download v-else :size="14" aria-hidden="true" />
          {{ grabbed ? t('monitored.detail.badges.queued') : t('monitored.panel.grab') }}
        </Button>
      </div>
    </div>

    <div v-if="expanded" class="mt-3">
      <slot name="expansion" />
    </div>
  </li>
</template>
