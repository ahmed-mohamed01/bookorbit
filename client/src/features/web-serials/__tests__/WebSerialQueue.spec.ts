import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import type { WebSerialJob } from '@bookorbit/types'
import type { SerialJobDetailState } from '../composables/useWebSerialQueue'
import { job, jobItem, uiStubs } from './fixtures'

const permissions = vi.hoisted(() => ({ admin: false }))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => permissions.admin }),
}))

import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import WebSerialQueue from '../components/WebSerialQueue.vue'
import WebSerialJobItems from '../components/WebSerialJobItems.vue'

type QueueProps = InstanceType<typeof WebSerialQueue>['$props']

function mountQueue(jobs: WebSerialJob[], overrides: Partial<QueueProps> = {}) {
  return mount(WebSerialQueue, {
    props: {
      jobs,
      loading: false,
      loaded: true,
      error: null,
      busyIds: new Set<number>(),
      scope: 'mine',
      queuePaused: false,
      clearing: false,
      queueBusy: false,
      expandedIds: new Set<number>(),
      details: {},
      ...overrides,
    } as QueueProps,
    global: { stubs: { RouterLink: RouterLinkStub, ...uiStubs } },
  })
}

function buttonByText(wrapper: ReturnType<typeof mountQueue>, text: string) {
  return wrapper.findAll('button').find((button) => button.text() === text)
}

function detailState(items: ReturnType<typeof jobItem>[], extra: Partial<SerialJobDetailState> = {}): SerialJobDetailState {
  return { items, loading: false, error: null, retryingItemIds: new Set<number>(), ...extra }
}

beforeEach(() => {
  permissions.admin = false
})

describe('WebSerialQueue groups', () => {
  it('groups jobs and shows the place in line for waiting jobs', () => {
    const wrapper = mountQueue([
      job({ id: 1, status: 'running' }),
      job({ id: 2, status: 'queued', queuePosition: 3, title: 'Waiting One' }),
      job({ id: 3, status: 'paused', title: 'Paused One' }),
      job({ id: 4, status: 'completed' }),
    ])
    const headings = wrapper.findAll('h2').map((heading) => heading.text())
    expect(headings).toEqual(['In progress', 'Waiting', 'Paused', 'Recent'])
    expect(wrapper.text()).toContain('#3 in line')
  })

  it('shows the owner in the meta line of the everyone view', () => {
    const wrapper = mountQueue([job({ owner: { id: 7, name: 'Sam Reader' } })], { scope: 'all' })
    expect(wrapper.text()).toContain('Sam Reader')
  })
})

describe('WebSerialQueue row actions', () => {
  it('offers pause and cancel on a running job', () => {
    const wrapper = mountQueue([job({ status: 'running' })])
    expect(wrapper.find('button[aria-label="Pause Tower Climber"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Cancel Tower Climber"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Resume Tower Climber"]').exists()).toBe(false)
  })

  it('offers move to top, pause and cancel on a queued job behind others', () => {
    const wrapper = mountQueue([job({ status: 'queued', queuePosition: 2 })])
    expect(wrapper.find('button[aria-label="Pause Tower Climber"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Cancel Tower Climber"]').exists()).toBe(true)
    expect(buttonByText(wrapper, 'Move to top')).toBeDefined()
  })

  it('offers resume and cancel on a paused job', () => {
    const wrapper = mountQueue([job({ status: 'paused' })])
    expect(wrapper.find('button[aria-label="Resume Tower Climber"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Pause Tower Climber"]').exists()).toBe(false)
  })

  it('offers retry and remove on a failed job and open on a completed one', () => {
    const failed = mountQueue([job({ status: 'failed' })])
    expect(failed.find('button[aria-label="Retry Tower Climber"]').exists()).toBe(true)
    expect(buttonByText(failed, 'Remove')).toBeDefined()

    const done = mountQueue([job({ status: 'completed' })])
    expect(done.find('a[aria-label="Open Tower Climber in its library"]').exists()).toBe(true)
    expect(buttonByText(done, 'Remove')).toBeDefined()
  })

  it('emits the action with the job id', async () => {
    const wrapper = mountQueue([job({ id: 8, status: 'running' })])
    await wrapper.get('button[aria-label="Pause Tower Climber"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['pause', 8])

    await buttonByText(mountQueue([job({ id: 9, status: 'failed' })]), 'Remove')?.trigger('click')
  })

  function actionDialog(wrapper: ReturnType<typeof mountQueue>) {
    return wrapper.findAllComponents(ConfirmDialog)[1]!
  }

  it('emits remove from the menu once the confirm is accepted', async () => {
    const wrapper = mountQueue([job({ id: 9, status: 'cancelled' })])
    await buttonByText(wrapper, 'Remove')?.trigger('click')
    expect(wrapper.emitted('action')).toBeUndefined()
    expect(actionDialog(wrapper).props('open')).toBe(true)

    actionDialog(wrapper).vm.$emit('confirm')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('action')?.[0]).toEqual(['remove', 9])
  })

  it('asks before cancelling and does nothing when the confirm is dismissed', async () => {
    const wrapper = mountQueue([job({ id: 8, status: 'running' })])
    await wrapper.get('button[aria-label="Cancel Tower Climber"]').trigger('click')
    expect(actionDialog(wrapper).props('open')).toBe(true)
    expect(actionDialog(wrapper).props('description')).toContain('Tower Climber')

    actionDialog(wrapper).vm.$emit('cancel')
    await wrapper.vm.$nextTick()
    expect(actionDialog(wrapper).props('open')).toBe(false)
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it("names the owner when removing someone else's download", async () => {
    const wrapper = mountQueue([job({ id: 9, status: 'failed', owner: { id: 3, name: 'Mina' } })], { scope: 'all', userId: 7 })
    await buttonByText(wrapper, 'Remove')?.trigger('click')
    expect(actionDialog(wrapper).props('description')).toContain('Mina')

    const own = mountQueue([job({ id: 9, status: 'failed', owner: { id: 7, name: 'Me' } })], { scope: 'all', userId: 7 })
    await buttonByText(own, 'Remove')?.trigger('click')
    expect(actionDialog(own).props('description')).not.toContain('Me')
  })
})

describe('WebSerialQueue toolbar', () => {
  it('hides the admin controls from people without the permission', () => {
    const wrapper = mountQueue([job()])
    expect(wrapper.text()).not.toContain('Everyone')
    expect(buttonByText(wrapper, 'Pause queue')).toBeUndefined()
    expect(buttonByText(wrapper, 'Clear finished')).toBeDefined()
  })

  it('shows the scope switch and the pause button to admins and emits their intent', async () => {
    permissions.admin = true
    const wrapper = mountQueue([job()])
    await buttonByText(wrapper, 'Everyone')?.trigger('click')
    expect(wrapper.emitted('update:scope')?.[0]).toEqual(['all'])
    await buttonByText(wrapper, 'Pause queue')?.trigger('click')
    expect(wrapper.emitted('togglePause')).toHaveLength(1)
  })

  it('offers Resume queue while the queue is paused and warns everyone', () => {
    permissions.admin = true
    const wrapper = mountQueue([job()], { queuePaused: true })
    expect(buttonByText(wrapper, 'Resume queue')).toBeDefined()
    expect(wrapper.text()).toContain('Downloads are paused by an admin.')

    permissions.admin = false
    const member = mountQueue([job()], { queuePaused: true })
    expect(member.text()).toContain('Downloads are paused by an admin.')
  })

  it('disables Clear finished when nothing is finished', () => {
    const wrapper = mountQueue([job({ status: 'running' })])
    expect(buttonByText(wrapper, 'Clear finished')?.attributes('disabled')).toBeDefined()
  })

  it('asks for confirmation before clearing and says books stay', async () => {
    const wrapper = mountQueue([job({ status: 'completed' })])
    await buttonByText(wrapper, 'Clear finished')?.trigger('click')
    const dialog = wrapper.getComponent(ConfirmDialog)
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('description')).toContain('stay in your library')
    expect(wrapper.emitted('clearFinished')).toBeUndefined()

    dialog.vm.$emit('confirm')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('clearFinished')).toHaveLength(1)
  })

  it('does not clear when the dialog is cancelled', async () => {
    const wrapper = mountQueue([job({ status: 'failed' })])
    await buttonByText(wrapper, 'Clear finished')?.trigger('click')
    wrapper.getComponent(ConfirmDialog).vm.$emit('cancel')
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(ConfirmDialog).props('open')).toBe(false)
    expect(wrapper.emitted('clearFinished')).toBeUndefined()
  })
})

describe('WebSerialQueue details', () => {
  it('emits toggle from the details control', async () => {
    const wrapper = mountQueue([job({ id: 4 })])
    const toggle = buttonByText(wrapper, 'Details')
    expect(toggle?.attributes('aria-expanded')).toBe('false')
    await toggle?.trigger('click')
    expect(wrapper.emitted('toggle')?.[0]).toEqual([4])
  })

  it('lists items with reasons, retry for failed ones and a book link for imported ones', async () => {
    const wrapper = mountQueue([job({ id: 4, status: 'completed_with_gaps' })], {
      expandedIds: new Set([4]),
      details: {
        4: detailState([
          jobItem({ id: 1, label: 'Ch. 1', status: 'imported', bookId: 55 }),
          jobItem({ id: 2, label: 'Ch. 2', status: 'failed', error: 'Source returned no pages.' }),
        ]),
      },
    })
    expect(wrapper.text()).toContain('Source returned no pages.')
    expect(wrapper.text()).toContain('Imported')
    const bookLink = wrapper.findAllComponents(RouterLinkStub).find((link) => (link.props('to') as { name?: string }).name === 'book-detail')
    expect(bookLink?.props('to')).toEqual({ name: 'book-detail', params: { bookId: 55 } })

    await wrapper.get('button[aria-label="Retry Ch. 2"]').trigger('click')
    expect(wrapper.emitted('retryItem')?.[0]).toEqual([4, 2])
  })

  it('shows a loading line before the details arrive', () => {
    const wrapper = mountQueue([job({ id: 4 })], { expandedIds: new Set([4]), details: {} })
    expect(wrapper.text()).toContain('Loading details')
  })

  it('renders only a window of items when there are more than 100', () => {
    const items = Array.from({ length: 150 }, (_, index) => jobItem({ id: index + 1, label: `Ch. ${index + 1}` }))
    const wrapper = mount(WebSerialJobItems, {
      props: { state: detailState(items), jobId: 1, canRetry: true },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    expect(wrapper.find('[data-testid="virtual-items"]').exists()).toBe(true)
    expect(wrapper.findAll('li').length).toBeLessThan(150)
  })

  it('renders every item when there are 100 or fewer', () => {
    const items = Array.from({ length: 20 }, (_, index) => jobItem({ id: index + 1 }))
    const wrapper = mount(WebSerialJobItems, {
      props: { state: detailState(items), jobId: 1, canRetry: true },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    expect(wrapper.findAll('li')).toHaveLength(20)
  })
})

describe('WebSerialQueue move action', () => {
  it('offers Move to another source for manga with chapters left and emits it', async () => {
    const wrapper = mountQueue([job({ id: 4, status: 'failed' })])
    await buttonByText(wrapper, 'Move to another source')?.trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['move', 4])
  })

  it('hides it for novels and completed jobs', () => {
    expect(buttonByText(mountQueue([job({ kind: 'novel', status: 'failed' })]), 'Move to another source')).toBeUndefined()
    expect(buttonByText(mountQueue([job({ status: 'completed' })]), 'Move to another source')).toBeUndefined()
  })
  it('offers Show more only while more jobs can be loaded', async () => {
    const wrapper = mountQueue([job({ id: 1, status: 'completed' })], { hasMore: true })
    await buttonByText(wrapper, 'Show more')?.trigger('click')
    expect(wrapper.emitted('loadMore')).toHaveLength(1)
    expect(buttonByText(mountQueue([job({ id: 1, status: 'completed' })]), 'Show more')).toBeUndefined()
  })
})

describe('WebSerialQueue finished jobs with failed items', () => {
  it('summarises failed items of a cancelled job and offers no item retry', () => {
    const cancelled = job({ id: 5, status: 'cancelled', unitsFailed: 3, message: 'Moved to Royal Road.' })
    const wrapper = mountQueue([cancelled], {
      expandedIds: new Set([5]),
      details: { 5: detailState([jobItem({ id: 1, status: 'failed', error: 'Not available' })]) },
    })
    expect(wrapper.text()).toContain('Moved to Royal Road.')
    expect(wrapper.text()).toContain('3 items could not be downloaded.')
    expect(wrapper.find('button[aria-label^="Retry Ch."]').exists()).toBe(false)
  })

  it('keeps the item retry for a job that can still take it', () => {
    const wrapper = mountQueue([job({ id: 5, status: 'failed', unitsFailed: 1 })], {
      expandedIds: new Set([5]),
      details: { 5: detailState([jobItem({ id: 1, status: 'failed', error: 'x' })]) },
    })
    expect(wrapper.find('button[aria-label^="Retry"]').exists()).toBe(true)
  })
})
