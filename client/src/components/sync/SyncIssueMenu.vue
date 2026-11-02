<script setup lang="ts" generic="Id extends string = string">
import { computed, ref } from 'vue'
import { Clock, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SYNC_STATUS_TEXT_CLASS, type SyncIssueAction, type SyncIssueIcon, type SyncIssueTone } from '@/lib/sync-issue'

const props = withDefaults(
  defineProps<{
    tone: SyncIssueTone
    icon: SyncIssueIcon
    title: string
    detail?: string | null
    actions?: SyncIssueAction<Id>[]
    busy?: boolean
    /** Lets the host open the dropdown itself, such as a switch that needs a match first. */
    open?: boolean
    /** Id for the trigger, so a switch can point at the status it names via aria-describedby. */
    triggerId?: string
    /** The trigger's accessible name when the dropdown title can change, such as while searching. Defaults to the title. */
    label?: string
  }>(),
  { detail: null, actions: () => [], busy: false, open: undefined, triggerId: undefined, label: undefined },
)
const emit = defineEmits<{ action: [id: Id]; 'update:open': [value: boolean] }>()

const TRIGGER_CLASS: Record<SyncIssueTone, string> = {
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-muted-foreground',
}

const localOpen = ref(false)
const isOpen = computed(() => props.open ?? localOpen.value)

function setOpen(value: boolean) {
  localOpen.value = value
  emit('update:open', value)
}

function handleAction(action: SyncIssueAction<Id>) {
  emit('action', action.id)
  if (!action.keepOpen) setOpen(false)
}
</script>

<template>
  <Popover :open="isOpen" @update:open="setOpen">
    <PopoverTrigger as-child>
      <slot name="trigger">
        <button
          :id="triggerId"
          type="button"
          class="inline-flex size-6 shrink-0 items-center justify-center rounded-xs transition-colors hover:bg-muted"
          :class="TRIGGER_CLASS[tone]"
          :aria-label="label ?? title"
          :title="label ?? title"
          data-testid="sync-issue-trigger"
        >
          <Clock v-if="icon === 'clock'" class="size-3.5" aria-hidden="true" />
          <TriangleAlert v-else class="size-3.5" aria-hidden="true" />
        </button>
      </slot>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="w-68 max-w-[calc(100vw-2rem)] p-3"
      :aria-label="title"
      data-testid="sync-issue-content"
    >
      <div class="flex flex-col gap-1">
        <p class="text-[13px] font-semibold" :class="SYNC_STATUS_TEXT_CLASS[tone]" data-testid="sync-issue-title">{{ title }}</p>
        <p v-if="detail" class="text-xs leading-relaxed text-pretty break-words text-muted-foreground" data-testid="sync-issue-detail">
          {{ detail }}
        </p>
      </div>
      <slot />
      <div v-if="actions.length" class="mt-2.5 flex flex-wrap gap-1.5">
        <Button
          v-for="(action, index) in actions"
          :key="action.id"
          type="button"
          size="sm"
          :variant="index === 0 ? 'default' : 'outline'"
          class="h-7.5 flex-1 text-xs"
          :disabled="busy || action.disabled"
          :data-action="action.id"
          data-testid="sync-issue-action"
          @click="handleAction(action)"
        >
          {{ action.label }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
