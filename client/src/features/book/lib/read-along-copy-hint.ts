import type { ReadAlongCopySizes } from '@bookorbit/types'
import { formatBytes } from '@/lib/formatting'

const KEY = 'book.detail.editionLink.readAlong.keepCopy'

type Translate = (key: string, named?: Record<string, unknown>) => string

/**
 * What a kept Storyteller copy would cost, for the choice made before a build runs. Only the source
 * files are priced: the read-along itself does not exist yet, and the library's own copies are never
 * deleted by this feature, so offering their size would offer space that cannot be freed.
 *
 * Over shared paths Storyteller reads the sources where they are and keeps no copy of them, which is
 * why the caller says whether a transport is known yet: before a build there is none, so the hint
 * says the cost depends rather than picking one.
 */
export function readAlongKeepCopyHint(sizes: ReadAlongCopySizes, transportKnown: boolean, t: Translate): string {
  const { epub, audio } = sizes
  if (epub === null || audio === null) return t(`${KEY}.hintUnknownSize`)

  const sourceSizes = { epub: formatBytes(epub), audio: formatBytes(audio) }
  return transportKnown ? t(`${KEY}.hintBeforeBuild`, sourceSizes) : t(`${KEY}.hintBeforeTransport`, sourceSizes)
}
