import { computed, ref } from 'vue'

/**
 * Stops infinite scroll from hammering an endpoint that keeps failing. The sentinel re-enters view
 * the moment a failed page leaves `loading`, so without a cap the list retries forever; a manual
 * retry or a fresh query clears it.
 */
export function usePageRetryGuard(limit = 2) {
  const failures = ref(0)
  const blocked = computed(() => failures.value >= limit)

  function record(failed: boolean) {
    failures.value = failed ? failures.value + 1 : 0
  }

  function reset() {
    failures.value = 0
  }

  return { failures, blocked, record, reset }
}
