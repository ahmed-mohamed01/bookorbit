import { WEB_SERIAL_MAX_PUBLISHED_VOLUMES } from '@bookorbit/types'
import type { BookRequestItem, BookRequestStatus, CreateBookRequestPayload, WebSerialKind, WebSerialPublication } from '@bookorbit/types'

/** The series as the published-volumes section needs it: the details-service record, never the scan source. */
export interface PublishedSeries {
  kind: WebSerialKind
  /** The MangaBaka series id, which keys the requests recorded for this series. */
  matchId: string
  title: string
  authors: string[]
  altTitles?: string[]
  coversWholeSeries?: boolean
  url: string
  publication: WebSerialPublication | null
}

/** Where a request for this kind lands: the Web Serials default library, and the formats it can hold. */
export interface PublishedVolumeDestination {
  libraryId: number | null
  folderId: number | null
  /** The library's allowed formats; empty means it takes every format. */
  allowedFormats: string[]
}

export interface PublishedVolumeRow {
  volume: number
  request: BookRequestItem | null
}

/** Settled without the book, so asking again makes sense. A failed request stays with the approver, who can retry it. */
const REQUESTABLE_AGAIN: readonly BookRequestStatus[] = ['cancelled', 'rejected']

export function clampVolumeCount(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const whole = Math.trunc(value)
  if (whole < 1) return null
  return Math.min(whole, WEB_SERIAL_MAX_PUBLISHED_VOLUMES)
}

/** The details service's final volume wins; otherwise what the user typed, bounded. */
export function resolveVolumeCount(publication: WebSerialPublication | null, typed: number | null): number | null {
  const known = publication?.finalVolume ?? null
  if (known !== null) return clampVolumeCount(known)
  return typed === null ? null : clampVolumeCount(typed)
}

export function volumeTitle(seriesTitle: string, volume: number): string {
  return `${seriesTitle.trim()} Vol. ${volume}`
}

export function buildVolumeRows(count: number | null, requests: Map<number, BookRequestItem>): PublishedVolumeRow[] {
  if (count === null) return []
  return Array.from({ length: count }, (_, index) => ({ volume: index + 1, request: requests.get(index + 1) ?? null }))
}

export function isVolumeMissing(row: PublishedVolumeRow): boolean {
  return row.request === null || REQUESTABLE_AGAIN.includes(row.request.status)
}

/** A request built from a provider record: the provider id names which book it asked for. */
export function isMatchedRequest(request: BookRequestItem | null): request is BookRequestItem {
  return request !== null && (request.providerId ?? null) !== null
}

/** A request built from free text, with no provider record or ISBN naming its book, so a re-match has something to add. */
export function isFreeTextRequest(request: BookRequestItem | null): request is BookRequestItem {
  return request !== null && (request.providerId ?? null) === null && (request.isbn13 ?? null) === null
}

/** Manga prefers a comic archive and settles for EPUB; either way only what the target library accepts. */
export function preferredFormatsFor(kind: WebSerialKind, allowedFormats: string[]): string[] {
  const wanted = kind === 'manga' ? ['cbz', 'epub'] : ['epub']
  if (allowedFormats.length === 0) return wanted
  const accepted = wanted.filter((format) => allowedFormats.includes(format))
  return accepted.length > 0 ? accepted : wanted.slice(0, 1)
}

/**
 * The create-request body for one volume, holding only fields `CreateBookRequestDto` declares.
 *
 * No provider id or metadata source: the MangaBaka id names the series, and the request dedupe keys on it, so every
 * volume after the first would fold into the first volume's request. The link travels in the note instead. No cover:
 * the series cover is a same-origin path, and the DTO only takes an absolute http or https address.
 */
export function buildVolumeRequest(series: PublishedSeries, volume: number, destination: PublishedVolumeDestination): CreateBookRequestPayload {
  const payload: CreateBookRequestPayload = {
    title: volumeTitle(series.title, volume),
    seriesName: series.title.trim(),
    seriesIndex: volume,
    mediaKind: 'ebook',
    preferredFormats: preferredFormatsFor(series.kind, destination.allowedFormats),
    note: `MangaBaka: ${series.url}`,
  }
  const authors = series.authors.map((author) => author.trim()).filter(Boolean)
  if (authors.length > 0) payload.authors = authors
  if (destination.libraryId !== null) {
    payload.targetLibraryId = destination.libraryId
    if (destination.folderId !== null) payload.targetFolderId = destination.folderId
  }
  return payload
}
