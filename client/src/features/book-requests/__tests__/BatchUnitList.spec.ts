import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BatchUnitView } from '@bookorbit/types'

import BatchUnitList from '../components/BatchUnitList.vue'

function unit(overrides: Partial<BatchUnitView> = {}): BatchUnitView {
  return {
    unitIndex: 0,
    title: 'Mort',
    primaryPath: 'Pack/Mort.epub',
    mediaKind: 'ebook',
    sizeBytes: 2048,
    status: 'waiting',
    bookDockFileId: null,
    errorMessage: null,
    ...overrides,
  }
}

describe('BatchUnitList', () => {
  it('renders each unit with its state and the failure message', () => {
    const wrapper = mount(BatchUnitList, {
      props: {
        units: [
          unit(),
          unit({ unitIndex: 1, title: 'Small Gods', status: 'placing' }),
          unit({ unitIndex: 2, title: 'Guards! Guards!', status: 'in_dock', bookDockFileId: 9 }),
          unit({ unitIndex: 3, title: null, primaryPath: 'Pack/Eric.epub', status: 'failed', errorMessage: 'Disk full' }),
        ],
      },
    })
    const rows = wrapper.findAll('li')

    expect(rows).toHaveLength(4)
    expect(rows[0]!.text()).toContain('Mort')
    expect(rows[0]!.text()).toContain('Waiting for download')
    expect(rows[1]!.text()).toContain('Placing')
    expect(rows[2]!.text()).toContain('In Book Dock')
    expect(rows[3]!.text()).toContain('Pack/Eric.epub')
    expect(rows[3]!.text()).toContain('Failed')
    expect(rows[3]!.text()).toContain('Disk full')
    expect(rows[0]!.text()).not.toContain('Disk full')
  })
})
