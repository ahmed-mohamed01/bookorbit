import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BookRequestItem } from '@bookorbit/types'

import RequestRowActions from '../components/RequestRowActions.vue'

function mountActions(kind: 'single' | 'batch') {
  const request = { id: 1, userId: 1, title: 'Series', status: 'approved', kind, dismissed: false } as unknown as BookRequestItem
  return mount(RequestRowActions, {
    props: { request, canManage: true, canSelfFulfil: true, currentUserId: 1, busy: false },
  })
}

describe('RequestRowActions', () => {
  it('offers Grab on an approved single request', () => {
    expect(mountActions('single').text()).toContain('Find a release')
  })

  it('offers no Grab on an approved batch request', () => {
    expect(mountActions('batch').text()).not.toContain('Find a release')
  })
})
