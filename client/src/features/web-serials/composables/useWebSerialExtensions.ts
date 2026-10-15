import { computed, onScopeDispose, reactive, ref } from 'vue'
import type { WebSerialMangaExtension } from '@bookorbit/types'
import {
  addMangaRepo,
  fetchMangaExtensions,
  fetchMangaRepos,
  refreshMangaExtensions,
  removeMangaRepo,
  runMangaExtensionAction,
  type WebSerialExtensionAction,
} from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

export const EXTENSION_PAGE_SIZE = 50
export const EXTENSION_SEARCH_DELAY_MS = 300
const INSTALLED_LIMIT = 100

export function isRepoUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && value.trim().length <= 2048
  } catch {
    return false
  }
}

/** `onChanged` runs after an install, uninstall or update so the page can reload its source chips. */
export function useWebSerialExtensions(onChanged: () => void | Promise<void>) {
  const installed = ref<WebSerialMangaExtension[]>([])
  const installedLoading = ref(false)
  const installedError = ref<string | null>(null)
  const installedTotal = ref(0)

  const available = ref<WebSerialMangaExtension[]>([])
  const availableTotal = ref(0)
  const languages = ref<string[]>([])
  const availableLoading = ref(false)
  const availableError = ref<string | null>(null)
  const search = ref('')
  const lang = ref('')
  const showAdult = ref(false)
  const refreshing = ref(false)
  const hasMore = computed(() => available.value.length < availableTotal.value)

  const repos = ref<string[]>([])
  const reposLoading = ref(false)
  const reposError = ref<string | null>(null)
  const repoBusy = ref<string | null>(null)
  const addingRepo = ref(false)
  const repoActionError = ref<string | null>(null)

  const busy = reactive<Record<string, WebSerialExtensionAction>>({})
  const actionError = ref<string | null>(null)
  const pendingUninstall = ref<WebSerialMangaExtension | null>(null)

  let availableController: AbortController | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = null
  }

  onScopeDispose(() => {
    clearTimer()
    availableController?.abort()
  })

  async function loadInstalled(append = false): Promise<void> {
    installedLoading.value = true
    installedError.value = null
    try {
      const page = await fetchMangaExtensions({ installed: true, adult: true, limit: INSTALLED_LIMIT, offset: append ? installed.value.length : 0 })
      installed.value = append ? [...installed.value, ...page.items] : page.items
      installedTotal.value = page.total
    } catch (cause) {
      installedError.value = messageOf(cause, 'webSerials.api.mangaExtensions')
    } finally {
      installedLoading.value = false
    }
  }

  async function loadAvailable(append: boolean): Promise<void> {
    availableController?.abort()
    const controller = new AbortController()
    availableController = controller
    availableLoading.value = true
    availableError.value = null
    try {
      const page = await fetchMangaExtensions(
        {
          query: search.value.trim() || undefined,
          lang: lang.value || undefined,
          adult: showAdult.value,
          limit: EXTENSION_PAGE_SIZE,
          offset: append ? available.value.length : 0,
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      available.value = append ? [...available.value, ...page.items] : page.items
      availableTotal.value = page.total
      languages.value = page.languages
    } catch (cause) {
      if (controller.signal.aborted) return
      availableError.value = messageOf(cause, 'webSerials.api.mangaExtensions')
    } finally {
      if (availableController === controller) availableLoading.value = false
    }
  }

  async function loadRepos(): Promise<void> {
    reposLoading.value = true
    reposError.value = null
    try {
      repos.value = await fetchMangaRepos()
    } catch (cause) {
      reposError.value = messageOf(cause, 'webSerials.api.repos')
    } finally {
      reposLoading.value = false
    }
  }

  async function open(): Promise<void> {
    await Promise.all([loadInstalled(), loadAvailable(false), loadRepos()])
  }

  function setSearch(value: string): void {
    search.value = value
    clearTimer()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void loadAvailable(false)
    }, EXTENSION_SEARCH_DELAY_MS)
  }

  function setLang(value: string): void {
    lang.value = value
    clearTimer()
    void loadAvailable(false)
  }

  function setShowAdult(value: boolean): void {
    showAdult.value = value
    clearTimer()
    void loadAvailable(false)
  }

  function loadMoreInstalled(): void {
    if (installedLoading.value || installed.value.length >= installedTotal.value) return
    void loadInstalled(true)
  }

  function loadMore(): void {
    if (availableLoading.value || !hasMore.value) return
    void loadAvailable(true)
  }

  async function refreshList(): Promise<void> {
    if (refreshing.value) return
    refreshing.value = true
    availableError.value = null
    try {
      await refreshMangaExtensions()
      await Promise.all([loadAvailable(false), loadInstalled()])
    } catch (cause) {
      availableError.value = messageOf(cause, 'webSerials.api.refreshExtensions')
    } finally {
      refreshing.value = false
    }
  }

  function patchAvailable(updated: WebSerialMangaExtension): void {
    available.value = available.value.map((item) => (item.pkgName === updated.pkgName ? { ...item, ...updated } : item))
  }

  async function act(extension: WebSerialMangaExtension, action: WebSerialExtensionAction): Promise<boolean> {
    if (busy[extension.pkgName]) return false
    busy[extension.pkgName] = action
    actionError.value = null
    try {
      const updated = await runMangaExtensionAction(extension.pkgName, action)
      patchAvailable(updated)
      await loadInstalled()
      await onChanged()
      return true
    } catch (cause) {
      actionError.value = messageOf(cause, 'webSerials.api.extensionChange')
      return false
    } finally {
      delete busy[extension.pkgName]
    }
  }

  function install(extension: WebSerialMangaExtension): Promise<boolean> {
    return act(extension, 'install')
  }

  function update(extension: WebSerialMangaExtension): Promise<boolean> {
    return act(extension, 'update')
  }

  function requestUninstall(extension: WebSerialMangaExtension): void {
    pendingUninstall.value = extension
  }

  function cancelUninstall(): void {
    pendingUninstall.value = null
  }

  async function confirmUninstall(): Promise<boolean> {
    const extension = pendingUninstall.value
    if (!extension) return false
    const done = await act(extension, 'uninstall')
    pendingUninstall.value = null
    return done
  }

  async function addRepo(url: string): Promise<boolean> {
    const trimmed = url.trim()
    if (!isRepoUrl(trimmed) || addingRepo.value) return false
    addingRepo.value = true
    repoActionError.value = null
    try {
      await addMangaRepo({ url: trimmed })
      await Promise.all([loadRepos(), loadAvailable(false), loadInstalled()])
      return true
    } catch (cause) {
      repoActionError.value = messageOf(cause, 'webSerials.api.addRepo')
      return false
    } finally {
      addingRepo.value = false
    }
  }

  async function removeRepo(url: string): Promise<boolean> {
    if (repoBusy.value) return false
    repoBusy.value = url
    repoActionError.value = null
    try {
      await removeMangaRepo(url)
      repos.value = repos.value.filter((repo) => repo !== url)
      await Promise.all([loadAvailable(false), loadInstalled()])
      return true
    } catch (cause) {
      repoActionError.value = messageOf(cause, 'webSerials.api.removeRepo')
      return false
    } finally {
      repoBusy.value = null
    }
  }

  return {
    installed,
    installedLoading,
    installedError,
    installedTotal,
    loadMoreInstalled,
    available,
    availableTotal,
    languages,
    availableLoading,
    availableError,
    search,
    lang,
    showAdult,
    refreshing,
    hasMore,
    repos,
    reposLoading,
    reposError,
    repoBusy,
    addingRepo,
    repoActionError,
    busy,
    actionError,
    pendingUninstall,
    open,
    loadInstalled,
    setSearch,
    setLang,
    setShowAdult,
    loadMore,
    refreshList,
    install,
    update,
    requestUninstall,
    cancelUninstall,
    confirmUninstall,
    addRepo,
    removeRepo,
  }
}
