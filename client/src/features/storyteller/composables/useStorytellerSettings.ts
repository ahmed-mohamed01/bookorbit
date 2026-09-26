import { ref } from 'vue'
import { api } from '@/lib/api'
import type {
  StorytellerConnectionTestPayload,
  StorytellerConnectionTestResult,
  StorytellerPathMapping,
  StorytellerSettings,
  StorytellerTransport,
  UpsertStorytellerSettingsPayload,
} from '@bookorbit/types'

const BASE = '/api/v1/storyteller'

const settings = ref<StorytellerSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)

/** The panel's editable fields, as one shape. `password` is plain text only while the user is typing it. */
export interface StorytellerSettingsDraft {
  serverUrl: string
  username: string
  password: string
  pathMappings: StorytellerPathMapping[]
  targetLibraryId: number | null
  targetFolderId: number | null
  transport: StorytellerTransport
  deleteRemoteAfterImport: boolean
  collectionName: string
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({}))
  return new Error((body as { message?: string }).message ?? fallback)
}

function samePathMappings(a: StorytellerPathMapping[], b: StorytellerPathMapping[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Diffs a draft against the last loaded settings so a save only carries what actually changed. The
 * stored password is never readable, so it is included only when the user typed a replacement -
 * never because some other field also changed.
 */
export function buildStorytellerSettingsPayload(
  draft: StorytellerSettingsDraft,
  current: StorytellerSettings | null,
): UpsertStorytellerSettingsPayload {
  const payload: UpsertStorytellerSettingsPayload = {}

  const serverUrl = draft.serverUrl.trim()
  if (serverUrl !== (current?.serverUrl ?? '')) payload.serverUrl = serverUrl

  const username = draft.username.trim()
  if (username !== (current?.username ?? '')) payload.username = username

  const password = draft.password.trim()
  if (password) payload.password = password

  if (!samePathMappings(draft.pathMappings, current?.pathMappings ?? [])) payload.pathMappings = draft.pathMappings

  if (draft.targetLibraryId !== (current?.targetLibraryId ?? null)) payload.targetLibraryId = draft.targetLibraryId
  if (draft.targetFolderId !== (current?.targetFolderId ?? null)) payload.targetFolderId = draft.targetFolderId
  if (draft.transport !== (current?.transport ?? 'auto')) payload.transport = draft.transport
  // The instance default is to delete the Storyteller copy after import, so an unloaded draft is
  // diffed against true: assuming false here would send a spurious "keep" the admin never asked for.
  if (draft.deleteRemoteAfterImport !== (current?.deleteRemoteAfterImport ?? true)) payload.deleteRemoteAfterImport = draft.deleteRemoteAfterImport

  const collectionName = draft.collectionName.trim()
  if (collectionName !== (current?.collectionName ?? '')) payload.collectionName = collectionName || null

  return payload
}

export function useStorytellerSettings() {
  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const response = await api(`${BASE}/settings`)
      if (!response.ok) throw await responseError(response, 'Failed to load Storyteller settings')
      settings.value = await response.json()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load Storyteller settings'
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(draft: StorytellerSettingsDraft): Promise<boolean> {
    const payload = buildStorytellerSettingsPayload(draft, settings.value)
    saving.value = true
    error.value = null
    try {
      const response = await api(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw await responseError(response, 'Failed to save Storyteller settings')
      settings.value = await response.json()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save Storyteller settings'
      return false
    } finally {
      saving.value = false
    }
  }

  /**
   * Tests what is in the form, not what is stored, so a connection can be verified before it is
   * saved. The password is sent only when the user typed one; otherwise the server falls back to
   * the stored one, which the browser never sees.
   */
  async function testConnection(draft: StorytellerSettingsDraft): Promise<StorytellerConnectionTestResult | null> {
    const password = draft.password.trim()
    const payload: StorytellerConnectionTestPayload = {
      serverUrl: draft.serverUrl.trim(),
      username: draft.username.trim(),
      ...(password ? { password } : {}),
    }
    testing.value = true
    error.value = null
    try {
      const response = await api(`${BASE}/settings/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw await responseError(response, 'Failed to test the Storyteller connection')
      return await response.json()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to test the Storyteller connection'
      return null
    } finally {
      testing.value = false
    }
  }

  return {
    settings,
    loading,
    saving,
    testing,
    error,
    fetchSettings,
    saveSettings,
    testConnection,
  }
}
