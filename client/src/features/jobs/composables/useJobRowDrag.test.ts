import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobListItem } from '@bookorbit/types'

import { apiJson } from '@/lib/api-json'
import JobDragPreview from '../components/JobDragPreview.vue'
import { isJobMove } from '../lib/job-reorder'
import { useJobRowDrag } from './useJobRowDrag'

vi.mock('@/lib/api-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-json')>()),
  apiJson: vi.fn<typeof apiJson>(),
}))
vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn<(message: string) => void>(), warning: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() },
}))

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  Reflect.deleteProperty(document, 'elementFromPoint')
})

function setup(overrides: Partial<JobListItem>[] = []) {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  const items = ref(
    [
      { id: 'web-serial:1', type: 'web-serial', actions: ['move-down'] },
      { id: 'audio-convert:1', type: 'audio-convert', actions: ['move-down'] },
      { id: 'web-serial:2', type: 'web-serial', actions: ['move-up', 'move-down'] },
      { id: 'web-serial:running', type: 'web-serial', actions: [] },
      { id: 'web-serial:3', type: 'web-serial', actions: ['move-up'] },
    ].map((item, index) => ({
      status: 'queued',
      kind: null,
      position: index + 1,
      subject: { label: 'A queued book', image: '/cover.jpg', byline: null, url: null },
      ...item,
      ...overrides[index],
    })) as JobListItem[],
  )
  const revision = ref(0)
  const load = vi.fn<(counts: boolean) => Promise<void>>().mockResolvedValue(undefined)
  const acting = ref<string | null>(null)
  const api = vi.mocked(apiJson).mockResolvedValue({ outcome: 'done', status: 'queued' })
  let drag!: ReturnType<typeof useJobRowDrag>
  const wrapper = mount(
    defineComponent({
      setup() {
        drag = useJobRowDrag({ items, acting, load })
        return () => [
          h('table', { ref: drag.table, onPointerdown: drag.handlePointerDown }, [
            h(
              'tbody',
              items.value.map((item) =>
                h('tr', { key: item.id, 'data-job-id': item.id }, [
                  h('td', item.actions.some(isJobMove) ? [h('button', { key: revision.value, 'data-job-reorder-handle': '' })] : []),
                ]),
              ),
            ),
          ]),
          h(JobDragPreview, { preview: drag.preview.value }),
        ]
      },
    }),
    { attachTo: document.body },
  )
  const rows = () => wrapper.findAll('tr').map((row) => row.element)
  rows().forEach((row) => {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 + rows().indexOf(row) * 40, 300, 40))
  })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (_x: number, y: number) => rows()[Math.floor((y - 100) / 40)] ?? document.body,
  })

  function pointer(type: string, clientY: number, target: EventTarget = document, clientX = 20) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    target.dispatchEvent(event)
    if (type === 'pointermove') vi.advanceTimersToNextFrame()
  }

  function start(index: number) {
    pointer('pointerdown', 120 + index * 40, rows()[index]!.querySelector('button')!)
  }

  return { api, load, acting, items, drag, pointer, start, revision, wrapper }
}

describe('useJobRowDrag', () => {
  const preview = () => document.body.querySelector<HTMLElement>('[data-testid="job-drag-preview"]')

  it('shows the cover, title and position after the threshold and keeps the grab offset while following the pointer', async () => {
    const { pointer, start } = setup()
    start(1)
    pointer('pointermove', 163)
    await nextTick()
    expect(preview()).toBeNull()

    pointer('pointermove', 164)
    await nextTick()
    expect(preview()?.textContent).toContain('A queued book')
    expect(preview()?.textContent).toContain('#2 in M4B conversions')
    expect(preview()?.querySelector('img')?.getAttribute('src')).toBe('/cover.jpg')
    expect(preview()?.style.width).toBe('300px')
    expect(preview()?.style.transformOrigin).toBe('20px 20px')
    expect(preview()?.style.translate).toBe('0px 144px')

    pointer('pointermove', 210, document, 50)
    await nextTick()
    expect(preview()?.style.translate).toBe('0px 190px')
    expect(preview()?.style.left).toBe('0px')

    pointer('pointerup', 210)
    await nextTick()
    expect(preview()).toBeNull()
  })

  it.each([
    [4, 105, 'web-serial:3', 'web-serial:1', 'before'],
    [0, 205, 'web-serial:1', 'web-serial:2', 'after'],
    [0, 295, 'web-serial:1', 'web-serial:3', 'after'],
    [0, 305, 'web-serial:1', 'web-serial:3', 'after'],
  ] as const)('posts a relative drop and reloads the list', async (source, y, id, targetId, place) => {
    const { api, load, drag, pointer, start } = setup()
    start(source)
    pointer('pointermove', y)
    expect(drag.dragging.value).toBe(id)
    expect(drag.line.value?.width).toBe(300)
    pointer('pointerup', y)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id, targetId, place }) }),
      'jobsArea.actionFailed',
    )
    expect(load).toHaveBeenCalledWith(true)
    expect(drag.dragging.value).toBeNull()
    expect(preview()).toBeNull()
  })

  it('posts an after drop on the hit audio conversion when another follows it', async () => {
    const { api, pointer, start } = setup([
      {},
      {},
      { id: 'audio-convert:2', type: 'audio-convert' },
      {},
      { id: 'audio-convert:3', type: 'audio-convert' },
    ])
    start(1)
    pointer('pointermove', 205)
    pointer('pointerup', 205)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ body: '{"id":"audio-convert:1","targetId":"audio-convert:2","place":"after"}' }),
      'jobsArea.actionFailed',
    )
  })

  it.each([120, 145, 165, 185, 225])('ignores an unchanged position or invalid drop target at %s', (y) => {
    const { api, drag, pointer, start } = setup()
    start(0)
    pointer('pointermove', y)
    expect(drag.line.value).toBeNull()
    pointer('pointerup', y)
    expect(api).not.toHaveBeenCalled()
  })

  it.each(['Escape', 'pointercancel', 'action', 'blur', 'unmount'])('cancels the drag on %s', async (reason) => {
    const { api, acting, drag, pointer, start, wrapper } = setup()
    start(0)
    pointer('pointermove', 295)
    expect(drag.line.value).not.toBeNull()
    await nextTick()
    expect(preview()).not.toBeNull()
    if (reason === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else if (reason === 'pointercancel') pointer(reason, 295)
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'))
    else if (reason === 'unmount') wrapper.unmount()
    else acting.value = 'cancel'
    expect(drag.dragging.value).toBeNull()
    expect(drag.line.value).toBeNull()
    await nextTick()
    expect(preview()).toBeNull()
    pointer('pointerup', 295)
    expect(api).not.toHaveBeenCalled()
  })

  it('keeps the drag active and picks the current DOM target after a refresh', async () => {
    const { api, drag, items, pointer, start } = setup()
    start(0)
    pointer('pointermove', 295)
    const [first, audio, second, running, third] = items.value
    items.value = [first!, audio!, third!, running!, second!].map((item) => ({ ...item }))
    await nextTick()

    expect(drag.dragging.value).toBe('web-serial:1')
    expect(drag.busy.value).toBe(false)
    pointer('pointermove', 294)
    pointer('pointerup', 294)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ body: '{"id":"web-serial:1","targetId":"web-serial:2","place":"after"}' }),
      'jobsArea.actionFailed',
    )
  })

  it('restores focus to the same job when a keyboard action replaces its handle', async () => {
    const { drag, revision, wrapper } = setup()
    const selector = '[data-job-id="web-serial:2"] button'
    const initial = wrapper.get<HTMLButtonElement>(selector)
    initial.element.focus()

    await drag.keepHandleFocus('web-serial:2', () => {
      revision.value++
      return Promise.resolve()
    })

    expect(wrapper.get(selector).element).not.toBe(initial.element)
    expect(document.activeElement).toBe(wrapper.get(selector).element)
  })

  it('only offers the slot before the first edition sync backlog row', async () => {
    const { api, drag, pointer, start } = setup([
      { id: 'edition-sync:1', type: 'edition-sync' },
      {},
      { id: 'edition-sync:2', type: 'edition-sync', kind: 'backlog-head' },
      {},
      { id: 'edition-sync:3', type: 'edition-sync', kind: 'backlog' },
    ])
    start(0)
    pointer('pointermove', 205)
    expect(drag.line.value).toBeNull()
    pointer('pointermove', 295)
    expect(drag.line.value).toBeNull()
    pointer('pointerup', 295)
    expect(api).not.toHaveBeenCalled()

    start(4)
    pointer('pointermove', 185)
    expect(drag.line.value?.top).toBe(180)
    pointer('pointerup', 185)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ body: '{"id":"edition-sync:3","targetId":"edition-sync:2","place":"before"}' }),
      'jobsArea.actionFailed',
    )
  })

  it.each(['backlog-head', null])('accepts a drop before an edition sync rank-one row with kind %s and no handle', async (kind) => {
    const { api, drag, pointer, start, wrapper } = setup([
      { id: 'edition-sync:1', type: 'edition-sync', kind, actions: ['cancel'] },
      { id: 'edition-sync:2', type: 'edition-sync', kind: kind === null ? 'backlog-head' : 'backlog', actions: ['move-up'] },
    ])
    expect(wrapper.get('[data-job-id="edition-sync:1"]').find('button').exists()).toBe(false)
    start(1)
    pointer('pointermove', 105)
    expect(drag.line.value?.top).toBe(100)
    pointer('pointerup', 105)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ body: '{"id":"edition-sync:2","targetId":"edition-sync:1","place":"before"}' }),
      'jobsArea.actionFailed',
    )
  })

  it('uses the slot before the edition sync backlog head when dropping after the last pin', async () => {
    const { api, pointer, start } = setup([
      { id: 'edition-sync:1', type: 'edition-sync' },
      { id: 'edition-sync:2', type: 'edition-sync', actions: ['move-up'] },
      { id: 'edition-sync:3', type: 'edition-sync', kind: 'backlog-head' },
      {},
      { id: 'edition-sync:4', type: 'edition-sync', kind: 'backlog' },
    ])
    start(0)
    pointer('pointermove', 165)
    pointer('pointerup', 165)
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/fork/jobs/reorder',
      expect.objectContaining({ body: '{"id":"edition-sync:1","targetId":"edition-sync:3","place":"before"}' }),
      'jobsArea.actionFailed',
    )
  })

  it('scrolls toward the viewport edge during a drag', () => {
    const { api, pointer, start } = setup()
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    start(0)
    pointer('pointermove', window.innerHeight - 4)
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number), behavior: 'instant' }))
    expect(scroll.mock.calls[0]?.[0]).toMatchObject({ top: expect.closeTo(18.57, 1) })
    pointer('pointercancel', window.innerHeight - 4)
    expect(api).not.toHaveBeenCalled()
  })

  it('keeps the grip idle below the threshold and while a list action runs', () => {
    const { api, acting, drag, pointer, start } = setup()
    start(0)
    pointer('pointermove', 123)
    expect(drag.dragging.value).toBeNull()
    pointer('pointerup', 123)
    acting.value = 'cancel'
    start(0)
    pointer('pointermove', 295)
    pointer('pointerup', 295)
    expect(drag.dragging.value).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })
})
