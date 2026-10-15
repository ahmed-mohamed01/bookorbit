import { authorsMatch, baseSeriesTitle, canonicalizeBookRequestIsbn, languagesAgree } from '@bookorbit/types'
import type { BookRequestMetadataSource, CreateBookRequestPayload, MetadataCandidate, MetadataProviderKey } from '@bookorbit/types'
import { preferredFormatsFor, volumeTitle, type PublishedSeries, type PublishedVolumeDestination } from './publishedVolumes'

export interface VolumeSearchQuery {
  title: string
  author: string | null
}

/** The record's display title, the same choice of field the built request stores. */
export function candidateTitle(candidate: MetadataCandidate): string {
  return candidate.displayTitle ?? candidate.title ?? ''
}

/** Bounded: at most this many provider searches per volume, whichever titles are tried. */
export const MAX_VOLUME_SEARCH_QUERIES = 3

/** A subtitle shorter than this cannot be a title, so the colon is kept rather than left with nothing. */
const MIN_BASE_TITLE_LENGTH = 3

/** "The Water Magician: The Central Provinces Arc" searches as "The Water Magician": the published title usually drops the arc name. */
function baseTitleOf(title: string): string {
  const trimmed = title.trim()
  const cut = trimmed.indexOf(':')
  if (cut <= 0) return trimmed
  const head = trimmed.slice(0, cut).trim()
  return head.length >= MIN_BASE_TITLE_LENGTH ? head : trimmed
}

/**
 * The provider searches for one volume, best title first: the MangaBaka title, then the same title
 * without its subtitle, which is usually closer to what the English edition is called.
 */
export function volumeSearchQueries(series: PublishedSeries, volume: number): VolumeSearchQuery[] {
  const author = series.authors.map((name) => name.trim()).find(Boolean) ?? null
  const titles: string[] = []
  for (const seriesTitle of [series.title.trim(), baseTitleOf(series.title)]) {
    const query = volumeTitle(seriesTitle, volume)
    if (!titles.includes(query)) titles.push(query)
  }
  return titles.slice(0, MAX_VOLUME_SEARCH_QUERIES).map((title) => ({ title, author }))
}

const MARKED_VOLUME = /(?:^|\s|[([])(?:vol\.?|volume|#)\s*\.?\s*(\d{1,3})(?!\d)/iu
const TRAILING_VOLUME = /(?:^|\s)(\d{1,3})$/u

/** The volume a record's own title names, when it names one. */
function titleVolume(text: string | null | undefined): number | null {
  if (!text) return null
  const marked = text.match(MARKED_VOLUME)
  if (marked) return Number.parseInt(marked[1]!, 10)
  const trailing = text.match(TRAILING_VOLUME)
  return trailing ? Number.parseInt(trailing[1]!, 10) : null
}

/** The volume the provider filed the record under. "1.5" is a side story, not volume 1. */
function seriesVolume(candidate: MetadataCandidate): number | null {
  const raw = candidate.seriesIndex ?? null
  if (raw === null) return null
  const parsed = Number.parseFloat(raw)
  return Number.isInteger(parsed) ? parsed : null
}

/** Both the series index and the title name a volume; a record that disagrees with itself is not this one. */
function candidateVolume(candidate: MetadataCandidate): { index: number | null; title: number | null } {
  const titles = [candidateTitle(candidate), candidate.subtitle ?? null]
  return {
    index: seriesVolume(candidate),
    title: titles.map(titleVolume).find((volume): volume is number => volume !== null) ?? null,
  }
}

/** The series a record's title names, once the marker saying which volume it is is out of the way. */
function withoutVolumeMarker(text: string): string {
  return text.replace(MARKED_VOLUME, ' ').replace(TRAILING_VOLUME, '').trim()
}

/**
 * Whether a record names this series: the same base title, or one base title holding the other when
 * both are long enough for a fragment of one to be a real name rather than a coincidence.
 */
function namesSeries(value: string, seriesTitle: string): boolean {
  const left = baseSeriesTitle(value)
  const right = baseSeriesTitle(seriesTitle)
  if (left === '' || right === '') return false
  if (left === right) return true
  return left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left))
}

/**
 * Why one candidate is this volume rather than another book: it must say which volume it is, name
 * this series, and its author must be one of the series'. Everything else only ranks the survivors.
 *
 * Returns null when the record is not the volume, otherwise its score, higher first.
 */
export function scoreVolumeCandidate(candidate: MetadataCandidate, series: PublishedSeries, volume: number): number | null {
  if (!candidateTitle(candidate)) return null
  const { index, title: titleNumberOfCandidate } = candidateVolume(candidate)
  if (index !== volume && titleNumberOfCandidate !== volume) return null
  if (index !== null && titleNumberOfCandidate !== null && index !== titleNumberOfCandidate) return null

  const titles = [candidateTitle(candidate), candidate.subtitle ?? null]
  const seriesNames = [candidate.seriesName ?? null, ...titles.map((title) => (title === null ? null : withoutVolumeMarker(title)))]
  if (!seriesNames.some((name) => name !== null && name !== '' && namesSeries(name, series.title))) return null

  const authorMatched = authorsMatch(series.authors, candidate.authors ?? [])
  if (series.authors.length > 0 && !authorMatched) return null

  let score = 0
  if (authorMatched) score += 40
  // The series database marks licensed series, and licensing in practice means an English edition.
  if (candidate.language) score += languagesAgree(candidate.language, 'en') ? 20 : -15
  if (index === volume) score += 10
  if (canonicalizeBookRequestIsbn(candidate.isbn10, candidate.isbn13)) score += 5
  if (candidate.coverUrl) score += 2
  if (candidate.publishedYear != null) score += 1
  return score
}

export interface VolumeCandidatePick {
  candidate: MetadataCandidate
  score: number
  /** Every accepted record of this volume, so their identifiers travel with the request as they do on the Requests page. */
  accepted: MetadataCandidate[]
}

export function pickVolumeCandidate(candidates: readonly MetadataCandidate[], series: PublishedSeries, volume: number): VolumeCandidatePick | null {
  const accepted: { candidate: MetadataCandidate; score: number }[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.providerId}`
    if (seen.has(key)) continue
    seen.add(key)
    const score = scoreVolumeCandidate(candidate, series, volume)
    if (score !== null) accepted.push({ candidate, score })
  }
  if (accepted.length === 0) return null
  accepted.sort((left, right) => right.score - left.score)
  return { candidate: accepted[0]!.candidate, score: accepted[0]!.score, accepted: accepted.map((entry) => entry.candidate) }
}

export interface MatchedVolumeRequestInput {
  series: PublishedSeries
  volume: number
  destination: PublishedVolumeDestination
  /** The language the request asks for, decided the way the Requests page decides it, not the edition's own. */
  language: string | null
  /** Every accepted record of the volume, so the request keeps identifiers the Requests page would keep. */
  accepted: readonly MetadataCandidate[]
  providerLabel: (provider: MetadataProviderKey) => string
}

/** A series index the request stores as a whole number, narrowed the way the Requests page narrows it. */
function requestSeriesIndex(candidate: MetadataCandidate): number | null {
  const raw = candidate.seriesIndex ?? null
  if (raw === null) return null
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** The DTO takes an absolute http or https address; a provider cover that is neither cannot be sent. */
function normalizeCoverUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function buildMetadataSources(input: MatchedVolumeRequestInput): BookRequestMetadataSource[] {
  const seen = new Set<string>()
  const sources: BookRequestMetadataSource[] = []
  for (const candidate of input.accepted) {
    const key = `${candidate.provider}:${candidate.providerId}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({
      providerKey: candidate.provider,
      providerId: candidate.providerId,
      providerLabel: input.providerLabel(candidate.provider),
      isbn10: candidate.isbn10 ?? null,
      isbn13: candidate.isbn13 ?? null,
    })
    if (sources.length === 20) break
  }
  return sources
}

/**
 * The create-request body for one volume from its matched book, field for field the way the
 * Requests page builds a request from a candidate, plus the Web Serials destination and formats.
 */
export function buildMatchedVolumeRequest(candidate: MetadataCandidate, input: MatchedVolumeRequestInput): CreateBookRequestPayload {
  return {
    title: candidateTitle(candidate),
    subtitle: candidate.subtitle ?? null,
    authors: candidate.authors ?? [],
    seriesName: candidate.seriesName ?? null,
    seriesIndex: requestSeriesIndex(candidate),
    isbn10: null,
    isbn13: canonicalizeBookRequestIsbn(candidate.isbn10, candidate.isbn13),
    publishedYear: candidate.publishedYear ?? null,
    language: input.language,
    coverUrl: normalizeCoverUrl(candidate.coverUrl),
    providerKey: candidate.provider,
    providerId: candidate.providerId,
    metadataSources: buildMetadataSources(input),
    note: `MangaBaka: ${input.series.url}`,
    mediaKind: 'ebook',
    targetLibraryId: input.destination.libraryId,
    targetFolderId: input.destination.folderId,
    preferredFormats: preferredFormatsFor(input.series.kind, input.destination.allowedFormats),
  }
}
