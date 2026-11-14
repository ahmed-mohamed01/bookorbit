// Fork: Convert to M4B. Admin settings, shared so the confirm dialog can read the backup window.
import { computed, ref } from 'vue'
import { Permission, type AudioConvertSettings, type UpdateAudioConvertSettingsPayload } from '@bookorbit/types'

import { usePermissions } from '@/features/auth/composables/usePermissions'
import * as audioConvertApi from '../api/audio-convert'
import { useAudioConvertEnabled } from './useAudioConvertEnabled'

const settings = ref<AudioConvertSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<number | null>(null)
let pending: Promise<void> | null = null

export function useAudioConvertSettings() {
  const { hasPermission } = usePermissions()
  const { setState } = useAudioConvertEnabled({ autoload: false })

  const canRead = computed(() => hasPermission(Permission.ManageAppSettings))

  function load(force = false): Promise<void> {
    if (!canRead.value) return Promise.resolve()
    if (pending) return pending
    if (!force && settings.value) return Promise.resolve()
    loading.value = settings.value === null
    error.value = null
    pending = audioConvertApi
      .fetchAudioConvertSettings()
      .then((result) => {
        settings.value = result
      })
      .catch((e: unknown) => {
        error.value = e instanceof audioConvertApi.AudioConvertHttpError ? e.status : 0
      })
      .finally(() => {
        loading.value = false
        pending = null
      })
    return pending
  }

  async function save(payload: UpdateAudioConvertSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await audioConvertApi.updateAudioConvertSettings(payload)
      setState(settings.value.enabled, settings.value)
      return true
    } catch (e) {
      error.value = e instanceof audioConvertApi.AudioConvertHttpError ? e.status : 0
      return false
    } finally {
      saving.value = false
    }
  }

  /** `null` when the viewer cannot read settings, so copy can stay vague rather than wrong. */
  const backupDays = computed<number | null>(() => settings.value?.backupDays ?? null)

  return { settings, loading, saving, error, canRead, backupDays, load, save }
}
