import { ref } from 'vue'
import { api } from '@/lib/api'
import { fulfilmentBase } from '../fulfilmentBase'
import type { BatchUnitView, CreateBatchGrabPayload } from '@bookorbit/types'

async function failureMessage(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null
  const message = Array.isArray(body?.message) ? body.message[0] : body?.message
  return message ?? null
}

export function useBatchGrab(canManage: () => boolean) {
  const sending = ref(false)
  const error = ref<string | null>(null)
  const retrying = ref(false)

  async function send(payload: CreateBatchGrabPayload): Promise<number | null> {
    if (sending.value) return null
    sending.value = true
    error.value = null
    try {
      const body: CreateBatchGrabPayload = {
        sourceRequestId: payload.sourceRequestId,
        indexerId: payload.indexerId,
        releaseGuid: payload.releaseGuid,
        downloadClientId: payload.downloadClientId,
        unitIndexes: payload.unitIndexes,
      }
      const res = await api(`${fulfilmentBase(canManage())}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        error.value = (await failureMessage(res)) ?? ''
        return null
      }
      return ((await res.json()) as { requestId: number }).requestId
    } catch {
      error.value = ''
      return null
    } finally {
      sending.value = false
    }
  }

  /** Resolves to the server's reason when the retry was refused, or null once it was accepted. */
  async function retry(requestId: number): Promise<string | null> {
    if (retrying.value) return null
    retrying.value = true
    try {
      const res = await api(`${fulfilmentBase(canManage())}/batch/${requestId}/retry`, { method: 'POST' })
      return res.ok ? null : ((await failureMessage(res)) ?? '')
    } catch {
      return ''
    } finally {
      retrying.value = false
    }
  }

  async function fetchUnits(requestId: number): Promise<BatchUnitView[]> {
    try {
      const res = await api(`${fulfilmentBase(canManage())}/batch/${requestId}/units`)
      if (!res.ok) return []
      return (await res.json()) as BatchUnitView[]
    } catch {
      return []
    }
  }

  return { sending, error, retrying, send, retry, fetchUnits }
}
