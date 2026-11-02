import type { EditionSyncAdminStatus, EditionSyncBookListItem, EditionSyncBookListResponse } from '@bookorbit/types'

export function bookItem(overrides: Partial<EditionSyncBookListItem> = {}): EditionSyncBookListItem {
  return {
    bookId: 7,
    title: 'Wind and Truth',
    coverVersion: 'v2',
    formats: ['m4b', 'epub'],
    syncEnabled: true,
    syncOverride: null,
    status: 'ready',
    stage: null,
    progress: null,
    indexedAt: '2026-11-01T02:00:00.000Z',
    error: null,
    errorCode: null,
    attemptCount: 0,
    lastAttemptAt: null,
    invalidatedReason: null,
    queuePosition: null,
    sentences: null,
    matchedSentences: null,
    workerVersion: null,
    indexBytes: null,
    whisperFallback: false,
    canRunNow: false,
    canRetry: false,
    ...overrides,
  }
}

export function listResponse(overrides: Partial<EditionSyncBookListResponse> = {}): EditionSyncBookListResponse {
  return {
    items: [bookItem()],
    total: 1,
    page: 1,
    pageSize: 50,
    counts: { all: 1, problems: 0, queued: 0, synced: 1, off: 0 },
    disabledReason: null,
    ...overrides,
  }
}

export function adminStatus(overrides: Partial<EditionSyncAdminStatus> = {}): EditionSyncAdminStatus {
  return {
    worker: { configured: true, state: 'ok', version: '1.4.0', device: 'cpu', rebuildSupported: true },
    schedule: { enabled: true, cronExpression: '0 2 * * *', runHours: 8, onFilesChanged: 'next_run', updatedAt: null, nextRunAt: null },
    run: { active: false, trigger: null, startedAt: null, windowUntil: null, current: null },
    lastRun: null,
    counts: { indexed: 1, queued: 2, failed: 0, stale: 0, unusedIndexes: 1, unusedBytes: 100 },
    backlogEstimate: { books: 0, hoursAtRecentRate: null },
    ...overrides,
  }
}
