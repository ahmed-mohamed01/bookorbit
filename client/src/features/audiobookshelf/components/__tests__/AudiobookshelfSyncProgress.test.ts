import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import AudiobookshelfSyncProgress from '../AudiobookshelfSyncProgress.vue'

const syncing = ref(false)
const syncMode = ref<'incremental' | 'full' | null>(null)
const lastResult = ref(null)
const error = ref<string | null>(null)

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({ syncing, syncMode, lastResult, error }),
}))

describe('AudiobookshelfSyncProgress', () => {
  beforeEach(() => {
    syncing.value = false
    syncMode.value = null
    lastResult.value = null
    error.value = null
  })

  it('presents in-flight sync as an indeterminate accessible status', () => {
    syncing.value = true
    syncMode.value = 'incremental'

    const wrapper = mount(AudiobookshelfSyncProgress)

    expect(wrapper.get('[role="status"]').text()).toContain('Sync in progress')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('aria-valuenow')
    expect(wrapper.html()).not.toContain('w-1/3')
    expect(wrapper.text()).not.toContain('%')
  })

  it('keeps the full resync label distinct', () => {
    syncing.value = true
    syncMode.value = 'full'

    const wrapper = mount(AudiobookshelfSyncProgress)

    expect(wrapper.get('[role="status"]').text()).toContain('Full resync in progress')
  })
})
