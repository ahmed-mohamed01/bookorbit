// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { READ_ALONG_BLOCK_REASONS } from '@bookorbit/types'
import { isTickBlockReason } from '../read-along-blocks'

describe('isTickBlockReason', () => {
  it.each(['not_configured', 'unreachable', 'no_target_library', 'target_not_allowed', 'format_not_allowed'] as const)(
    'counts %s as a blocker only the Storyteller settings can clear',
    (reason) => {
      expect(isTickBlockReason(reason)).toBe(true)
    },
  )

  it('leaves every other reason tickable, including the no_pair every unlinked book reports', () => {
    const tickable = READ_ALONG_BLOCK_REASONS.filter((reason) => !isTickBlockReason(reason))

    expect(tickable).toEqual(expect.arrayContaining(['no_pair', 'busy', 'no_epub', 'no_audio']))
    expect(isTickBlockReason(null)).toBe(false)
  })
})
