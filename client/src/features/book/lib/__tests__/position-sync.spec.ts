// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isTerminalBlock } from '../position-sync'

describe('isTerminalBlock', () => {
  it('treats only the server-configuration blocks as terminal', () => {
    expect(isTerminalBlock('disabled')).toBe(true)
    expect(isTerminalBlock('unavailable')).toBe(true)
    expect(isTerminalBlock('busy')).toBe(false)
    expect(isTerminalBlock(null)).toBe(false)
  })
})
