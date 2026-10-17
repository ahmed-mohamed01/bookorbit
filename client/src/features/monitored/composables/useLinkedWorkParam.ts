import { onScopeDispose, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { linkedWork } from '../lib/linked-work'

export function useLinkedWorkParam<T extends { id: string }>(options: {
  works: Ref<readonly T[]>
  ready: Ref<boolean>
  active: Ref<boolean>
  load: () => Promise<void>
  open: (work: T) => void
}) {
  const route = useRoute()
  const router = useRouter()
  const authorId = String(route.params.id)
  let generation = 0
  let pending: unknown
  onScopeDispose(() => {
    generation++
  })

  async function resolve() {
    if (!options.ready.value || !options.active.value || String(route.params.id) !== authorId) return
    const id = route.query.work
    if (id === undefined || pending === id) return
    pending = id
    const startedAt = ++generation
    const current = () => startedAt === generation && options.active.value && String(route.params.id) === authorId && route.query.work === id
    try {
      let work = linkedWork(id, options.works.value)
      if (!work) {
        await options.load()
        work = linkedWork(id, options.works.value)
      }
      if (!current()) return
      if (work) options.open(work)
      const query = { ...route.query }
      delete query.work
      await router.replace({ query })
    } finally {
      if (startedAt === generation) pending = undefined
    }
  }

  watch(
    [() => route.params.id, () => route.query.work, options.active],
    () => {
      generation++
      pending = undefined
    },
    { flush: 'sync' },
  )
  watch([() => route.params.id, () => route.query.work, options.active, options.ready], () => void resolve(), { immediate: true })
  return { openLinkedWork: resolve }
}
