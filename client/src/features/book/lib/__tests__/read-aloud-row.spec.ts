import { describe, expect, it } from 'vitest'
import { buildReadAloudRow, type ReadAloudCreateJob, type ReadAloudCreateSlot } from '../read-aloud-row'
import { fakeT as t } from './sync-fixtures'

const RA = 'book.detail.files.readAloud.'
const ROW = 'book.detail.editionLink.readAloud.'

function slot(overrides: Partial<ReadAloudCreateSlot> = {}): ReadAloudCreateSlot {
  return { entry: { kind: 'available' }, job: null, pending: null, errorKey: null, ...overrides }
}

function job(overrides: Partial<ReadAloudCreateJob> = {}): ReadAloudCreateJob {
  return {
    status: 'processing',
    stage: 'aligning',
    progress: 42.4,
    queuePosition: null,
    stopping: false,
    canCancel: true,
    canRetry: true,
    errorKey: null,
    ...overrides,
  }
}

describe('buildReadAloudRow', () => {
  it('offers Create and Options while nothing is made yet', () => {
    expect(buildReadAloudRow(slot(), t)).toEqual({
      variant: 'notCreated',
      status: { text: `${ROW}notCreated`, tone: 'muted', spinner: false, issue: null },
      create: true,
      review: false,
      pending: null,
    })
  })

  it('shows a failed start as a destructive problem beside Create', () => {
    const row = buildReadAloudRow(slot({ errorKey: `${RA}errors.createConflict` }), t)
    expect(row?.create).toBe(true)
    expect(row?.status.text).toBe(`${ROW}failed`)
    expect(row?.status.tone).toBe('destructive')
    expect(row?.status.issue).toEqual({
      tone: 'destructive',
      icon: 'alert',
      title: `${ROW}failed`,
      detail: `${RA}errors.createConflict`,
      actions: [],
    })
  })

  it('hides itself when upstream hides its entry or a job is active elsewhere', () => {
    expect(buildReadAloudRow(slot({ entry: { kind: 'hidden' } }), t)).toBeNull()
    expect(buildReadAloudRow(slot({ entry: { kind: 'loadFailed' } }), t)).toBeNull()
    expect(buildReadAloudRow(slot({ entry: { kind: 'unavailable', reason: 'job_active', reasonKey: `${RA}reasons.job_active` } }), t)).toBeNull()
  })

  it('shows a lock reason muted, with the explanation behind an info icon when it is long', () => {
    const long = buildReadAloudRow(
      slot({ entry: { kind: 'unavailable', reason: 'worker_unavailable', reasonKey: `${RA}reasons.worker_unavailable` } }),
      t,
    )
    expect(long?.variant).toBe('unavailable')
    expect(long?.status).toMatchObject({ text: `${RA}reasons.worker_unavailable`, tone: 'muted' })
    expect(long?.status.issue).toMatchObject({ tone: 'info', title: `${ROW}unavailable`, detail: `${RA}reasons.worker_unavailable` })

    const short = buildReadAloudRow(slot({ entry: { kind: 'unavailable', reason: 'no_epub', reasonKey: 'short' } }), t)
    expect(short?.status.issue).toBeNull()
  })

  it('spins with the stage and percent while processing, with Cancel behind a clock', () => {
    const row = buildReadAloudRow(slot({ job: job() }), t)
    expect(row?.variant).toBe('processing')
    expect(row?.status.spinner).toBe(true)
    expect(row?.status.text).toMatch(
      /^book\.detail\.editionLink\.readAloud\.running\{"stage":"book\.detail\.files\.readAloud\.stages\.aligning","percent":"42\s?%"\}$/,
    )
    expect(row?.status.issue).toMatchObject({ tone: 'info', icon: 'clock', actions: [{ id: 'cancel', label: `${RA}job.cancel` }] })
    expect(row?.create).toBe(false)
  })

  it('words the queue, a stop in flight, and drops Cancel when it cannot cancel', () => {
    expect(buildReadAloudRow(slot({ job: job({ status: 'queued' }) }), t)?.status.text).toBe(`${RA}job.queuedTitle`)
    expect(buildReadAloudRow(slot({ job: job({ status: 'queued', queuePosition: 2 }) }), t)?.status.text).toBe(`${RA}job.queueAhead{"count":2}`)
    const stopping = buildReadAloudRow(slot({ job: job({ stopping: true }) }), t)
    expect(stopping?.status.text).toBe(`${RA}job.stoppingTitle`)
    expect(stopping?.status.issue).toBeNull()
    expect(buildReadAloudRow(slot({ job: job({ canCancel: false }) }), t)?.status.issue).toBeNull()
  })

  it('locks the actions while a job action is in flight', () => {
    const row = buildReadAloudRow(slot({ job: job(), pending: 'cancel' }), t)
    expect(row?.pending).toBe('cancel')
    expect(row?.status.issue?.actions[0]?.disabled).toBe(true)
  })

  it('offers Review for a job waiting for review', () => {
    const row = buildReadAloudRow(slot({ job: job({ status: 'awaiting_review' }) }), t)
    expect(row).toMatchObject({ variant: 'review', review: true, status: { text: `${ROW}readyToReview`, issue: null } })
  })

  it('shows a failed job with upstream’s error, Retry while retryable, and the job details', () => {
    const row = buildReadAloudRow(slot({ job: job({ status: 'failed', errorKey: `${RA}errors.job.alignment_failed` }) }), t)
    expect(row?.status.text).toBe(`${ROW}failed`)
    expect(row?.status.issue).toMatchObject({ tone: 'destructive', icon: 'alert', detail: `${RA}errors.job.alignment_failed` })
    expect(row?.status.issue?.actions.map((a) => a.id)).toEqual(['retry', 'review'])

    const spent = buildReadAloudRow(slot({ job: job({ status: 'failed', canRetry: false, errorKey: null }) }), t)
    expect(spent?.status.issue?.detail).toBe(`${RA}errors.job.unknown`)
    expect(spent?.status.issue?.actions.map((a) => a.id)).toEqual(['review'])
  })
})
