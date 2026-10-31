import { describe, expect, it } from 'vitest'
import { currentUnitFraction, isActiveJob, jobActions, jobProgressPercent } from '../lib/serialJobStatus'
import { job } from './fixtures'

describe('serialJobStatus', () => {
  it('treats queued, running and importing as active', () => {
    expect(['queued', 'running', 'importing'].every((status) => isActiveJob(job({ status: status as never })))).toBe(true)
    expect(['completed', 'completed_with_gaps', 'failed', 'cancelled'].some((status) => isActiveJob(job({ status: status as never })))).toBe(false)
  })

  it('offers retry only for failed and gapped jobs', () => {
    expect(jobActions(job({ status: 'failed' }))).toContain('retry')
    expect(jobActions(job({ status: 'completed_with_gaps' }))).toContain('retry')
    expect(jobActions(job({ status: 'completed' }))).not.toContain('retry')
    expect(jobActions(job({ status: 'cancelled' }))).not.toContain('retry')
  })

  it('counts skipped units as progress', () => {
    expect(jobProgressPercent(job({ unitsTotal: 10, unitsDone: 3, unitsSkipped: 1 }))).toBe(40)
    expect(jobProgressPercent(job({ unitsTotal: 0, unitsDone: 0, unitsSkipped: 0 }))).toBe(0)
    expect(jobProgressPercent(job({ unitsTotal: 2, unitsDone: 5, unitsSkipped: 0 }))).toBe(100)
  })

  it('derives the current book fraction from chapter counts, then progress', () => {
    expect(currentUnitFraction({ chaptersDone: 1651, chaptersTotal: 2082, progress: 0.1 })).toBeCloseTo(0.793, 3)
    expect(currentUnitFraction({ chaptersDone: null, chaptersTotal: null, progress: 0.42 })).toBe(0.42)
    expect(currentUnitFraction({ chaptersDone: 5, chaptersTotal: 0, progress: null })).toBeNull()
    expect(currentUnitFraction({ chaptersDone: 9, chaptersTotal: 4, progress: null })).toBe(1)
  })

  it('offers the right actions for each status', () => {
    expect(jobActions(job({ status: 'running' }))).toEqual(['pause', 'cancel', 'move'])
    expect(jobActions(job({ status: 'importing' }))).toEqual(['pause', 'cancel', 'move'])
    expect(jobActions(job({ status: 'queued', queuePosition: 3, canMoveToTop: true }))).toEqual(['moveToTop', 'pause', 'cancel', 'move'])
    expect(jobActions(job({ status: 'queued', queuePosition: 1 }))).toEqual(['pause', 'cancel', 'move'])
    expect(jobActions(job({ status: 'paused' }))).toEqual(['resume', 'cancel', 'move'])
    expect(jobActions(job({ status: 'failed' }))).toEqual(['retry', 'move', 'remove'])
    expect(jobActions(job({ status: 'completed_with_gaps' }))).toEqual(['retry', 'move', 'remove'])
    expect(jobActions(job({ status: 'completed' }))).toEqual(['open', 'remove'])
    expect(jobActions(job({ status: 'cancelled' }))).toEqual(['remove'])
  })

  it('hides move to top when the server says this job already leads its permitted scope', () => {
    expect(jobActions(job({ status: 'queued', queuePosition: 3, canMoveToTop: false }))).not.toContain('moveToTop')
    expect(jobActions(job({ status: 'queued', queuePosition: 3, canMoveToTop: true }))).toContain('moveToTop')
  })

  it('offers a move only for manga jobs that still have chapters to download', () => {
    expect(jobActions(job({ kind: 'novel', status: 'running' }))).toEqual(['pause', 'cancel'])
    expect(jobActions(job({ kind: 'novel', status: 'failed' }))).toEqual(['retry', 'remove'])
    expect(jobActions(job({ kind: 'manga', status: 'completed' }))).not.toContain('move')
    expect(jobActions(job({ kind: 'manga', status: 'cancelled' }))).not.toContain('move')
  })

  it('does not treat a paused job as active', () => {
    expect(isActiveJob(job({ status: 'paused' }))).toBe(false)
  })
})
