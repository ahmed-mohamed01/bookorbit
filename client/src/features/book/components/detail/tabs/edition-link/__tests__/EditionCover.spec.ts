import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EditionCover from '../EditionCover.vue'

describe('EditionCover', () => {
  it('asks for the audio art in a square frame for an audiobook', () => {
    const slot = mount(EditionCover, { props: { bookId: 20, medium: 'audio', version: 'v2' } })
    expect(slot.get('[data-testid="edition-cover"]').classes()).toContain('size-12')
    const src = slot.get('img').attributes('src') ?? ''
    expect(src.startsWith('/api/v1/books/20/thumbnail?')).toBe(true)
    expect(new URLSearchParams(src.split('?')[1]).get('medium')).toBe('audio')

    const result = mount(EditionCover, { props: { bookId: 20, medium: 'audio', size: 'result' } })
    expect(result.get('[data-testid="edition-cover"]').classes()).toContain('size-8')
  })

  it('keeps the portrait frame and the ebook art for an ebook', () => {
    const slot = mount(EditionCover, { props: { bookId: 10, medium: 'ebook' } })
    expect(slot.get('[data-testid="edition-cover"]').classes()).toEqual(expect.arrayContaining(['h-[60px]', 'w-10']))
    expect(new URLSearchParams((slot.get('img').attributes('src') ?? '').split('?')[1]).get('medium')).toBe('ebook')

    const result = mount(EditionCover, { props: { bookId: 10, medium: 'ebook', size: 'result' } })
    expect(result.get('[data-testid="edition-cover"]').classes()).toEqual(expect.arrayContaining(['h-[42px]', 'w-7']))
  })

  it('falls back to a neutral placeholder when the image fails', async () => {
    const wrapper = mount(EditionCover, { props: { bookId: 20, medium: 'audio' } })

    await wrapper.get('img').trigger('error')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edition-cover-fallback"]').exists()).toBe(true)
  })

  it('tries the image again once the cover version changes', async () => {
    const wrapper = mount(EditionCover, { props: { bookId: 20, medium: 'audio', version: 'v1' } })
    await wrapper.get('img').trigger('error')

    await wrapper.setProps({ version: 'v2' })

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('[data-testid="edition-cover-fallback"]').exists()).toBe(false)
  })
})
