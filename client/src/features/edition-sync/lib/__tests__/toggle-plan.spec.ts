import { describe, expect, it } from 'vitest'
import type { EditionSyncBookState } from '@bookorbit/types'
import { editionSyncToggleKind, editionSyncToggleValue, planEditionSyncToggle } from '../toggle-plan'

function state(editionCount: number, eligible: boolean, syncEnabled = false, extra: Partial<EditionSyncBookState> = {}): EditionSyncBookState {
  return { editionCount, eligible, syncEnabled, hasReadAlong: editionCount >= 3, hasAudio: true, ...extra } as EditionSyncBookState
}

describe('edition sync toggle plan', () => {
  it('classifies read-along, index-eligible and other books', () => {
    expect(editionSyncToggleKind(state(3, false))).toBe('readAlong')
    expect(editionSyncToggleKind(state(2, true))).toBe('index')
    expect(editionSyncToggleKind(state(2, false))).toBe('none')
    expect(editionSyncToggleKind(null)).toBe('none')
  })

  it('a read-along plus audio is the read-along kind even without a plain EPUB', () => {
    expect(editionSyncToggleKind(state(2, false, false, { hasReadAlong: true, hasAudio: true }))).toBe('readAlong')
    expect(editionSyncToggleKind(state(3, false, false, { hasReadAlong: true, hasAudio: false }))).toBe('none')
  })

  it('read-along books mirror and write the read-aloud sync mode', () => {
    const s = state(3, false)
    expect(editionSyncToggleValue('readAlong', s, 'auto')).toBe(true)
    expect(editionSyncToggleValue('readAlong', s, 'disabled')).toBe(false)
    expect(planEditionSyncToggle('readAlong', true, 'disabled')).toEqual({ setIndexOverride: false, setReadAloudMode: 'auto' })
    expect(planEditionSyncToggle('readAlong', false, 'auto')).toEqual({ setIndexOverride: false, setReadAloudMode: 'disabled' })
  })

  it('index books write the override and re-enable a disabled read-aloud mode only when turning on', () => {
    expect(editionSyncToggleValue('index', state(2, true, true), 'auto')).toBe(true)
    expect(planEditionSyncToggle('index', true, 'disabled')).toEqual({ setIndexOverride: true, setReadAloudMode: 'auto' })
    expect(planEditionSyncToggle('index', true, 'auto')).toEqual({ setIndexOverride: true, setReadAloudMode: null })
    expect(planEditionSyncToggle('index', false, 'disabled')).toEqual({ setIndexOverride: true, setReadAloudMode: null })
  })

  it('an index book reads as off while upstream read-aloud sync is disabled, so one disable is never overridden', () => {
    expect(editionSyncToggleValue('index', state(2, true, true), 'disabled')).toBe(false)
    expect(editionSyncToggleValue('index', state(2, true, false), 'auto')).toBe(false)
  })

  it('other books do nothing', () => {
    expect(planEditionSyncToggle('none', true, 'disabled')).toEqual({ setIndexOverride: false, setReadAloudMode: null })
  })
})
