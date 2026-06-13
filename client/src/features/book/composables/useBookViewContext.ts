import { onMounted, watch, type Ref } from 'vue'
import { useBookNavigation } from './useBookNavigation'
import type { BookSlot } from './useBookWindow'

export function useBookViewContext(slots: Ref<BookSlot[]>, total: Ref<number>, loadMore: () => Promise<unknown> | unknown) {
  const { setBookSlotContext, registerLoadMore } = useBookNavigation()
  const syncBookContext = () => {
    setBookSlotContext(slots.value, total.value)
  }

  watch([slots, total], () => syncBookContext(), { immediate: true })

  onMounted(() => {
    registerLoadMore(async () => {
      await loadMore()
      syncBookContext()
    })
  })
}
