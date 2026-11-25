import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookKnowledgePassage } from '@bookorbit/types'
import KnowledgeReaderHost from './KnowledgeReaderHost.vue'

const supported = vi.hoisted(() => ({ value: true }))
vi.mock('@/features/delivery/composables/useReadAloudDelivery', async () => {
  const { ref: vueRef } = await import('vue')
  return { useReadAloudDelivery: () => ({ supported: vueRef(supported.value) }) }
})
vi.mock('./BookKnowledgePanel.vue', () => ({
  default: {
    name: 'BookKnowledgePanel',
    props: ['bookId', 'chapters', 'navigationLocked', 'sessionScope'],
    emits: ['jump', 'close'],
    template: '<div />',
  },
}))

const passage: BookKnowledgePassage = {
  number: 1,
  text: 'The amber engine hummed.',
  ordinals: [3],
  spineIndex: 2,
  paragraphIndex: 0,
  href: 'ch3.xhtml',
}
const wrappers: ReturnType<typeof mount>[] = []
function host(overrides: Record<string, unknown> = {}) {
  const progress = { cfi: ref<string | null>('epubcfi(/6/2!/4/2)'), fraction: ref(0.2), save: vi.fn<() => void>() }
  const props = {
    bookId: 4,
    epub: true,
    chapters: [],
    navigationLocked: false,
    view: null,
    canNavigate: vi.fn<() => boolean>(() => true),
    goTo: vi.fn<(target: string) => Promise<void>>(async () => {}),
    goToFraction: vi.fn<(fraction: number) => Promise<void>>(async () => {}),
    navigateToTarget: vi.fn<(target: string) => Promise<void>>(async () => {}),
    progress,
    ...overrides,
  }
  const wrapper = mount(KnowledgeReaderHost, { props })
  wrappers.push(wrapper)
  return { wrapper, props, progress }
}
type Exposed = { available: boolean; isOpen: boolean; visitActive: boolean; toggle(): void; close(): void }
const exposed = (wrapper: ReturnType<typeof mount>) => wrapper.vm as unknown as Exposed

describe('KnowledgeReaderHost', () => {
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
    supported.value = true
  })
  it('is available only for EPUBs when the server feature is on', () => {
    expect(exposed(host().wrapper).available).toBe(true)
    expect(exposed(host({ epub: false }).wrapper).available).toBe(false)
    supported.value = false
    expect(exposed(host().wrapper).available).toBe(false)
  })
  it('opens the panel, tells the reader, and closes it again', async () => {
    const { wrapper } = host()
    exposed(wrapper).toggle()
    await flushPromises()
    expect(wrapper.emitted('open')).toHaveLength(1)
    expect(exposed(wrapper).isOpen).toBe(true)
    expect(wrapper.findComponent({ name: 'BookKnowledgePanel' }).exists()).toBe(true)
    exposed(wrapper).close()
    await flushPromises()
    expect(exposed(wrapper).isOpen).toBe(false)
    expect(wrapper.findComponent({ name: 'BookKnowledgePanel' }).exists()).toBe(false)
  })
  it('jumps to a passage as a visit, then returns to the saved place', async () => {
    const { wrapper, props } = host()
    exposed(wrapper).toggle()
    await flushPromises()
    wrapper.findComponent({ name: 'BookKnowledgePanel' }).vm.$emit('jump', passage)
    await flushPromises()
    expect(props.navigateToTarget).toHaveBeenCalledWith('ch3.xhtml')
    expect(exposed(wrapper).visitActive).toBe(true)
    expect(exposed(wrapper).isOpen).toBe(false)
    const back = wrapper.findAll('button').find((button) => button.text() === 'Back to where you were')!
    await back.trigger('click')
    await flushPromises()
    expect(props.goTo).toHaveBeenCalledWith('epubcfi(/6/2!/4/2)')
    expect(exposed(wrapper).visitActive).toBe(false)
  })
  it('restores by fraction without a CFI and saves when continuing from the passage', async () => {
    const { wrapper, props, progress } = host()
    progress.cfi.value = null
    exposed(wrapper).toggle()
    await flushPromises()
    wrapper.findComponent({ name: 'BookKnowledgePanel' }).vm.$emit('jump', passage)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Continue from here')!
      .trigger('click')
    expect(progress.save).toHaveBeenCalledTimes(1)
    expect(exposed(wrapper).visitActive).toBe(false)
    exposed(wrapper).toggle()
    await flushPromises()
    wrapper.findComponent({ name: 'BookKnowledgePanel' }).vm.$emit('jump', passage)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Back to where you were')!
      .trigger('click')
    await flushPromises()
    expect(props.goToFraction).toHaveBeenCalledWith(0.2)
  })
})
