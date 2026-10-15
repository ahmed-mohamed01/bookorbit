import { inject, provide, type InjectionKey } from 'vue'
import type { useWebSerialExtensions } from '../../composables/useWebSerialExtensions'

export type WebSerialExtensionsState = ReturnType<typeof useWebSerialExtensions>

const KEY: InjectionKey<WebSerialExtensionsState> = Symbol('web-serial-extensions')

export function provideWebSerialExtensions(state: WebSerialExtensionsState): void {
  provide(KEY, state)
}

export function useWebSerialExtensionsContext(): WebSerialExtensionsState {
  const state = inject(KEY)
  if (!state) throw new Error('Web Serials extensions context is missing')
  return state
}
