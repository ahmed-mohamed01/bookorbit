import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { JobListItem, JobReorderRequest } from '@bookorbit/types'

import { errorMessage } from '@/lib/api-json'
import { reorderJob } from '../api/job-reorder.api'
import { isEditionSyncDropAnchor, isJobMove } from '../lib/job-reorder'

const HANDLE = '[data-job-reorder-handle]'
const ROW = 'tr[data-job-id]'
const DRAG_DISTANCE = 4
const SCROLL_EDGE = 56
const END_SLOT_HEIGHT = 8

interface DropSlot {
  targetId: string
  place: JobReorderRequest['place']
  line: { top: number; left: number; width: number }
}

export interface JobDragPreviewState {
  item: JobListItem
  top: number
  left: number
  width: number
  offsetX: number
  offsetY: number
}

function allowsDrop(item: JobListItem, place: JobReorderRequest['place']): boolean {
  if (item.type !== 'edition-sync') return true
  return item.kind !== 'backlog' && (item.kind !== 'backlog-head' || place === 'before')
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

export function useJobRowDrag(jobs: {
  items: { readonly value: readonly JobListItem[] }
  acting: { readonly value: unknown }
  load: (counts: boolean) => Promise<void>
}) {
  const { t } = useI18n()
  const table = ref<HTMLElement | null>(null)
  const dragging = ref<string | null>(null)
  const saving = ref(false)
  const busy = computed(() => saving.value || jobs.acting.value !== null)
  const reorderable = computed(() => jobs.items.value.filter((item) => item.actions.some(isJobMove)))
  const showReorder = computed(() => reorderable.value.length > 0)
  const drop = shallowRef<DropSlot | null>(null)
  const line = computed(() => drop.value?.line ?? null)
  const preview = shallowRef<JobDragPreviewState | null>(null)
  let pointer: {
    id: number
    handle: HTMLElement
    item: JobListItem
    x: number
    y: number
    startX: number
    startY: number
    row: DOMRect
    scroll: HTMLElement | null
  } | null = null
  let frame = 0

  function rowFor(id: string): HTMLElement | null | undefined {
    return table.value?.querySelector<HTMLElement>(`${ROW}[data-job-id="${CSS.escape(id)}"]`)
  }

  function findDrop(): DropSlot | null {
    if (!pointer || !table.value) return null
    const { x, y, item, scroll } = pointer
    const viewport = scroll?.getBoundingClientRect()
    if (y < (viewport?.top ?? 0) || y >= Math.min(viewport?.bottom ?? window.innerHeight, window.innerHeight)) return null

    const lane = jobs.items.value.filter(
      (candidate) => candidate.type === item.type && (candidate.actions.some(isJobMove) || isEditionSyncDropAnchor(candidate)),
    )
    const hit = document.elementFromPoint(x, y)
    let row = hit?.closest<HTMLElement>(ROW)
    if (!row) {
      const last = lane.at(-1)
      if (!last || hit?.closest('tr')) return null
      row = rowFor(last.id)
      const rect = row?.getBoundingClientRect()
      if (!rect || x < rect.left || x > rect.right || y < rect.bottom || y > rect.bottom + END_SLOT_HEIGHT) return null
    }
    if (!row || !table.value.contains(row)) return null
    const targetIndex = lane.findIndex((candidate) => candidate.id === row.dataset.jobId)
    const ownIndex = lane.findIndex((candidate) => candidate.id === item.id)
    if (targetIndex < 0 || ownIndex < 0 || targetIndex === ownIndex) return null
    const rect = row.getBoundingClientRect()
    const before = y < (rect.top + rect.bottom) / 2
    const slot = targetIndex + (before ? 0 : 1)
    if (slot === ownIndex || slot === ownIndex + 1) return null

    let target = lane[targetIndex]!
    let place: JobReorderRequest['place'] = before ? 'before' : 'after'
    if (!allowsDrop(target, place)) return null
    const next = lane[slot]
    if (item.type === 'edition-sync' && !before && next && allowsDrop(next, 'before')) {
      target = next
      place = 'before'
    }
    return { targetId: target.id, place, line: { top: before ? rect.top : rect.bottom, left: rect.left, width: rect.width } }
  }

  function scrollFrame() {
    frame = 0
    if (!pointer || !dragging.value) return
    const { item, y, startX, startY, row, scroll } = pointer
    const offsetY = startY - row.top
    preview.value = { item, top: y - offsetY, left: row.left, width: row.width, offsetX: startX - row.left, offsetY }
    const bounds = scroll?.getBoundingClientRect()
    const top = Math.max(0, bounds?.top ?? 0)
    const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)
    const up = Math.max(0, 1 - (y - top) / SCROLL_EDGE)
    const down = Math.max(0, 1 - (bottom - y) / SCROLL_EDGE)
    const delta = Math.max(-20, Math.min(20, (down - up) * 20))
    if (delta !== 0) {
      const scroller = scroll ?? window
      scroller.scrollBy({ top: delta, behavior: 'instant' })
      frame = requestAnimationFrame(scrollFrame)
    }
    drop.value = findDrop()
  }

  function handlePointerMove(event: PointerEvent) {
    if (!pointer || event.pointerId !== pointer.id) return
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (!dragging.value && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < DRAG_DISTANCE) return
    dragging.value = pointer.item.id
    if (event.cancelable) event.preventDefault()
    if (!frame) frame = requestAnimationFrame(scrollFrame)
  }

  function cancel() {
    const active = pointer
    pointer = null
    if (active?.handle.hasPointerCapture?.(active.id)) active.handle.releasePointerCapture(active.id)
    dragging.value = null
    drop.value = null
    preview.value = null
    cancelAnimationFrame(frame)
    frame = 0
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
    document.removeEventListener('pointercancel', handlePointerCancel)
    document.removeEventListener('keydown', handleEscape, true)
    window.removeEventListener('blur', cancel)
  }

  function handlePointerCancel(event: PointerEvent) {
    if (pointer?.id === event.pointerId) cancel()
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  async function handlePointerUp(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return
    pointer.x = event.clientX
    pointer.y = event.clientY
    const id = dragging.value
    const slot = id && !busy.value ? findDrop() : null
    cancel()
    if (!id || !slot) return

    saving.value = true
    try {
      const result = await reorderJob({ id, targetId: slot.targetId, place: slot.place })
      if (result.outcome === 'done') toast.success(t('jobsArea.reorderResult', { count: 1 }))
      else toast.warning(t('aiArea.activity.results.unchanged', { count: 1 }))
    } catch (reason) {
      toast.error(errorMessage(reason, 'jobsArea.actionFailed'))
    } finally {
      try {
        await jobs.load(true)
      } finally {
        saving.value = false
      }
    }
  }

  function handlePointerDown(event: PointerEvent) {
    if (busy.value || pointer || event.button !== 0 || !table.value || !(event.target instanceof Element)) return
    const handle = event.target.closest<HTMLElement>(HANDLE)
    if (!handle) return
    const row = handle.closest<HTMLElement>(ROW)
    const item = reorderable.value.find((entry) => entry.id === row?.dataset.jobId)
    if (!row || !item) return
    handle.setPointerCapture?.(event.pointerId)
    pointer = {
      id: event.pointerId,
      handle,
      item,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      row: row.getBoundingClientRect(),
      scroll: scrollParent(table.value),
    }
    document.addEventListener('pointermove', handlePointerMove, { passive: false })
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    document.addEventListener('keydown', handleEscape, true)
    window.addEventListener('blur', cancel)
  }

  async function keepHandleFocus(id: string, run: () => Promise<void>) {
    if (busy.value) return
    const handle = rowFor(id)?.querySelector<HTMLButtonElement>(HANDLE)
    const focused = handle === document.activeElement
    await run()
    await nextTick()
    if (focused && document.activeElement === document.body) rowFor(id)?.querySelector<HTMLButtonElement>(HANDLE)?.focus({ preventScroll: true })
  }

  watch(
    busy,
    (value) => {
      if (value) cancel()
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(cancel)
  return { table, dragging, busy, showReorder, line, preview, handlePointerDown, keepHandleFocus }
}
