import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { StorytellerExistingMatch } from '@bookorbit/types'
import ReadAlongBuildOptions from '../ReadAlongBuildOptions.vue'

type OptionsProps = InstanceType<typeof ReadAlongBuildOptions>['$props']

function mountOptions(props: Partial<OptionsProps> = {}) {
  return mount(ReadAlongBuildOptions, {
    props: {
      keepRemoteCopy: false,
      reclaimable: true,
      targetLibraryName: 'Readalouds',
      targetLibraries: [
        { id: 4, name: 'Readalouds' },
        { id: 5, name: 'Audio' },
      ],
      chosenTargetLibraryId: null,
      ...props,
    } as OptionsProps,
  })
}

const match = (aligned: boolean): StorytellerExistingMatch => ({ uuid: 'st-1', title: 'Dune', aligned }) as StorytellerExistingMatch

describe('ReadAlongBuildOptions', () => {
  it('says how long a build takes, where it lands, and commits only on Generate', async () => {
    const wrapper = mountOptions()

    expect(wrapper.text()).toContain('Storyteller can take an hour or more. Your editions keep syncing meanwhile.')
    expect(wrapper.get('[data-testid="read-along-destination"]').text()).toContain('Will be added to Readalouds')
    await wrapper.get('[data-testid="read-along-generate"]').trigger('click')
    await wrapper.get('[data-testid="read-along-options-cancel"]').trigger('click')

    expect(wrapper.emitted('generate')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('offers the keep-copy choice only when the copy can be reclaimed, and explains each choice', async () => {
    expect(mountOptions({ reclaimable: false }).find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)

    const wrapper = mountOptions()
    expect(wrapper.get('[data-testid="read-along-keep-copy-info"]').attributes('aria-label')).toBe(
      'Removed from Storyteller after import. BookOrbit keeps the only copy.',
    )
    await wrapper.get('[data-testid="read-along-keep-copy"]').trigger('click')
    expect(wrapper.emitted('update:keepRemoteCopy')?.[0]).toEqual([true])

    await wrapper.setProps({ keepRemoteCopy: true })
    expect(wrapper.get('[data-testid="read-along-keep-copy-info"]').attributes('aria-label')).toBe(
      'Storyteller keeps its copy after BookOrbit imports the read-along.',
    )
  })

  it('reveals the destination select only after Change and emits the choice', async () => {
    const wrapper = mountOptions()
    expect(wrapper.find('[data-testid="read-along-destination-select"]').exists()).toBe(false)

    await wrapper.get('[data-testid="read-along-destination-change"]').trigger('click')
    await wrapper.get('[data-testid="read-along-destination-select"]').setValue('5')

    expect(wrapper.emitted('update:targetLibraryId')?.[0]).toEqual([5])
  })

  it('falls back to a generic destination when the library is unknown', () => {
    expect(mountOptions({ targetLibraryName: null }).get('[data-testid="read-along-destination"]').text()).toContain(
      'Will be added to the read-along library',
    )
  })

  it('offers an aligned Storyteller book for import, and ignores an unaligned one', async () => {
    expect(
      mountOptions({ existingMatch: match(false) })
        .find('[data-testid="read-along-import"]')
        .exists(),
    ).toBe(false)

    const wrapper = mountOptions({ existingMatch: match(true) })
    const offer = wrapper.get('[data-testid="read-along-import"]')
    expect(offer.text()).toBe('Import "Dune" from Storyteller')
    await offer.trigger('click')
    expect(wrapper.emitted('importExisting')).toHaveLength(1)
  })

  it('holds Generate while a request is in flight', () => {
    expect(mountOptions({ busy: true }).get('[data-testid="read-along-generate"]').attributes('disabled')).toBeDefined()
  })
})
