import type { LibraryFolder } from '@bookorbit/types'

export type MonitorDestination = { libraryId: number | null; folderId: number | null }

type DestinationLibrary = { id: number; folders: LibraryFolder[] }

/**
 * Where a new monitor files its grabs before anyone touches the form: wherever the request settings
 * already send this medium, since a monitored grab becomes a book request like any other.
 *
 * The instance default can name a library this account cannot reach, and the server refuses a
 * monitor pointed at one, so it is only offered when the account can see it. A folder is kept only
 * while it belongs to that library, for the same reason.
 */
export function monitorDestinationDefault(
  libraries: readonly DestinationLibrary[],
  preferred: { libraryId: number | null; folderId: number | null },
): MonitorDestination {
  const library = libraries.find((entry) => entry.id === preferred.libraryId)
  if (!library) return { libraryId: libraries[0]?.id ?? null, folderId: null }
  return { libraryId: library.id, folderId: library.folders.some((folder) => folder.id === preferred.folderId) ? preferred.folderId : null }
}
