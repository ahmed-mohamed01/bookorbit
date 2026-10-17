import { watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export function useRequestPrefillParam(options: { ready: Ref<boolean>; title: Ref<string>; author: Ref<string>; search: () => Promise<void> }) {
  const route = useRoute()
  const router = useRouter()
  let applyingPrefill: string | undefined
  async function applyPrefill() {
    if (!options.ready.value || typeof route.query.title !== 'string' || !route.query.title.trim()) return
    const incomingTitle = route.query.title
    const incomingAuthor = typeof route.query.author === 'string' ? route.query.author : ''
    const key = JSON.stringify([incomingTitle, incomingAuthor])
    if (applyingPrefill === key) return
    applyingPrefill = key
    options.title.value = incomingTitle
    options.author.value = incomingAuthor
    try {
      await options.search()
      if (route.query.title !== incomingTitle || (route.query.author ?? '') !== incomingAuthor) return
      const query = { ...route.query }
      delete query.title
      delete query.author
      await router.replace({ query })
    } finally {
      if (applyingPrefill === key) applyingPrefill = undefined
    }
  }
  watch([() => route.query.title, () => route.query.author, options.ready], applyPrefill, { immediate: true })
}
