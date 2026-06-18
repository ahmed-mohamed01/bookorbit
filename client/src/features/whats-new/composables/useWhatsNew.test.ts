import { describe, expect, it } from 'vitest'

import type { ReleaseNote } from '@bookorbit/types'

import { resetWhatsNew, useWhatsNew } from './useWhatsNew'

describe('resetWhatsNew', () => {
  it('clears module-scope state so a user switch cannot inherit the previous user state', () => {
    const { releases, popupEnabled, popupOpen, hasMore, error } = useWhatsNew()

    releases.value = [{ version: 'v1.2.0' } as ReleaseNote]
    popupEnabled.value = false
    popupOpen.value = true
    hasMore.value = true
    error.value = 'boom'

    resetWhatsNew()

    expect(releases.value).toEqual([])
    expect(popupEnabled.value).toBe(true)
    expect(popupOpen.value).toBe(false)
    expect(hasMore.value).toBe(false)
    expect(error.value).toBeNull()
  })
})
