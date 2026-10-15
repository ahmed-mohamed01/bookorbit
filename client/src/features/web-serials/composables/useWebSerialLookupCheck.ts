import { ref } from 'vue'
import type { WebSerialLookupHealth } from '@bookorbit/types'
import { testLookup } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

/** The "Check now" test of the series details card. */
export function useWebSerialLookupCheck() {
  const lookupHealth = ref<WebSerialLookupHealth | null>(null)
  const testingLookup = ref(false)
  const lookupTestError = ref<string | null>(null)

  async function runLookupTest(): Promise<WebSerialLookupHealth | null> {
    testingLookup.value = true
    lookupTestError.value = null
    try {
      const result = await testLookup()
      lookupHealth.value = result
      return result
    } catch (cause) {
      lookupTestError.value = messageOf(cause, 'webSerials.api.testLookup')
      return null
    } finally {
      testingLookup.value = false
    }
  }

  return { lookupHealth, testingLookup, lookupTestError, runLookupTest }
}
