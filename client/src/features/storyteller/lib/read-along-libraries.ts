import type { Library } from '@bookorbit/types'

type LibraryDestination = Pick<Library, 'type'> & { allowedFormats?: string[] | null }

/**
 * The two rules the read-along build endpoint rejects on: a podcast library, or one whose allow-list
 * leaves out the EPUB the read-along is written as.
 *
 * `GET /api/v1/libraries` only selects `allowedFormats` for a superuser, so for everyone else the
 * field is absent. An empty allow-list already means "every format" server-side, and a list the API
 * never described is read the same way rather than thrown on mid-render.
 */
export function isReadAlongTargetLibrary(library: LibraryDestination): boolean {
  if (library.type !== 'books') return false
  const allowedFormats = library.allowedFormats
  return !allowedFormats || allowedFormats.length === 0 || allowedFormats.includes('epub')
}
