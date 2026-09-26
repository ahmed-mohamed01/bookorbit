// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import { isTerminalBlock, needsForce } from '../position-sync'

describe('needsForce', () => {
  it.each([
    ['ready', true],
    ['failed', false],
    ['unalignable', false],
    ['none', false],
  ] as [AlignmentStatus, boolean][])('forces a %s alignment: %s', (status, expected) => {
    expect(needsForce(status)).toBe(expected)
  })
})

describe('isTerminalBlock', () => {
  it('treats only the server-configuration blocks as terminal', () => {
    expect(isTerminalBlock('disabled')).toBe(true)
    expect(isTerminalBlock('unavailable')).toBe(true)
    expect(isTerminalBlock('busy')).toBe(false)
    expect(isTerminalBlock(null)).toBe(false)
  })
})
