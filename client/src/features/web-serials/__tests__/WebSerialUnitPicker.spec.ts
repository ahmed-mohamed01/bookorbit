import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WebSerialUnitPicker from '../components/preview/WebSerialUnitPicker.vue'
import type { SerialRangeDraft } from '../lib/serialSelection'
import { mangaDetail, novelDetail } from './fixtures'

function mountPicker(range: SerialRangeDraft, detail = mangaDetail(), importedUnitKeys: string[] = []) {
  return mount(WebSerialUnitPicker, {
    props: { kind: detail.kind, units: detail.units, importedUnitKeys, range, rangeIncludesImportedGap: false },
    global: { plugins: [i18n] },
  })
}

const idle: SerialRangeDraft = { mode: 'range', fromSequence: '', toSequence: '' }
const all: SerialRangeDraft = { mode: 'all', fromSequence: '1', toSequence: '5' }

function rowLabels(wrapper: ReturnType<typeof mountPicker>): string[] {
  return wrapper.findAll('[data-unit-row]').map((row) => row.text())
}

describe('WebSerialUnitPicker', () => {
  beforeEach(() => localStorage.clear())

  it('collapses the list in All mode and shows a summary', async () => {
    const wrapper = mountPicker(all, mangaDetail(), ['u1'])
    expect(wrapper.findAll('[data-unit-row]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="all-summary"]').text()).toContain('All 5 chapters')
    expect(wrapper.get('[data-testid="all-summary"]').text()).toContain('1 already in your library')
  })

  it('expands and collapses the list read-only', async () => {
    const wrapper = mountPicker(all)
    await wrapper.get('[data-testid="toggle-list"]').trigger('click')
    expect(wrapper.findAll('[data-unit-row]')).toHaveLength(5)
    expect(wrapper.get('[data-testid="toggle-list"]').text()).toBe('Hide')
    await wrapper.findAll('[data-unit-row]')[0]!.trigger('click')
    expect(wrapper.emitted('select-unit')).toBeUndefined()
    await wrapper.get('[data-testid="toggle-list"]').trigger('click')
    expect(wrapper.findAll('[data-unit-row]')).toHaveLength(0)
  })

  it('uses volume wording for novels', () => {
    const wrapper = mountPicker(all, novelDetail())
    expect(wrapper.get('[data-testid="all-summary"]').text()).toContain('All 3 volumes · 300 chapters')
    expect(wrapper.get('[data-testid="toggle-list"]').text()).toBe('Show volumes')
  })

  it('always shows the list in Choose range mode', () => {
    expect(mountPicker(idle).findAll('[data-unit-row]')).toHaveLength(5)
  })

  it('sorts and remembers the choice', async () => {
    const wrapper = mountPicker(idle)
    expect(rowLabels(wrapper)[0]).toContain('Ch. 5')
    await wrapper.get('[data-testid="unit-sort"]').trigger('click')
    expect(rowLabels(wrapper)[0]).toContain('Ch. 1')
    expect(wrapper.get('[data-testid="unit-sort"]').text()).toBe('Oldest first')
    expect(localStorage.getItem('bookorbit.webSerials.unitSort')).toBe('oldest')
    expect(rowLabels(mountPicker(idle))[0]).toContain('Ch. 1')
  })

  it('hints at the first tap when nothing is picked', () => {
    expect(mountPicker(idle).get('[data-testid="range-hint"]').text()).toBe('Tap the first chapter of the range')
  })

  it('marks the anchor and previews the span on hover', async () => {
    const wrapper = mountPicker({ mode: 'range', fromSequence: '2', toSequence: '' })
    expect(wrapper.get('[data-testid="range-hint"]').text()).toBe('Now tap the last chapter')
    const rows = wrapper.findAll('[data-unit-row]')
    expect(rows[3]!.classes()).toContain('bg-primary/15')
    expect(rows[3]!.text()).toContain('Start')
    await rows[0]!.trigger('pointerenter')
    expect(wrapper.get('[data-testid="range-summary"]').text()).toContain('Chapters 2 to 5 · 4 chapters')
    expect(wrapper.findAll('[data-unit-row]')[1]!.classes()).toContain('bg-primary/10')
    await wrapper.get('[role="list"]').trigger('pointerleave')
    expect(wrapper.find('[data-testid="range-summary"]').exists()).toBe(false)
  })

  it('previews on keyboard focus', async () => {
    const wrapper = mountPicker({ mode: 'range', fromSequence: '2', toSequence: '' })
    await wrapper.findAll('[data-unit-row]')[1]!.trigger('focus')
    expect(wrapper.get('[data-testid="range-summary"]').text()).toContain('Chapters 2 to 4 · 3 chapters')
  })

  it('emits select-unit on click and clear-range on Escape with an anchor', async () => {
    const wrapper = mountPicker({ mode: 'range', fromSequence: '2', toSequence: '' })
    await wrapper.findAll('[data-unit-row]')[0]!.trigger('click')
    expect(wrapper.emitted('select-unit')?.[0]).toEqual(['5'])
    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('clear-range')).toHaveLength(1)
  })

  it('does not clear on Escape without an anchor', async () => {
    const wrapper = mountPicker(idle)
    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('clear-range')).toBeUndefined()
  })

  it('shows the committed span with Start and End chips', () => {
    const wrapper = mountPicker({ mode: 'range', fromSequence: '2', toSequence: '4' })
    const rows = wrapper.findAll('[data-unit-row]')
    expect(rows[1]!.text()).toContain('End')
    expect(rows[3]!.text()).toContain('Start')
    expect(rows[2]!.classes()).toContain('bg-primary/12')
    expect(rows[0]!.classes()).not.toContain('bg-primary/12')
    expect(wrapper.get('[data-testid="range-summary"]').text()).toContain('Chapters 2 to 4 · 3 chapters')
    expect(wrapper.find('[data-testid="range-hint"]').exists()).toBe(false)
  })

  it('lets a third tap through to start a new range', async () => {
    const wrapper = mountPicker({ mode: 'range', fromSequence: '2', toSequence: '4' })
    await wrapper.findAll('[data-unit-row]')[0]!.trigger('click')
    expect(wrapper.emitted('select-unit')?.[0]).toEqual(['5'])
  })
  it('moves the All/Some choice with the arrow keys instead of jumping into the list', async () => {
    const wrapper = mount(WebSerialUnitPicker, {
      props: { kind: 'manga', units: mangaDetail().units, importedUnitKeys: [], range: idle, rangeIncludesImportedGap: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['-1', '0'])
    ;(radios[1]!.element as HTMLElement).focus()
    await radios[1]!.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('set-mode')?.[0]).toEqual(['all'])
    expect(document.activeElement).toBe(radios[0]!.element)
    expect(document.activeElement?.hasAttribute('data-unit-row')).toBe(false)

    const rows = wrapper.findAll('[data-unit-row]')
    ;(rows[0]!.element as HTMLElement).focus()
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1]!.element)
    wrapper.unmount()
  })

  it('marks the chapters of an owned volume when volumes are shown', () => {
    const detail = mangaDetail()
    const wrapper = mount(WebSerialUnitPicker, {
      props: {
        kind: 'manga',
        units: detail.units,
        importedUnitKeys: [],
        importedGroupKeys: ['vol:3'],
        showVolumes: true,
        volumeOf: (unit: { sequence: string }) => (Number(unit.sequence) <= 2 ? '3' : '4'),
        range: idle,
        rangeIncludesImportedGap: false,
      },
      global: { plugins: [i18n] },
    })
    const rows = wrapper.findAll('[data-unit-row]')
    expect(rows.filter((row) => row.text().includes('In library'))).toHaveLength(2)
  })
})
