import { ref } from 'vue'
import type { EditionLinkScanStatus } from '@bookorbit/types'
import { getActiveMatchScan } from '../api/work'

/** The latest scan's counts, for the settings page's "Matching" row. */
export function useEditionLinkScanSummary() {
  const status = ref<EditionLinkScanStatus | null>(null)

  async function fetchStatus(): Promise<void> {
    try {
      status.value = await getActiveMatchScan()
    } catch {
      status.value = null
    }
  }

  return { status, fetchStatus }
}
