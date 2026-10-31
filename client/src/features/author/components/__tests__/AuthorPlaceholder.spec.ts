import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuthorPlaceholder from '../AuthorPlaceholder.vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'

const width = ref(112)
const height = ref(168)

vi.mock('@vueuse/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vueuse/core')>()),
  useElementSize: () => ({ width, height }),
}))

function mountPlaceholder(props: Partial<InstanceType<typeof AuthorPlaceholder>['$props']> = {}) {
  return mount(AuthorPlaceholder, { props: { name: 'Ursula K. Le Guin', ...props } })
}

describe('AuthorPlaceholder', () => {
  const settings = useDisplaySettings()

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    width.value = 112
    height.value = 168
    settings.placeholderCoverStyle.value = 'bauhaus'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws the style chosen in display settings', async () => {
    const wrapper = mountPlaceholder()
    const art = wrapper.get('[data-testid="author-placeholder"]')
    expect(art.attributes('data-placeholder-style')).toBe('bauhaus')
    expect(art.findAll('svg').length).toBe(2)

    settings.placeholderCoverStyle.value = 'paperback'
    await nextTick()
    expect(art.attributes('data-placeholder-style')).toBe('paperback')
  })

  it('is hidden from assistive technology', () => {
    expect(mountPlaceholder().get('[data-testid="author-placeholder"]').attributes('aria-hidden')).toBe('true')
  })

  it('draws nothing until it has a size', () => {
    width.value = 0
    height.value = 0
    expect(mountPlaceholder().get('[data-testid="author-placeholder"]').html()).not.toContain('<svg')
  })

  it('draws no author text into the markup', () => {
    const wrapper = mountPlaceholder({ name: '<img src=x onerror=alert(1)>' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('<img')
  })
})
