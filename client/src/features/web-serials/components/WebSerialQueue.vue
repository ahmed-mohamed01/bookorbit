<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, PauseCircle, TriangleAlert } from '@lucide/vue'
import { Permission } from '@bookorbit/types'
import type { WebSerialJob, WebSerialJobItem, WebSerialJobScope } from '@bookorbit/types'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { formatNumber } from '@/i18n/formatters'
import type { SerialJobDetailState } from '../composables/useWebSerialQueue'
import type { SerialJobAction } from '../lib/serialJobStatus'
import { isFinishedJob } from '../lib/serialJobStatus'
import { groupSerialJobs } from '../lib/serialPresentation'
import WebSerialJobRow from './WebSerialJobRow.vue'
import WebSerialQueueToolbar from './WebSerialQueueToolbar.vue'

const props = defineProps<{
  jobs: WebSerialJob[]
  loading: boolean
  loaded: boolean
  error: string | null
  busyIds: ReadonlySet<number>
  scope: WebSerialJobScope
  queuePaused: boolean
  clearing: boolean
  queueBusy: boolean
  expandedIds: ReadonlySet<number>
  details: Readonly<Record<number, SerialJobDetailState>>
  hasMore?: boolean
  finishedCount?: number
  loadingMore?: boolean
  /** The signed-in user, so removing someone else's download names its owner in the confirm. */
  userId?: number | null
}>()
const emit = defineEmits<{
  action: [type: SerialJobAction, id: number]
  toggle: [id: number]
  retryItem: [jobId: number, itemId: number]
  'update:scope': [scope: WebSerialJobScope]
  clearFinished: []
  togglePause: []
  discover: []
  reload: []
  loadMore: []
}>()

const { t } = useI18n()
const { hasPermission } = usePermissions()
const isAdmin = computed(() => hasPermission(Permission.ManageAppSettings))
const groups = computed(() => groupSerialJobs(props.jobs))
const finishedCount = computed(() => props.finishedCount ?? props.jobs.filter(isFinishedJob).length)
const confirmOpen = ref(false)
const showToolbar = computed(() => props.loaded && (props.jobs.length > 0 || isAdmin.value))
// Cancelling cannot be undone and removing drops the job's history, so both wait for a confirm.
const pendingAction = ref<{ type: 'cancel' | 'remove'; job: WebSerialJob } | null>(null)
const pendingOwner = computed(() => {
  const job = pendingAction.value?.job
  return job?.owner && job.owner.id !== props.userId ? job.owner.name : null
})
const pendingDialog = computed(() => {
  const pending = pendingAction.value
  if (!pending) return { title: '', description: '', confirm: '' }
  const title = pending.job.title
  if (pending.type === 'cancel') {
    return {
      title: t('webSerials.queue.cancelDialog.title'),
      description: pendingOwner.value
        ? t('webSerials.queue.cancelDialog.descriptionOther', { title, owner: pendingOwner.value })
        : t('webSerials.queue.cancelDialog.description', { title }),
      confirm: t('webSerials.queue.cancelDialog.confirm'),
    }
  }
  return {
    title: t('webSerials.queue.removeDialog.title'),
    description: pendingOwner.value
      ? t('webSerials.queue.removeDialog.descriptionOther', { title, owner: pendingOwner.value })
      : t('webSerials.queue.removeDialog.description', { title }),
    confirm: t('webSerials.queue.actions.remove'),
  }
})

function handleAction(type: SerialJobAction, job: WebSerialJob) {
  if (type === 'cancel' || type === 'remove') {
    pendingAction.value = { type, job }
    return
  }
  emit('action', type, job.id)
}

function handleActionConfirm() {
  const pending = pendingAction.value
  pendingAction.value = null
  if (pending) emit('action', pending.type, pending.job.id)
}

function handleActionCancel() {
  pendingAction.value = null
}

function handleToggle(job: WebSerialJob) {
  emit('toggle', job.id)
}

function handleRetryItem(job: WebSerialJob, item: WebSerialJobItem) {
  emit('retryItem', job.id, item.id)
}

function handleScope(scope: WebSerialJobScope) {
  emit('update:scope', scope)
}

function handleTogglePause() {
  emit('togglePause')
}

function handleClearRequest() {
  confirmOpen.value = true
}

function handleClearCancel() {
  confirmOpen.value = false
}

function handleClearConfirm() {
  confirmOpen.value = false
  emit('clearFinished')
}

function handleDiscover() {
  emit('discover')
}

function handleLoadMore() {
  emit('loadMore')
}

function handleReload() {
  emit('reload')
}
</script>

<template>
  <div class="space-y-5">
    <WebSerialQueueToolbar
      v-if="showToolbar"
      :is-admin="isAdmin"
      :scope="scope"
      :queue-paused="queuePaused"
      :finished-count="finishedCount"
      :clearing="clearing"
      :queue-busy="queueBusy"
      @update:scope="handleScope"
      @clear="handleClearRequest"
      @toggle-pause="handleTogglePause"
    />
    <p v-if="queuePaused" role="status" class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
      <PauseCircle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {{ t('webSerials.queue.queuePausedBanner') }}
    </p>
    <div v-if="loading && !loaded" class="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      {{ t('webSerials.queue.loading') }}
    </div>

    <EmptyState v-else-if="error && !loaded" icon="TriangleAlert" :title="t('webSerials.queue.loadErrorTitle')" :hint="error">
      <template #actions>
        <Button variant="outline" size="sm" @click="handleReload">{{ t('webSerials.queue.reload') }}</Button>
      </template>
    </EmptyState>

    <EmptyState v-else-if="jobs.length === 0" icon="Download" :title="t('webSerials.queue.emptyTitle')" :hint="t('webSerials.queue.emptyBody')">
      <template #actions>
        <Button variant="outline" @click="handleDiscover">{{ t('webSerials.queue.emptyAction') }}</Button>
      </template>
    </EmptyState>

    <template v-else>
      <p v-if="error" role="alert" class="flex items-center gap-2 text-xs text-destructive">
        <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
        {{ error }}
      </p>
      <section v-for="group in groups" :key="group.key">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-xs font-semibold text-foreground">{{ t(`webSerials.queue.groups.${group.key}`) }}</h2>
          <span class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground tabular-nums">
            {{ formatNumber(group.jobs.length) }}
          </span>
          <div class="h-px flex-1 bg-border" />
        </div>
        <ul class="space-y-2" :aria-label="t(`webSerials.queue.groups.${group.key}`)">
          <WebSerialJobRow
            v-for="job in group.jobs"
            :key="job.id"
            :job="job"
            :busy="busyIds.has(job.id)"
            :expanded="expandedIds.has(job.id)"
            :detail="details[job.id]"
            @action="handleAction"
            @toggle="handleToggle"
            @retry-item="handleRetryItem"
          />
        </ul>
      </section>
      <div v-if="hasMore" class="flex justify-center">
        <Button variant="outline" size="sm" :disabled="loadingMore" @click="handleLoadMore">
          <Loader2 v-if="loadingMore" class="animate-spin" aria-hidden="true" />
          {{ t('webSerials.queue.loadMore') }}
        </Button>
      </div>
    </template>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('webSerials.queue.clearDialog.title')"
      :description="t(scope === 'all' ? 'webSerials.queue.clearDialog.descriptionAll' : 'webSerials.queue.clearDialog.description')"
      :confirm-label="t('webSerials.queue.toolbar.clearFinished')"
      @confirm="handleClearConfirm"
      @cancel="handleClearCancel"
    />

    <ConfirmDialog
      :open="pendingAction !== null"
      :title="pendingDialog.title"
      :description="pendingDialog.description"
      :confirm-label="pendingDialog.confirm"
      @confirm="handleActionConfirm"
      @cancel="handleActionCancel"
    />
  </div>
</template>
