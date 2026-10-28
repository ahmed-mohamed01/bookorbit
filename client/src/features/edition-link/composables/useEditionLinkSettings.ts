import { computed, ref } from 'vue'
import type { EditionLinkSettings } from '@bookorbit/types'
import { getEditionLinkSettings, updateEditionLinkSettings } from '../api/work'

export const DEFAULT_EDITION_LINK_SETTINGS: EditionLinkSettings = {
  enabled: true,
  shareReadingState: true,
  sameTypeAsOneWork: true,
  positionSync: 'rough',
  autoLinkStrong: false,
}

const SETTING_KEYS = Object.keys(DEFAULT_EDITION_LINK_SETTINGS) as (keyof EditionLinkSettings)[]

export function useEditionLinkSettings() {
  const saved = ref<EditionLinkSettings | null>(null)
  const draft = ref<EditionLinkSettings>({ ...DEFAULT_EDITION_LINK_SETTINGS })
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const dirtyPatch = computed<Partial<EditionLinkSettings>>(() => {
    const base = saved.value ?? DEFAULT_EDITION_LINK_SETTINGS
    const patch: Record<string, unknown> = {}
    for (const key of SETTING_KEYS) if (draft.value[key] !== base[key]) patch[key] = draft.value[key]
    return patch as Partial<EditionLinkSettings>
  })
  const dirty = computed(() => Object.keys(dirtyPatch.value).length > 0)

  function apply(next: EditionLinkSettings): void {
    saved.value = next
    draft.value = { ...next }
  }

  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      apply(await getEditionLinkSettings())
    } catch {
      error.value = 'edition_link_settings_load_failed'
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<boolean> {
    if (!dirty.value) return true
    saving.value = true
    error.value = null
    try {
      apply(await updateEditionLinkSettings(dirtyPatch.value))
      return true
    } catch {
      error.value = 'edition_link_settings_save_failed'
      return false
    } finally {
      saving.value = false
    }
  }

  return { saved, draft, loading, saving, error, dirty, fetchSettings, save }
}
