import { inject, provide, type InjectionKey } from 'vue'
import type { useWebSerialSettings } from '../../composables/useWebSerialSettings'

export type WebSerialSettingsState = ReturnType<typeof useWebSerialSettings>

const KEY: InjectionKey<WebSerialSettingsState> = Symbol('web-serial-settings')

export function provideWebSerialSettings(state: WebSerialSettingsState): void {
  provide(KEY, state)
}

export function useWebSerialSettingsContext(): WebSerialSettingsState {
  const state = inject(KEY)
  if (!state) throw new Error('Web Serials settings context is missing')
  return state
}
