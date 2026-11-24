import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { JOBS_VIEW_PERMISSIONS, type JobListItem } from '@bookorbit/types'
import { routes } from '@/router'
import * as jobsApi from '../api/jobs.api'

vi.mock('@/composables/useAppStyleScope', () => ({ useAppStyleScope: () => {} }))
vi.mock('@/composables/useShellServices', () => ({ useShellServices: () => {} }))
vi.mock('@/stores/theme', () => ({ useThemeStore: () => ({ appliedBackgroundClass: '' }) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => false }) }))
vi.mock('../lib/jobs-socket', () => ({ listenToJobs: () => () => {} }))

vi.mock('@/features/book-requests/components/RequestDetailPanel.vue', async () => {
  const { defineComponent, inject } = await import('vue')
  const { REQUEST_DRAWER } = await import('@/features/book-requests/requestDrawerContext')
  return {
    default: defineComponent({
      setup() {
        const { position, total, hasPrevious, hasNext, goPrevious, goNext, close } = inject(REQUEST_DRAWER)!
        return { position, total, hasPrevious, hasNext, goPrevious, goNext, close }
      },
      template: `
        <div>
          <output data-testid="request-position">{{ position }}/{{ total }}</output>
          <button :disabled="!hasPrevious" data-testid="request-previous" @click="goPrevious">Previous</button>
          <button :disabled="!hasNext" data-testid="request-next" @click="goNext">Next</button>
          <button data-testid="request-close" @click="close">Close</button>
        </div>
      `,
    }),
  }
})

const activity = '/jobs/activity'
const query = '?view=needs-you&type=request-download&scope=everyone'

function requestJob(id: number): JobListItem {
  return {
    id: `request-download:${id}`,
    type: 'request-download',
    kind: 'ebook',
    shape: 'job',
    status: 'needs-you',
    reason: 'review',
    phase: null,
    done: null,
    total: null,
    percent: null,
    position: null,
    subject: { label: `Request ${id}`, byline: null, url: `/requests/${id}`, image: null },
    requester: null,
    cost: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    actions: [],
    actionNote: null,
    extra: null,
  }
}

async function mountJobs(path: string) {
  const list = vi
    .spyOn(jobsApi, 'listJobs')
    .mockImplementation(async ({ cursor }) =>
      cursor ? { items: [requestJob(42), requestJob(57)], next: null } : { items: [requestJob(10)], next: 'page-two' },
    )
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  const wrapper = mount(RouterView, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: { AppSidebar: true, MobileShellBar: true, BookMetadataFetchWidget: true, CommandPalette: true },
    },
  })
  await flushPromises()
  return { wrapper, router, list }
}

enableAutoUnmount(afterEach)
afterEach(() => vi.restoreAllMocks())

describe('Jobs request drawer', () => {
  it('opens Review over the current Jobs page, steps through the listed requests, and preserves the page on close', async () => {
    const { wrapper, router, list } = await mountJobs(activity + query)
    const body = new DOMWrapper(document.body)
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'needs-you', type: 'request-download', scope: 'everyone' }))
    await wrapper.get('[data-testid="jobs-next"]').trigger('click')
    await flushPromises()

    const scrollArea = wrapper.get('.app-shell-scroll').element
    scrollArea.scrollTop = 180
    const row = wrapper.get('[data-testid="job-row"]').element
    const review = wrapper.get('[data-testid="job-open"]')
    expect(review.text()).toBe('Review')
    expect(review.attributes('href')).toBe(`${activity}/requests/42${query}`)
    await review.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="job-row"]').element).toBe(row)
    expect(body.get('[data-testid="request-position"]').text()).toBe('1/2')
    expect(body.get('[data-testid="request-previous"]').attributes('disabled')).toBeDefined()
    await body.get('[data-testid="request-next"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(`${activity}/requests/57${query}`)
    expect(body.get('[data-testid="request-position"]').text()).toBe('2/2')
    expect(body.get('[data-testid="request-next"]').attributes('disabled')).toBeDefined()

    await body.get('[data-testid="request-previous"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(`${activity}/requests/42${query}`)
    await body.get('[data-testid="request-close"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe(activity + query)
    expect(body.find('[data-testid="request-position"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="job-row"]').element).toBe(row)
    expect(wrapper.get('[data-testid="jobs-previous"]').attributes('disabled')).toBeUndefined()
    expect(scrollArea.scrollTop).toBe(180)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('opens a direct link over Jobs when the request is absent from the list', async () => {
    const { wrapper, router } = await mountJobs(`${activity}/requests/123${query}`)
    const body = new DOMWrapper(document.body)

    expect(router.currentRoute.value.params.id).toBe('123')
    expect(router.currentRoute.value.meta.requiredPermission).toEqual([...JOBS_VIEW_PERMISSIONS])
    expect(wrapper.get('[data-testid="job-row"]').text()).toContain('Request 10')
    expect(body.get('[data-testid="request-position"]').text()).toBe('0/1')
    expect(body.get('[data-testid="request-previous"]').attributes('disabled')).toBeDefined()
    expect(body.get('[data-testid="request-next"]').attributes('disabled')).toBeDefined()
  })
})
