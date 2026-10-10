// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReadAlongPhase, ReadAlongStatus } from '@bookorbit/types'
import { isActionBlocked, isReadAlongInFlight, readAlongPercent, readAlongSteps, stageIndex } from '../read-along-section'

describe('stageIndex', () => {
  it.each([
    [null, null, 0],
    ['prepare', null, 0],
    ['register', null, 0],
    ['process', 'SPLIT_TRACKS', 0],
    ['wait', 'SPLIT_TRACKS', 1],
    ['wait', 'TRANSCRIBE_CHAPTERS', 1],
    ['wait', null, 1],
    ['wait', 'sync_chapters', 2],
    ['collect', null, 3],
    ['link', 'SYNC_CHAPTERS', 3],
  ] as [ReadAlongPhase | null, string | null, number][])('places phase %s with task %s at stage %i', (phase, task, expected) => {
    expect(stageIndex(phase, task)).toBe(expected)
  })
})

describe('isActionBlocked', () => {
  it('lets a busy Storyteller be retried and disables every other block', () => {
    expect(isActionBlocked(null)).toBe(false)
    expect(isActionBlocked('busy')).toBe(false)
    expect(isActionBlocked('unreachable')).toBe(true)
    expect(isActionBlocked('previous_output_not_deletable')).toBe(true)
  })
})

describe('isReadAlongInFlight', () => {
  it.each([
    ['queued', true],
    ['building', true],
    ['ready', false],
    ['failed', false],
    ['none', false],
  ] as [ReadAlongStatus, boolean][])('treats %s as in flight: %s', (status, expected) => {
    expect(isReadAlongInFlight(status)).toBe(expected)
  })
})

describe('readAlongSteps', () => {
  it('marks the stages before, at and after the current one', () => {
    expect(readAlongSteps(1).map((step) => step.state)).toEqual(['done', 'current', 'todo', 'todo'])
    expect(readAlongSteps(1)[0]?.key).toBe('book.detail.editionLink.readAlong.stages.sending')
  })
})

describe('readAlongPercent', () => {
  it("reports Storyteller's progress only while it transcribes or aligns", () => {
    expect(readAlongPercent(1, 0.426)).toBe(43)
    expect(readAlongPercent(2, 1.4)).toBe(100)
    expect(readAlongPercent(0, 0.5)).toBeNull()
    expect(readAlongPercent(1, null)).toBeNull()
  })
})
