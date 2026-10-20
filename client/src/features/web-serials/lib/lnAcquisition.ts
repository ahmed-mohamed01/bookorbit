import { parseReleaseVolumes } from '@bookorbit/types'
import type { ReleaseCandidateItem, ReleaseSelectionManifest, WebSerialPrintVolume, WebSerialVolumeState } from '@bookorbit/types'

export const releaseKey = (release: { indexerId: number; guid: string }) => `${release.indexerId}:${release.guid}`

export function offFormatKind(release: Pick<ReleaseCandidateItem, 'title' | 'format' | 'formats'>): 'manga' | 'audiobook' | null {
  const formats = [release.format, ...release.formats].map((format) => format?.toLowerCase())
  if (/\(manga\)|\bmanga\b/i.test(release.title) || formats.some((format) => format === 'cbz' || format === 'cbr')) return 'manga'
  if (/audiobook/i.test(release.title) || formats.some((format) => format === 'm4b' || format === 'mp3')) return 'audiobook'
  return null
}

export function countVolumes(volumes: readonly WebSerialPrintVolume[]): Record<WebSerialVolumeState, number> {
  const counts = { owned: 0, in_dock: 0, downloading: 0, requested: 0, missing: 0 }
  for (const volume of volumes) counts[volume.state]++
  return counts
}

export function unitVolumes(unit: ReleaseSelectionManifest['units'][number], max: number): number[] {
  return parseReleaseVolumes(unit.title ?? unit.primaryPath.split(/[\\/]/).pop() ?? '', max) ?? []
}

export function preselectMissingUnits(units: ReleaseSelectionManifest['units'], volumes: readonly WebSerialPrintVolume[]): Set<number> {
  const missing = new Set(volumes.filter((volume) => volume.state === 'missing').map((volume) => volume.volume))
  const max = Math.max(0, ...volumes.map((volume) => volume.volume))
  return new Set(
    units
      .filter((unit) => {
        const parsed = unitVolumes(unit, max)
        return parsed.length === 1 && missing.has(parsed[0]!)
      })
      .map((unit) => unit.index),
  )
}
