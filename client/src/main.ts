import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { useLocaleStore } from './stores/locale'
import { useAuth } from './features/auth/composables/useAuth'
import { bootstrapSession } from './features/auth/composables/useSessionBootstrap'

// Chrome 124+ blocks aria-hidden from being applied to an element that contains
// a focused descendant. Reka UI's dialog uses the aria-hidden package which sets
// aria-hidden="true" on background content when a modal opens. If the focused
// element is in the background (e.g. a book card dropdown trigger), Chrome blocks
// it and logs a warning, leaving the background incorrectly accessible to screen
// readers. This observer proactively blurs the focused descendant the moment
// aria-hidden="true" lands, allowing the aria-hidden to succeed.
const ariaHiddenObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type !== 'attributes' || mutation.attributeName !== 'aria-hidden') continue
    const target = mutation.target as HTMLElement
    if (target.getAttribute('aria-hidden') !== 'true') continue
    const focused = document.activeElement
    if (focused instanceof HTMLElement && target.contains(focused)) {
      focused.blur()
    }
  }
})
ariaHiddenObserver.observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ['aria-hidden'],
})

const app = createApp(App)

app.use(createPinia())
app.use(i18n)

async function boot() {
  const localeStore = useLocaleStore()
  // Not awaited: login and setup never render the shell, and the router's lazy import reuses this request.
  void import('./components/AppLayout.vue').catch(() => undefined)
  await Promise.all([localeStore.setLocale(localeStore.locale), bootstrapSession()])
  app.use(router)
  app.mount('#app')

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (!useAuth().user.value || connection?.saveData) return
  const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void) => number }
  if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(prefetchPdfReader)
  else window.setTimeout(prefetchPdfReader, 5_000)
}

function prefetchPdfReader() {
  if (!useAuth().user.value) return
  void import('@embedpdf/pdfium/pdfium.wasm?url').then((wasm) => {
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.href = wasm.default
    document.head.append(link)
  })
}

void boot()
