import type { JobReorderRequest, JobReorderResult } from '@bookorbit/types'

import { apiJson, jsonBody } from '@/lib/api-json'

export function reorderJob(request: JobReorderRequest): Promise<JobReorderResult> {
  return apiJson('/api/v1/fork/jobs/reorder', jsonBody('POST', request), 'jobsArea.actionFailed')
}
