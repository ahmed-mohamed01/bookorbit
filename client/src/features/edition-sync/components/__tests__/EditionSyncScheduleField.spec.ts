import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EditionSyncScheduleField from '../EditionSyncScheduleField.vue'

function mountField(cronExpression: string | null, runHours = 8) {
  return mount(EditionSyncScheduleField, { props: { cronExpression, runHours } })
}

const lastValid = (wrapper: ReturnType<typeof mountField>) => (wrapper.emitted('update:valid') ?? []).at(-1)?.[0]

describe('EditionSyncScheduleField', () => {
  it('keeps the custom editor open when the expression is cleared instead of flipping to Never', async () => {
    const wrapper = mountField('15 4 * * *')
    expect(wrapper.find('#edition-sync-cron').exists()).toBe(true)

    await wrapper.get('#edition-sync-cron').setValue('')
    expect(wrapper.emitted('update:cronExpression')!.at(-1)).toEqual([null])
    await wrapper.setProps({ cronExpression: null })

    expect(wrapper.find('#edition-sync-cron').exists()).toBe(true)
    expect((wrapper.get('#edition-sync-preset').element as HTMLSelectElement).value).toBe('__custom__')
    expect(lastValid(wrapper)).toBe(false)
  })

  it('is valid for a preset and for a five-field custom expression', async () => {
    expect(lastValid(mountField('0 2 * * *'))).toBe(true)
    expect(lastValid(mountField(null))).toBe(true)
    const custom = mountField('15 4 * * *')
    expect(lastValid(custom)).toBe(true)
    await custom.setProps({ cronExpression: 'nonsense' })
    expect(lastValid(custom)).toBe(false)
  })

  it('is invalid for a run window outside 1 to 24 whole hours', async () => {
    const wrapper = mountField('0 2 * * *', 8)
    await wrapper.setProps({ runHours: 0 })
    expect(lastValid(wrapper)).toBe(false)
    expect(wrapper.text()).toContain('from 1 to 24')
    await wrapper.setProps({ runHours: 2.5 })
    expect(lastValid(wrapper)).toBe(false)
    await wrapper.setProps({ runHours: Number.NaN })
    expect(lastValid(wrapper)).toBe(false)
    await wrapper.setProps({ runHours: 24 })
    expect(lastValid(wrapper)).toBe(true)
  })

  it('reports a cleared hours field as invalid rather than ignoring it', async () => {
    const wrapper = mountField('0 2 * * *', 8)
    await wrapper.get('#edition-sync-hours').setValue('')
    expect(wrapper.emitted('update:runHours')!.at(-1)![0]).toBeNaN()
  })
})
