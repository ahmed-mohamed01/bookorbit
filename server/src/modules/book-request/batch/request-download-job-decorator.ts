import type { RequestDownloadJobRow } from '../request-download-job-source';

export const REQUEST_DOWNLOAD_JOB_DECORATOR = Symbol('REQUEST_DOWNLOAD_JOB_DECORATOR');

/**
 * Optional fork step inside `RequestDownloadJobSource.list`: adjusts the listed items of a page in
 * one batch. It never touches the job row, so status, cursor keys and actions stay upstream's.
 */
export interface RequestDownloadJobDecorator {
  decorate(rows: RequestDownloadJobRow[]): Promise<RequestDownloadJobRow[]>;
}
