import { ref } from 'vue'
import type { WebSerialEngineHealth, WebSerialKind, WebSerialNovelEngine } from '@bookorbit/types'
import { testWebSerialEngine } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import type { WebSerialEngineDraft } from '../lib/settingsDraft'

/** The "Test connection" check of each engine card, against the typed-in (possibly unsaved) connection. */
export function useWebSerialEngineTest() {
  const testing = ref<Record<WebSerialKind, boolean>>({ manga: false, novel: false })
  const testResults = ref<Record<WebSerialKind, WebSerialEngineHealth | null>>({ manga: null, novel: null })
  const testError = ref<Record<WebSerialKind, string | null>>({ manga: null, novel: null })

  async function test(kind: WebSerialKind, engine: WebSerialEngineDraft & { engine?: WebSerialNovelEngine }): Promise<WebSerialEngineHealth | null> {
    const password = engine.password.trim()
    testing.value = { ...testing.value, [kind]: true }
    testError.value = { ...testError.value, [kind]: null }
    try {
      const result = await testWebSerialEngine({
        kind,
        ...(kind === 'novel' && engine.engine ? { engine: engine.engine } : {}),
        url: engine.url.trim(),
        username: engine.username.trim() || null,
        ...(password ? { password } : {}),
      })
      testResults.value = { ...testResults.value, [kind]: result }
      return result
    } catch (cause) {
      testError.value = { ...testError.value, [kind]: messageOf(cause, 'webSerials.api.testEngine') }
      return null
    } finally {
      testing.value = { ...testing.value, [kind]: false }
    }
  }

  function showResult(kind: WebSerialKind, health: WebSerialEngineHealth | null): void {
    testResults.value = { ...testResults.value, [kind]: health }
  }

  function clearError(kind: WebSerialKind): void {
    testError.value = { ...testError.value, [kind]: null }
  }

  return { testing, testResults, testError, test, showResult, clearError }
}
