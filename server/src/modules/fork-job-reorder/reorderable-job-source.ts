import type { JobReorderRequest, JobReorderResult } from '@bookorbit/types';

import type { JobSource, JobViewer, SourceRow } from '../jobs/job-source';

export interface ReorderableJobSource<Row extends SourceRow = SourceRow> extends JobSource<Row> {
  reorderTo(nativeId: string, targetNativeId: string, place: JobReorderRequest['place'], viewer: JobViewer): Promise<JobReorderResult>;
}

export function isReorderableJobSource(source: JobSource): source is ReorderableJobSource {
  return 'reorderTo' in source && typeof source.reorderTo === 'function';
}
