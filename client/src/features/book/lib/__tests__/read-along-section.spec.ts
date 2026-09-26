// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReadAlongPhase, ReadAlongStatus } from '@bookorbit/types'
import { isActionBlocked, resolveReadAlongSectionState, stageIndex } from '../read-along-section'

function state(status: ReadAlongStatus, hasOutputBook = false) {
  return { status, hasOutputBook }
}

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

describe('resolveReadAlongSectionState', () => {
  it('is always ready on the read-along book itself', () => {
    expect(resolveReadAlongSectionState('readOnly', state('none'), false, false, false)).toBe('ready')
  })

  it('offers a build only while the toggle is on and usable', () => {
    expect(resolveReadAlongSectionState('offer', state('ready'), true, true, false)).toBe('offerOn')
    expect(resolveReadAlongSectionState('offer', state('none'), false, true, true)).toBe('offerOff')
    expect(resolveReadAlongSectionState('offer', state('none'), false, false, false)).toBe('offerOff')
  })

  it.each([
    ['building', false, false, 'building'],
    ['failed', false, false, 'failed'],
    ['none', false, false, 'none'],
    ['ready', true, false, 'ready'],
    ['ready', false, true, 'ready'],
    ['ready', false, false, 'outOfReach'],
  ] as [ReadAlongStatus, boolean, boolean, string][])(
    'manages status %s (member %s, output book %s) as %s',
    (status, hasMember, hasOutputBook, expected) => {
      expect(resolveReadAlongSectionState('manage', state(status, hasOutputBook), hasMember, false, false)).toBe(expected)
    },
  )
})

describe('isActionBlocked', () => {
  it('lets a busy Storyteller be retried and disables every other block', () => {
    expect(isActionBlocked(null)).toBe(false)
    expect(isActionBlocked('busy')).toBe(false)
    expect(isActionBlocked('unreachable')).toBe(true)
    expect(isActionBlocked('previous_output_not_deletable')).toBe(true)
  })
})
