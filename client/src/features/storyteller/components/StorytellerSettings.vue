<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, FolderTree, Library, Link, Loader2, Plus, Save, Trash2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import {
  Permission,
  type StorytellerConnectionTestResult,
  type StorytellerPathMapping,
  type StorytellerReadaloudLocationType,
  type StorytellerSetupProblem,
  type StorytellerTransport,
} from '@bookorbit/types'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import PathPrefixCombobox from '@/components/ui/PathPrefixCombobox.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatDate } from '@/i18n/formatters'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import { isReadAlongTargetLibrary } from '../lib/read-along-libraries'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { useStorytellerSettings, type StorytellerSettingsDraft } from '../composables/useStorytellerSettings'

// Mirrors UpsertStorytellerSettingsDto's @ArrayMaxSize(100) on pathMappings, so the editor can never
// build a payload the backend would reject.
const PATH_MAPPING_MAX_ROWS = 100
const PREFIX_MAX_LENGTH = 500

type ConnectionStatus = 'connected' | 'failed' | 'unchecked' | 'unconfigured'

const CONNECTION_STATUS_KEYS: Record<ConnectionStatus, string> = {
  connected: 'settings.integrations.storyteller.status.connected',
  failed: 'settings.integrations.storyteller.status.failed',
  unchecked: 'settings.integrations.storyteller.status.unchecked',
  unconfigured: 'settings.integrations.storyteller.status.unconfigured',
}

const CONNECTION_STATUS_TONES: Record<ConnectionStatus, string> = {
  connected: 'text-primary',
  failed: 'text-destructive',
  unchecked: 'text-muted-foreground',
  unconfigured: 'text-muted-foreground',
}

const PROBLEM_MESSAGE_KEYS: Record<StorytellerSetupProblem, string> = {
  server_unreachable: 'settings.integrations.storyteller.problems.serverUnreachable',
  auth_failed: 'settings.integrations.storyteller.problems.authFailed',
  no_path_mappings: 'settings.integrations.storyteller.problems.noPathMappings',
  readaloud_location_not_custom_folder: 'settings.integrations.storyteller.problems.readaloudLocationNotCustomFolder',
  readaloud_folder_not_mapped: 'settings.integrations.storyteller.problems.readaloudFolderNotMapped',
  target_library_missing: 'settings.integrations.storyteller.problems.targetLibraryMissing',
  target_library_not_book_per_file: 'settings.integrations.storyteller.problems.targetLibraryNotBookPerFile',
  target_library_disallows_epub: 'settings.integrations.storyteller.problems.targetLibraryDisallowsEpub',
}

const LOCATION_TYPE_KEYS: Record<StorytellerReadaloudLocationType, string> = {
  SUFFIX: 'settings.integrations.storyteller.readaloudLocationTypes.SUFFIX',
  SIBLING_FOLDER: 'settings.integrations.storyteller.readaloudLocationTypes.SIBLING_FOLDER',
  INTERNAL: 'settings.integrations.storyteller.readaloudLocationTypes.INTERNAL',
  CUSTOM_FOLDER: 'settings.integrations.storyteller.readaloudLocationTypes.CUSTOM_FOLDER',
}

const TRANSPORT_LABEL_KEYS: Record<Exclude<StorytellerTransport, 'auto'>, string> = {
  'shared-paths': 'settings.integrations.storyteller.transport.options.sharedPaths.label',
  'api-transfer': 'settings.integrations.storyteller.transport.options.apiTransfer.label',
}

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { t } = useI18n()
const { hasPermission } = usePermissions()
const { settings, loading, saving, testing, error, fetchSettings, saveSettings, testConnection } = useStorytellerSettings()
const { libraries, fetchLibraries } = useLibraries()

const canManage = computed(() => hasPermission(Permission.ManageAppSettings))

const draft = reactive<StorytellerSettingsDraft>({
  serverUrl: '',
  username: '',
  password: '',
  pathMappings: [],
  targetLibraryId: null,
  targetFolderId: null,
  transport: 'auto',
  deleteRemoteAfterImport: true,
  collectionName: '',
})
const passwordVisible = ref(false)
const testResult = ref<StorytellerConnectionTestResult | null>(null)

const canTest = computed(() =>
  Boolean(draft.serverUrl.trim() && draft.username.trim() && (draft.password.trim() || settings.value?.passwordConfigured)),
)
// The stored URL is already an origin plus path, so a trailing slash is the only difference between
// two spellings that still name the same server.
function sameServer(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}
// The server drops the stored password whenever the saved host changes without a password in the
// same payload, and the save sends serverUrl on any diff. So a blank password field only means
// "keep the saved one" while the URL still points at the server that password belongs to.
const passwordWillBeCleared = computed(
  () => Boolean(settings.value?.passwordConfigured) && !draft.password.trim() && !sameServer(draft.serverUrl, settings.value?.serverUrl ?? ''),
)
const passwordPlaceholder = computed(() => {
  if (passwordWillBeCleared.value) return t('settings.integrations.storyteller.connection.password.placeholderNewServer')
  if (settings.value?.passwordConfigured) return t('settings.integrations.storyteller.connection.password.placeholderConfigured')
  return t('settings.integrations.storyteller.connection.password.placeholderUnset')
})
const targetLibraries = computed(() => libraries.value.filter(isReadAlongTargetLibrary))
const selectedLibrary = computed(() => libraries.value.find((library) => library.id === draft.targetLibraryId) ?? null)
const targetFolders = computed(() => selectedLibrary.value?.folders ?? [])
const showDeleteRemoteToggle = computed(() => draft.transport !== 'shared-paths')

// Every folder BookOrbit scans, not just the read-along library's: a mapping has to cover wherever
// the source ebook and audiobook live, which is rarely the folder the read-along lands in.
const libraryFolderPaths = computed(() => {
  const paths = new Set<string>()
  for (const library of libraries.value) for (const folder of library.folders ?? []) if (folder.path) paths.add(folder.path)
  return [...paths].sort()
})

// `testResult` is seeded from the stored check, so this is the last check this page knows about
// whether it was run here or on an earlier visit. A failed manual test clears it, hence the fallback.
const latestCheck = computed(() => testResult.value ?? settings.value?.lastCheck ?? null)

// The read-aloud folder is the one Storyteller-side path the mapping must cover, and only a custom
// folder reports it as a real path: the other location types name a suffix or a sibling folder.
const storytellerFolderPaths = computed(() => {
  const check = latestCheck.value
  if (!check || check.readaloudLocationType !== 'CUSTOM_FOLDER' || !check.readaloudLocation) return []
  return [check.readaloudLocation]
})

const isConfigured = computed(() => Boolean(settings.value?.serverUrl && settings.value.username && settings.value.passwordConfigured))
const connectionStatus = computed<ConnectionStatus>(() => {
  if (!isConfigured.value) return 'unconfigured'
  if (!latestCheck.value) return 'unchecked'
  return latestCheck.value.ok ? 'connected' : 'failed'
})
const connectionOk = computed(() => connectionStatus.value === 'connected')
const connectionStatusLabel = computed(() => t(CONNECTION_STATUS_KEYS[connectionStatus.value]))
const connectionStatusTone = computed(() => CONNECTION_STATUS_TONES[connectionStatus.value])
const lastCheckedLabel = computed(() => {
  if (!isConfigured.value) return null
  const checkedAt = latestCheck.value?.checkedAt ?? settings.value?.lastCheckedAt
  if (!checkedAt) return null
  const date = new Date(checkedAt)
  if (Number.isNaN(date.getTime())) return null
  return t('settings.integrations.storyteller.status.checkedAt', {
    date: formatDate(date, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  })
})

function applySettingsToDraft(value: NonNullable<typeof settings.value>): void {
  draft.serverUrl = value.serverUrl ?? ''
  draft.username = value.username ?? ''
  draft.password = ''
  draft.pathMappings = value.pathMappings.map((mapping) => ({ ...mapping }))
  draft.targetLibraryId = value.targetLibraryId
  draft.targetFolderId = value.targetFolderId
  draft.transport = value.transport
  draft.deleteRemoteAfterImport = value.deleteRemoteAfterImport
  draft.collectionName = value.collectionName ?? ''
}

onMounted(async () => {
  if (!canManage.value) return
  await fetchSettings()
  if (settings.value) {
    applySettingsToDraft(settings.value)
    // The stored check is the same shape a manual test returns, so a reload opens on the last known
    // state rather than on nothing.
    testResult.value = settings.value.lastCheck
  }
  await fetchLibraries()
})

function togglePasswordVisibility(): void {
  passwordVisible.value = !passwordVisible.value
}

function handleAddMappingRow(): void {
  if (draft.pathMappings.length >= PATH_MAPPING_MAX_ROWS) return
  draft.pathMappings = [...draft.pathMappings, { localPrefix: '', remotePrefix: '' }]
}

function handleRemoveMappingRow(index: number): void {
  draft.pathMappings = draft.pathMappings.filter((_, i) => i !== index)
}

function handleLocalPrefixUpdate(index: number, value: string): void {
  draft.pathMappings = draft.pathMappings.map((mapping, i) => (i === index ? { ...mapping, localPrefix: value } : mapping))
}

function handleRemotePrefixUpdate(index: number, value: string): void {
  draft.pathMappings = draft.pathMappings.map((mapping, i) => (i === index ? { ...mapping, remotePrefix: value } : mapping))
}

function handleTransportChange(event: Event): void {
  draft.transport = (event.target as HTMLSelectElement).value as StorytellerTransport
}

function handleTargetLibraryChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  draft.targetLibraryId = value === '' ? null : Number(value)
  const library = libraries.value.find((candidate) => candidate.id === draft.targetLibraryId)
  if (!library?.folders.some((folder) => folder.id === draft.targetFolderId)) draft.targetFolderId = null
}

function handleTargetFolderChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  draft.targetFolderId = value === '' ? null : Number(value)
}

function savedPathMappings(): StorytellerPathMapping[] {
  return draft.pathMappings
    .map((mapping) => ({ localPrefix: mapping.localPrefix.trim(), remotePrefix: mapping.remotePrefix.trim() }))
    .filter((mapping) => mapping.localPrefix && mapping.remotePrefix)
}

async function handleSave(): Promise<void> {
  // Read before the save: a successful call overwrites `settings.value` with the server's response.
  const hostChanged = !sameServer(draft.serverUrl, settings.value?.serverUrl ?? '')
  const ok = await saveSettings({ ...draft, pathMappings: savedPathMappings() })
  if (ok) {
    // The stored password is never echoed back, so the plaintext input is cleared here rather than
    // by re-applying the saved settings, which would otherwise leave it sitting in the DOM.
    draft.password = ''
    // The server clears the stored check on a host change; the seeded copy has to go too, or it
    // keeps outranking it in `latestCheck` and the chip reports a host nobody has tested.
    if (hostChanged) testResult.value = null
    toast.success(t('settings.integrations.storyteller.save.success'))
  } else {
    toast.error(error.value ?? t('settings.integrations.storyteller.save.failure'))
  }
}

async function handleTestConnection(): Promise<void> {
  const result = await testConnection(draft)
  testResult.value = result
  if (!result) toast.error(error.value ?? t('settings.integrations.storyteller.testConnection.error'))
}

function problemMessage(problem: StorytellerSetupProblem): string {
  return t(PROBLEM_MESSAGE_KEYS[problem])
}

function locationTypeLabel(type: StorytellerReadaloudLocationType | null): string {
  if (!type) return t('settings.integrations.storyteller.testConnection.unknown')
  return t(LOCATION_TYPE_KEYS[type])
}

function transportLabel(transport: Exclude<StorytellerTransport, 'auto'> | null): string {
  if (transport) return t(TRANSPORT_LABEL_KEYS[transport])
  // On a successful check, no transport means the pinned shared-paths setting cannot be used; on a
  // failed one nothing was resolved at all, so there is nothing to name.
  const key = testResult.value?.ok ? 'testConnection.transportUnavailable' : 'testConnection.unknown'
  return t(`settings.integrations.storyteller.${key}`)
}
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader
      v-if="!props.embedded"
      :title="t('settings.integrations.storyteller.title')"
      :subtitle="t('settings.integrations.storyteller.subtitle')"
    />

    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('settings.integrations.noPermission') }}</p>

    <template v-else>
      <div v-if="loading" class="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" />
        {{ t('settings.integrations.storyteller.loading') }}
      </div>

      <template v-else>
        <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
          <div class="flex flex-wrap items-start gap-3">
            <Link class="mt-0.5 size-5 shrink-0 text-primary" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ t('settings.integrations.storyteller.connection.title') }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.connection.subtitle') }}</p>
            </div>
            <div data-testid="connection-status" class="flex flex-col items-start gap-0.5 sm:items-end">
              <span class="flex items-center gap-1.5 text-xs" :class="connectionStatusTone">
                <CheckCircle2 v-if="connectionOk" class="size-3.5 shrink-0" />
                <AlertCircle v-else class="size-3.5 shrink-0" />
                {{ connectionStatusLabel }}
              </span>
              <span v-if="lastCheckedLabel" class="text-xs text-muted-foreground">{{ lastCheckedLabel }}</span>
            </div>
          </div>

          <div class="space-y-4">
            <div class="space-y-1.5">
              <label for="storyteller-server-url" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {{ t('settings.integrations.storyteller.connection.serverUrl.label') }}
              </label>
              <input
                id="storyteller-server-url"
                v-model="draft.serverUrl"
                type="url"
                inputmode="url"
                autocomplete="url"
                :placeholder="t('settings.integrations.storyteller.connection.serverUrl.placeholder')"
                class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div class="space-y-1.5">
              <label for="storyteller-username" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {{ t('settings.integrations.storyteller.connection.username.label') }}
              </label>
              <input
                id="storyteller-username"
                v-model="draft.username"
                type="text"
                autocomplete="username"
                :placeholder="t('settings.integrations.storyteller.connection.username.placeholder')"
                class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div class="space-y-1.5">
              <label for="storyteller-password" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {{ t('settings.integrations.storyteller.connection.password.label') }}
              </label>
              <div class="flex gap-2">
                <input
                  id="storyteller-password"
                  v-model="draft.password"
                  v-bind="SECRET_INPUT_ATTRS"
                  type="text"
                  :class="{ 'input-secret': !passwordVisible }"
                  :placeholder="passwordPlaceholder"
                  class="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="button"
                  :aria-label="
                    passwordVisible
                      ? t('settings.integrations.storyteller.connection.password.hide')
                      : t('settings.integrations.storyteller.connection.password.show')
                  "
                  class="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground transition-colors hover:bg-muted/80"
                  @click="togglePasswordVisibility"
                >
                  <EyeOff v-if="passwordVisible" class="size-4" />
                  <Eye v-else class="size-4" />
                </button>
              </div>
              <p v-if="passwordWillBeCleared" data-testid="password-cleared-warning" class="flex items-start gap-1 text-xs text-destructive">
                <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
                {{ t('settings.integrations.storyteller.connection.password.clearedOnServerChange') }}
              </p>
              <p v-else-if="settings?.passwordConfigured" data-testid="password-configured" class="flex items-center gap-1 text-xs text-primary">
                <CheckCircle2 class="size-3.5" />
                {{ t('settings.integrations.storyteller.connection.password.configured') }}
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <button
                type="button"
                :disabled="testing || !canTest"
                :title="!canTest ? t('settings.integrations.storyteller.testConnection.disabledHint') : undefined"
                data-testid="test-connection"
                class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
                @click="handleTestConnection"
              >
                <Loader2 v-if="testing" class="size-3 animate-spin" />
                <CheckCircle2 v-else class="size-3" />
                {{
                  testing
                    ? t('settings.integrations.storyteller.testConnection.testing')
                    : t('settings.integrations.storyteller.testConnection.button')
                }}
              </button>
            </div>

            <div v-if="testResult" data-testid="test-result" class="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p class="flex items-center gap-1.5" :class="testResult.ok ? 'text-primary' : 'text-destructive'">
                <CheckCircle2 v-if="testResult.ok" class="size-3.5" />
                <AlertCircle v-else class="size-3.5" />
                {{
                  testResult.ok
                    ? t('settings.integrations.storyteller.testConnection.ok')
                    : (testResult.error ?? t('settings.integrations.storyteller.testConnection.failed'))
                }}
              </p>
              <div class="grid gap-1.5 sm:grid-cols-2">
                <div>
                  <span class="text-muted-foreground">{{ t('settings.integrations.storyteller.testConnection.serverVersion') }}</span>
                  <p class="mt-0.5 text-foreground">
                    {{ testResult.serverVersion ?? t('settings.integrations.storyteller.testConnection.unknown') }}
                  </p>
                </div>
                <div>
                  <span class="text-muted-foreground">{{ t('settings.integrations.storyteller.testConnection.readaloudLocationType') }}</span>
                  <p class="mt-0.5 text-foreground">{{ locationTypeLabel(testResult.readaloudLocationType) }}</p>
                </div>
                <div>
                  <span class="text-muted-foreground">{{ t('settings.integrations.storyteller.testConnection.readaloudLocation') }}</span>
                  <p class="mt-0.5 truncate text-foreground" :title="testResult.readaloudLocation ?? ''">
                    {{ testResult.readaloudLocation ?? t('settings.integrations.storyteller.testConnection.unknown') }}
                  </p>
                </div>
                <div>
                  <span class="text-muted-foreground">{{ t('settings.integrations.storyteller.testConnection.effectiveTransport') }}</span>
                  <p class="mt-0.5 text-foreground">{{ transportLabel(testResult.effectiveTransport) }}</p>
                </div>
                <div>
                  <span class="text-muted-foreground">{{ t('settings.integrations.storyteller.testConnection.sharedPathsReady') }}</span>
                  <p class="mt-0.5 text-foreground">
                    {{
                      testResult.sharedPathsReady
                        ? t('settings.integrations.storyteller.testConnection.sharedPathsReadyYes')
                        : t('settings.integrations.storyteller.testConnection.sharedPathsReadyNo')
                    }}
                  </p>
                </div>
              </div>
              <ul v-if="testResult.problems.length > 0" class="list-disc space-y-1 pl-4 text-muted-foreground">
                <li v-for="problem in testResult.problems" :key="problem">{{ problemMessage(problem) }}</li>
              </ul>
            </div>
          </div>

          <p v-if="error" data-testid="storyteller-settings-error" class="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle class="size-3.5 shrink-0" />
            {{ error }}
          </p>
        </section>

        <section class="space-y-3 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
          <div class="flex flex-wrap items-start gap-3">
            <FolderTree class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-sm">{{ t('settings.integrations.storyteller.pathMappings.title') }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.pathMappings.subtitle') }}</p>
            </div>
          </div>

          <p v-if="draft.pathMappings.length === 0" class="text-xs text-muted-foreground">
            {{ t('settings.integrations.storyteller.pathMappings.empty') }}
          </p>

          <div v-else class="space-y-2">
            <!-- Keyed by position, never by contents: a key that changes as the field is typed into
            unmounts the focused input and drops the caret after the first character. -->
            <div v-for="(mapping, index) in draft.pathMappings" :key="index" class="flex flex-wrap items-center gap-2">
              <PathPrefixCombobox
                class="flex-[1_1_10rem]"
                :model-value="mapping.remotePrefix"
                :options="storytellerFolderPaths"
                :maxlength="PREFIX_MAX_LENGTH"
                :label="t('settings.integrations.storyteller.pathMappings.remotePrefixLabel')"
                :placeholder="t('settings.integrations.storyteller.pathMappings.remotePrefixPlaceholder')"
                testid="remote-prefix"
                @update:model-value="handleRemotePrefixUpdate(index, $event)"
              />
              <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
              <PathPrefixCombobox
                class="flex-[1_1_10rem]"
                :model-value="mapping.localPrefix"
                :options="libraryFolderPaths"
                :maxlength="PREFIX_MAX_LENGTH"
                :label="t('settings.integrations.storyteller.pathMappings.localPrefixLabel')"
                :placeholder="t('settings.integrations.storyteller.pathMappings.localPrefixPlaceholder')"
                testid="local-prefix"
                @update:model-value="handleLocalPrefixUpdate(index, $event)"
              />
              <button
                type="button"
                :aria-label="t('settings.integrations.storyteller.pathMappings.removeRow')"
                data-testid="remove-path-mapping"
                class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                @click="handleRemoveMappingRow(index)"
              >
                <Trash2 class="size-3.5" />
              </button>
            </div>
          </div>

          <button
            type="button"
            :disabled="draft.pathMappings.length >= PATH_MAPPING_MAX_ROWS"
            data-testid="add-path-mapping"
            class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="handleAddMappingRow"
          >
            <Plus class="size-3" />
            {{ t('settings.integrations.storyteller.pathMappings.addRow') }}
          </button>
        </section>

        <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
          <div class="space-y-1.5">
            <label for="storyteller-transport" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {{ t('settings.integrations.storyteller.transport.label') }}
            </label>
            <select id="storyteller-transport" class="select-field w-full" :value="draft.transport" @change="handleTransportChange">
              <option value="auto">{{ t('settings.integrations.storyteller.transport.options.auto.label') }}</option>
              <option value="shared-paths">{{ t('settings.integrations.storyteller.transport.options.sharedPaths.label') }}</option>
              <option value="api-transfer">{{ t('settings.integrations.storyteller.transport.options.apiTransfer.label') }}</option>
            </select>
            <p class="text-xs text-muted-foreground">
              {{
                draft.transport === 'auto'
                  ? t('settings.integrations.storyteller.transport.options.auto.description')
                  : draft.transport === 'shared-paths'
                    ? t('settings.integrations.storyteller.transport.options.sharedPaths.description')
                    : t('settings.integrations.storyteller.transport.options.apiTransfer.description')
              }}
            </p>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1.5">
              <label
                for="storyteller-target-library"
                class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                <Library class="size-3.5" />
                {{ t('settings.integrations.storyteller.targetLibrary.label') }}
              </label>
              <select
                id="storyteller-target-library"
                class="select-field w-full"
                :value="draft.targetLibraryId ?? ''"
                @change="handleTargetLibraryChange"
              >
                <option value="" disabled>{{ t('settings.integrations.storyteller.targetLibrary.placeholder') }}</option>
                <option v-for="library in targetLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
              </select>
              <p class="text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.targetLibrary.hint') }}</p>
            </div>

            <div class="space-y-1.5">
              <label for="storyteller-target-folder" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {{ t('settings.integrations.storyteller.targetFolder.label') }}
              </label>
              <select
                id="storyteller-target-folder"
                class="select-field w-full"
                :disabled="draft.targetLibraryId === null"
                :value="draft.targetFolderId ?? ''"
                @change="handleTargetFolderChange"
              >
                <option value="">{{ t('settings.integrations.storyteller.targetFolder.placeholder') }}</option>
                <option v-for="folder in targetFolders" :key="folder.id" :value="folder.id" :title="folder.path">{{ folder.path }}</option>
              </select>
              <p class="text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.targetFolder.hint') }}</p>
            </div>
          </div>

          <div v-if="showDeleteRemoteToggle" class="flex items-center justify-between gap-4 border-t border-border pt-4">
            <div>
              <p class="text-sm">{{ t('settings.integrations.storyteller.deleteRemoteAfterImport.label') }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.deleteRemoteAfterImport.description') }}</p>
            </div>
            <ToggleSwitch v-model="draft.deleteRemoteAfterImport" />
          </div>

          <div class="space-y-1.5 border-t border-border pt-4">
            <label for="storyteller-collection-name" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {{ t('settings.integrations.storyteller.collectionName.label') }}
            </label>
            <input
              id="storyteller-collection-name"
              v-model="draft.collectionName"
              type="text"
              maxlength="255"
              :placeholder="t('settings.integrations.storyteller.collectionName.placeholder')"
              class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p class="text-xs text-muted-foreground">{{ t('settings.integrations.storyteller.collectionName.hint') }}</p>
          </div>

          <div class="flex justify-end border-t border-border pt-3">
            <button
              type="button"
              :disabled="saving || passwordWillBeCleared"
              :title="passwordWillBeCleared ? t('settings.integrations.storyteller.save.blockedByPassword') : undefined"
              data-testid="save-storyteller-settings"
              class="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              @click="handleSave"
            >
              <Loader2 v-if="saving" class="size-3.5 animate-spin" />
              <Save v-else class="size-3.5" />
              {{ t('settings.integrations.storyteller.save.button') }}
            </button>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
