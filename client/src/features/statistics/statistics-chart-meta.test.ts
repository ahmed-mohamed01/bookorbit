import { describe, expect, it } from 'vitest'

import { USER_CHART_IDS } from './statistics-chart-meta'

describe('statistics chart meta', () => {
  it('places the Where You Read chart at the end of the user tab defaults', () => {
    expect(USER_CHART_IDS.at(-1)).toBe('reading-source-distribution')
  })
})
