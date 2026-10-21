import type { EpubMediaOverlayPlaylist } from '@bookorbit/types'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import { bufferedAhead, releaseAudio, routeAudio } from './narration-audio'
import { NarrationTimeline, type NarrationClip, type NarrationSegment } from './narration-timeline'

export interface NarrationBook {
  // Null when the file cannot be streamed and has to be read whole; throws when the server cannot be reached.
  getMediaUrl?: (href: string) => Promise<string | null>
  loadBlob: (href: string) => Promise<Blob | null>
}

export interface PlaylistNarrationOptions {
  book: NarrationBook
  loadPlaylist: () => Promise<EpubMediaOverlayPlaylist | null>
  // foliate's own engine, used when the book has no playlist.
  fallback: () => FoliateMediaOverlay
  createAudio?: () => HTMLAudioElement
}

export interface NarrationItem {
  text: string
  begin?: number
  end?: number
}

export type NarrationFilter = (item: NarrationItem, index: number, items: NarrationItem[]) => boolean

export interface NarrationTime {
  position: number
  duration: number
}

interface AudioSource {
  url: string
  objectUrl: boolean
  streamed: boolean
}

interface NextFile {
  href: string
  blob: Blob | null
  done: Promise<void>
  failedAt: number | null
}

type State = 'stopped' | 'playing' | 'paused'

// The next file is downloaded this long before narration reaches it: Android does not let a page
// in the background fetch a new file through an audio element, but it can play one from memory.
const PREFETCH_LEAD_SECONDS = 300
const MAX_PREFETCH_BYTES = 80 * 1024 * 1024
const PREFETCH_RETRY_MS = 30_000
const STREAM_RETRY_DELAYS_MS = [1000, 3000, 8000]
// A stream that keeps failing after it played gets fresh retries, but only this many within the
// window, so a dead link ends in an error, not a loop.
const MAX_STREAM_FAILURES = 6
const STREAM_FAILURE_WINDOW_MS = 5 * 60 * 1000
const PLAYLIST_RETRY_DELAYS_MS = [1000, 3000]
// Narration that runs on into the next segment of the same file is only seeked when it is this far off.
const SEEK_AHEAD_TOLERANCE = 0.5
const SEEK_BEHIND_TOLERANCE = 1
const HAVE_METADATA = 1
const TRACED_AUDIO_EVENTS = ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'emptied', 'abort']
const TRACE_BEAT_MS = 30_000

const fileName = (href: string | null | undefined) => href?.split('/').pop()
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Narration as one timeline over the book's audio files, built from the server's playlist, the
// way an audiobook player plays its tracks. Moving between chapters or files never depends on
// reading another SMIL file: the next file is known from the start and downloaded ahead.
export class PlaylistNarration extends EventTarget {
  #options: PlaylistNarrationOptions
  #ready: Promise<NarrationTimeline | null> | null = null
  #timeline: NarrationTimeline | null = null
  #fallback: FoliateMediaOverlay | null = null
  #state: State = 'stopped'
  // Bumped by every jump and by stop, so work started for an older position drops out.
  #playId = 0
  #segment: NarrationSegment | null = null
  #clip: NarrationClip | null = null
  #highlighted = false
  #audio: HTMLAudioElement | null = null
  #audioHref: string | null = null
  #audioSource: AudioSource | null = null
  #listeners: AbortController | null = null
  #pendingSeek: number | null = null
  #attempt = 0
  #advancing = false
  #buffering = false
  #next: NextFile | null = null
  #failures: number[] = []
  #rate = 1
  #volume = 1
  #lastBeat = 0
  #preparing: Promise<boolean> = Promise.resolve(false)

  constructor(options: PlaylistNarrationOptions) {
    super()
    this.#options = options
  }

  get position(): number | null {
    const timeline = this.#timeline
    const segment = this.#segment
    if (!timeline || !segment) return null
    return timeline.position(segment, this.#fileTime(segment))
  }

  get duration(): number | null {
    return this.#timeline?.duration ?? null
  }

  #trace(event: string, detail: Record<string, unknown> = {}) {
    this.dispatchEvent(new CustomEvent('trace', { detail: { event, ...detail } }))
  }

  #loadTimeline(): Promise<NarrationTimeline | null> {
    this.#ready ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const playlist = await this.#options.loadPlaylist()
          const timeline = playlist ? new NarrationTimeline(playlist) : null
          if (timeline && timeline.clips.length > 0) {
            this.#trace('playlist', { clips: timeline.clips.length, segments: timeline.segments.length, duration: timeline.duration })
            this.#timeline = timeline
            this.#emitTime()
            return timeline
          }
          this.#trace('playlist empty')
          break
        } catch (e) {
          this.#trace('playlist failed', { attempt, message: errorText(e) })
          if (attempt >= PLAYLIST_RETRY_DELAYS_MS.length) break
          await delay(PLAYLIST_RETRY_DELAYS_MS[attempt]!)
        }
      }
      this.#useFallback()
      return null
    })()
    return this.#ready
  }

  #useFallback() {
    const fallback = this.#options.fallback()
    for (const type of ['highlight', 'unhighlight', 'error', 'buffering', 'trace'])
      fallback.addEventListener(type, (e) => this.dispatchEvent(new CustomEvent(type, { detail: (e as CustomEvent).detail })))
    fallback.setRate(this.#rate)
    fallback.setVolume(this.#volume)
    this.#fallback = fallback
  }

  #error(e: unknown) {
    this.#trace('error', { message: errorText(e) })
    this.dispatchEvent(new CustomEvent('error', { detail: e instanceof Error ? e : new Error(errorText(e)) }))
  }

  #setBuffering(buffering: boolean) {
    if (this.#buffering === buffering) return
    this.#buffering = buffering
    this.#trace('buffering', { on: buffering })
    this.dispatchEvent(new CustomEvent('buffering', { detail: buffering }))
  }

  #emitTime() {
    const position = this.position
    const duration = this.duration
    if (position === null || duration === null) return
    this.dispatchEvent(new CustomEvent<NarrationTime>('time', { detail: { position, duration } }))
  }

  #unhighlight() {
    if (!this.#highlighted || !this.#clip) return
    this.#highlighted = false
    const { text, begin, end } = this.#clip
    this.dispatchEvent(new CustomEvent('unhighlight', { detail: { text, begin, end } }))
  }

  #highlight() {
    const clip = this.#clip
    if (!clip || this.#highlighted || this.#state === 'stopped') return
    this.#highlighted = true
    const { text, begin, end, sectionIndex } = clip
    this.dispatchEvent(new CustomEvent('highlight', { detail: { text, begin, end, sectionIndex } }))
  }

  #setClip(clip: NarrationClip) {
    if (clip === this.#clip) return this.#highlight()
    this.#unhighlight()
    this.#clip = clip
    this.#highlight()
  }

  #fileTime(segment: NarrationSegment): number {
    if (this.#audioHref !== segment.href || !this.#audio) return this.#clip?.segment === segment.index ? this.#clip.begin : segment.begin
    return this.#pendingSeek ?? this.#audio.currentTime
  }

  #findClip(timeline: NarrationTimeline, sectionIndex: number, filter?: NarrationFilter): NarrationClip | null {
    const index = timeline.sectionAtOrAfter(sectionIndex)
    if (index === null) return null
    // As foliate: a section without narration is passed over, and the filter only applies to the one asked for.
    const match = index === sectionIndex ? filter : undefined
    const clips = timeline.sectionClips(index)
    if (!match) return clips[0] ?? null
    const items = clips.map(({ text, begin, end }): NarrationItem => ({ text, begin, end: end ?? undefined }))
    const found = items.findIndex((item, i) => match(item, i, items))
    return found < 0 ? null : clips[found]!
  }

  async start(sectionIndex = 0, filter?: NarrationFilter): Promise<boolean> {
    const playId = ++this.#playId
    this.#trace('start', { section: sectionIndex })
    const timeline = await this.#loadTimeline()
    if (playId !== this.#playId) return false
    if (!timeline) return this.#fallback!.start(sectionIndex, filter)
    const clip = this.#findClip(timeline, sectionIndex, filter)
    if (!clip) {
      this.#trace('start.miss', { section: sectionIndex, filtered: !!filter })
      return false
    }
    this.#state = 'playing'
    this.#failures = []
    await this.#goTo(timeline.segments[clip.segment]!, clip.begin, playId)
    return true
  }

  // Warms the file where play would start, so pressing play is instant. Calls run one after
  // another so overlapping ones never open a file twice.
  prepare(sectionIndex: number, filter?: NarrationFilter): Promise<boolean> {
    const run = () => this.#prepare(sectionIndex, filter)
    this.#preparing = this.#preparing.then(run, run)
    return this.#preparing
  }

  async #prepare(sectionIndex: number, filter?: NarrationFilter): Promise<boolean> {
    if (this.#state !== 'stopped' || !this.#options.book.getMediaUrl) return false
    const playId = this.#playId
    const isStale = () => playId !== this.#playId || this.#state !== 'stopped'
    const timeline = await this.#loadTimeline()
    if (!timeline) return (await this.#fallback?.prepare?.(sectionIndex, filter)) ?? false
    if (isStale()) return false
    const clip = this.#findClip(timeline, sectionIndex, filter) ?? (filter ? this.#findClip(timeline, sectionIndex) : null)
    if (!clip) return false
    const segment = timeline.segments[clip.segment]!
    this.#segment = segment
    this.#clip = clip
    if (this.#audio && !this.#audio.error && this.#audioHref === segment.href) {
      this.#seek(clip.begin)
      return true
    }
    let url: string | null
    try {
      url = await this.#options.book.getMediaUrl(segment.href)
    } catch {
      // Warming is best effort; play opens the file again.
      return false
    }
    if (!url || isStale()) return false
    this.#bind({ url, objectUrl: false, streamed: true }, segment.href, 'metadata')
    this.#seek(clip.begin)
    return true
  }

  async #goTo(segment: NarrationSegment, fileTime: number, playId: number, { natural = false, attempt = 0, whole = false } = {}) {
    const timeline = this.#timeline!
    this.#segment = segment
    this.#advancing = false
    this.#setClip(timeline.clipIn(segment, fileTime))
    const audio = this.#audio
    const fresh = attempt > 0 || whole
    if (audio && !audio.error && this.#audioHref === segment.href && !fresh) {
      const drift = fileTime - audio.currentTime
      this.#trace('play.seek', { file: fileName(segment.href), segment: segment.index, at: fileTime, drift, natural })
      if (!natural || this.#pendingSeek !== null || drift > SEEK_AHEAD_TOLERANCE || drift < -SEEK_BEHIND_TOLERANCE) this.#seek(fileTime)
      audio.preload = 'auto'
      if (this.#state === 'playing' && audio.paused) this.#play()
      this.#emitTime()
      return
    }

    let source = fresh ? null : this.#takeNext(segment.href)
    const pending = this.#next
    // A hidden page cannot open a new file by streaming, so it waits for the download under way.
    if (!source && !fresh && pending?.href === segment.href && !pending.blob && pending.failedAt === null && document.hidden) {
      this.#trace('play.wait', { file: fileName(segment.href) })
      this.#setBuffering(this.#state === 'playing')
      await pending.done
      if (playId !== this.#playId) return
      source = this.#takeNext(segment.href)
    }
    this.#trace('play.load', {
      file: fileName(segment.href),
      segment: segment.index,
      at: fileTime,
      natural,
      attempt,
      whole,
      prefetched: !!source,
      reuse: !!audio && !audio.error && !fresh,
    })
    if (!source) {
      if (this.#state === 'playing') this.#setBuffering(true)
      try {
        source = await this.#openSource(segment.href, whole)
      } catch (e) {
        if (playId === this.#playId) this.#retry(segment, fileTime, attempt, false, e)
        return
      }
      if (playId !== this.#playId) {
        if (source.objectUrl) URL.revokeObjectURL(source.url)
        return
      }
    }
    this.#bind(source, segment.href, 'auto')
    this.#attempt = attempt
    this.#seek(fileTime)
    // A new source pauses the element. Asking to play straight away keeps a hidden page's
    // playback going while the file opens.
    if (this.#state === 'playing') this.#play()
    this.#emitTime()
  }

  async #openSource(href: string, whole: boolean): Promise<AudioSource> {
    const { book } = this.#options
    if (!whole && book.getMediaUrl) {
      const url = await book.getMediaUrl(href)
      if (url) return { url, objectUrl: false, streamed: true }
    }
    const blob = await book.loadBlob(href)
    if (!blob) throw new Error(`Failed to load ${href}`)
    return { url: URL.createObjectURL(blob), objectUrl: true, streamed: false }
  }

  #bind(source: AudioSource, href: string, preload: 'auto' | 'metadata') {
    let audio = this.#audio
    // A failed element is not trusted with another load.
    if (audio?.error) {
      this.#release()
      audio = null
    }
    if (this.#audioSource?.objectUrl) URL.revokeObjectURL(this.#audioSource.url)
    audio ??= this.#createAudio()
    this.#audioHref = href
    this.#audioSource = source
    this.#pendingSeek = null
    audio.preload = preload
    audio.src = source.url
    this.#trace('play.bound', { file: fileName(href), streamed: source.streamed, state: this.#state })
  }

  #createAudio(): HTMLAudioElement {
    const audio = this.#options.createAudio?.() ?? new Audio()
    audio.volume = this.#volume
    audio.playbackRate = this.#rate
    const listeners = new AbortController()
    const { signal } = listeners
    for (const type of TRACED_AUDIO_EVENTS)
      audio.addEventListener(
        type,
        () =>
          this.#trace(`audio.${type}`, {
            file: fileName(this.#audioHref),
            t: audio.currentTime,
            ready: audio.readyState,
            net: audio.networkState,
            ahead: bufferedAhead(audio),
            paused: audio.paused,
            code: audio.error?.code,
          }),
        { signal },
      )
    audio.addEventListener('loadedmetadata', () => this.#onMetadata(), { signal })
    audio.addEventListener('durationchange', () => this.#onDuration(), { signal })
    audio.addEventListener('timeupdate', () => this.#onTime(), { signal })
    audio.addEventListener('playing', () => this.#onPlaying(), { signal })
    audio.addEventListener('waiting', () => this.#onWaiting(), { signal })
    audio.addEventListener('ended', () => this.#onEnded(), { signal })
    audio.addEventListener('error', () => this.#onError(), { signal })
    routeAudio(audio, (event, detail) => this.#trace(event, detail))
    this.#audio = audio
    this.#listeners = listeners
    return audio
  }

  #release() {
    this.#listeners?.abort()
    this.#listeners = null
    if (this.#audio) releaseAudio(this.#audio)
    if (this.#audioSource?.objectUrl) URL.revokeObjectURL(this.#audioSource.url)
    this.#audio = null
    this.#audioHref = null
    this.#audioSource = null
    this.#pendingSeek = null
  }

  // Seeking once metadata is known lets the browser fetch from that point instead of the file's start.
  #seek(fileTime: number) {
    const audio = this.#audio
    if (!audio) return
    if (audio.readyState >= HAVE_METADATA) {
      this.#pendingSeek = null
      audio.currentTime = fileTime
    } else this.#pendingSeek = fileTime
  }

  #play() {
    const audio = this.#audio
    if (!audio) return
    this.#trace('play()', { t: audio.currentTime, ready: audio.readyState })
    audio.play().catch((e: unknown) => {
      const name = e instanceof Error ? e.name : undefined
      this.#trace('play() rejected', { name, message: errorText(e) })
      if (name !== 'AbortError') this.#error(e)
    })
  }

  #onMetadata() {
    const audio = this.#audio!
    if (this.#pendingSeek !== null) {
      audio.currentTime = this.#pendingSeek
      this.#pendingSeek = null
    }
    this.#onDuration()
  }

  #onDuration() {
    const audio = this.#audio
    if (audio && this.#audioHref && this.#timeline?.setFileDuration(this.#audioHref, audio.duration)) this.#emitTime()
  }

  // Events from a file that is no longer the one narration is in must not move narration on.
  #isPlayingSegment(): NarrationSegment | null {
    const segment = this.#segment
    return segment && this.#audio && this.#audioHref === segment.href && this.#pendingSeek === null ? segment : null
  }

  #onTime() {
    const audio = this.#audio!
    const segment = this.#isPlayingSegment()
    if (!segment || audio.paused || this.#state !== 'playing') return
    const timeline = this.#timeline!
    const t = audio.currentTime
    if (Date.now() - this.#lastBeat > TRACE_BEAT_MS) {
      this.#lastBeat = Date.now()
      this.#trace('tick', { file: fileName(segment.href), t, ahead: bufferedAhead(audio) })
    }
    const end = timeline.segmentEnd(segment)
    if (end !== null && t >= end) return this.#advance()
    const clip = timeline.clipIn(segment, t)
    if (clip !== this.#clip) this.#setClip(clip)
    else if (clip.end !== null && t > clip.end) this.#unhighlight()
    this.#maybePrefetch(segment, t)
    this.#emitTime()
  }

  #onPlaying() {
    this.#attempt = 0
    if (this.#state !== 'playing') return
    this.#setBuffering(false)
    this.#highlight()
  }

  // A stall is left to the browser, which resumes once data arrives. Pausing here makes Android
  // release the decoder of a hidden page, and resuming then can stall again in a loop.
  #onWaiting() {
    if (this.#state === 'playing') this.#setBuffering(true)
  }

  #onEnded() {
    if (this.#state === 'playing' && this.#isPlayingSegment()) this.#advance()
  }

  #advance() {
    if (this.#advancing) return
    this.#advancing = true
    const segment = this.#segment!
    const next = this.#timeline!.segments[segment.index + 1]
    this.#trace('advance', { segment: segment.index, next: next?.index, file: fileName(next?.href) })
    if (!next) return this.#finish()
    void this.#goTo(next, next.begin, this.#playId, { natural: true })
  }

  #finish() {
    this.#advancing = false
    this.#unhighlight()
    this.#state = 'paused'
    this.#setBuffering(false)
    this.#audio?.pause()
    this.#emitTime()
    this.dispatchEvent(new CustomEvent('end'))
  }

  #onError() {
    const audio = this.#audio
    const segment = this.#segment
    const source = this.#audioSource
    if (!audio?.error || !segment || !source || this.#audioHref !== segment.href) return
    // A warmed file that failed before play is opened again by play.
    if (this.#state === 'stopped') return this.#release()
    const fileTime = audio.currentTime || this.#pendingSeek || this.#clip?.begin || segment.begin
    this.#setBuffering(false)
    if (!source.streamed) return this.#fail(new Error(`Failed to play ${segment.href}`))
    this.#retry(segment, fileTime, this.#attempt, true, new Error(`Failed to stream ${segment.href}`))
  }

  // A dropped connection or an expired session is retried with backoff where narration was.
  // Reading the whole file is the last resort, and only when the server answers but the element
  // never manages to play its stream.
  #retry(segment: NarrationSegment, fileTime: number, attempt: number, serverAnswered: boolean, error: unknown) {
    const now = Date.now()
    this.#failures = this.#failures.filter((at) => now - at < STREAM_FAILURE_WINDOW_MS)
    this.#failures.push(now)
    this.#trace('retry', { attempt, serverAnswered, message: errorText(error) })
    if (this.#failures.length > MAX_STREAM_FAILURES) return this.#fail(error)
    const playId = this.#playId
    if (attempt >= STREAM_RETRY_DELAYS_MS.length) {
      if (!serverAnswered) return this.#fail(error)
      void this.#goTo(segment, fileTime, playId, { whole: true })
      return
    }
    if (this.#state === 'playing') this.#setBuffering(true)
    setTimeout(() => {
      if (playId === this.#playId) void this.#goTo(segment, fileTime, playId, { attempt: attempt + 1 })
    }, STREAM_RETRY_DELAYS_MS[attempt])
  }

  #fail(error: unknown) {
    this.#setBuffering(false)
    this.#state = 'paused'
    this.#release()
    this.#error(error)
  }

  #maybePrefetch(segment: NarrationSegment, fileTime: number) {
    const timeline = this.#timeline!
    const next = timeline.nextFile(segment)
    if (!next || next.href === this.#audioHref) return
    const known = this.#next
    if (known?.href === next.href && (known.failedAt === null || Date.now() - known.failedAt < PREFETCH_RETRY_MS)) return
    const left = next.start - timeline.position(segment, fileTime)
    if (left / (this.#rate || 1) > PREFETCH_LEAD_SECONDS) return
    const size = timeline.sizes.get(next.href) ?? 0
    if (size > MAX_PREFETCH_BYTES) {
      this.#next = { href: next.href, blob: null, done: Promise.resolve(), failedAt: Infinity }
      this.#trace('prefetch skipped', { file: fileName(next.href), size })
      return
    }
    const startedAt = Date.now()
    this.#trace('prefetch', { file: fileName(next.href), size })
    const entry: NextFile = { href: next.href, blob: null, done: Promise.resolve(), failedAt: null }
    entry.done = this.#options.book
      .loadBlob(next.href)
      .catch(() => null)
      .then((blob) => {
        if (!blob) {
          entry.failedAt = Date.now()
          this.#trace('prefetch failed', { file: fileName(next.href) })
          return
        }
        entry.blob = blob
        this.#trace('prefetch done', { file: fileName(next.href), bytes: blob.size, ms: Date.now() - startedAt })
      })
    this.#next = entry
  }

  #takeNext(href: string): AudioSource | null {
    const next = this.#next
    if (next?.href !== href || !next.blob) return null
    this.#next = null
    return { url: URL.createObjectURL(next.blob), objectUrl: true, streamed: false }
  }

  // Moves to `clip` from a listener's action, keeping play or pause as it is.
  #jump(segment: NarrationSegment, fileTime: number) {
    if (this.#state === 'stopped') return
    void this.#goTo(segment, fileTime, ++this.#playId)
  }

  seekTo(seconds: number) {
    if (this.#fallback) return
    const at = this.#timeline?.locate(seconds)
    if (!at) return
    this.#trace('seek', { to: seconds })
    this.#jump(at.segment, at.fileTime)
  }

  next() {
    if (this.#fallback) return this.#fallback.next()
    const clip = this.#clip && this.#timeline?.clips[this.#clip.index + 1]
    if (clip) this.#jump(this.#timeline!.segments[clip.segment]!, clip.begin)
  }

  prev() {
    if (this.#fallback) return this.#fallback.prev()
    const clip = this.#clip && this.#timeline?.clips[this.#clip.index - 1]
    if (clip) this.#jump(this.#timeline!.segments[clip.segment]!, clip.begin)
  }

  pause() {
    if (this.#fallback) return this.#fallback.pause()
    this.#trace('pause')
    if (this.#state === 'stopped') return
    this.#state = 'paused'
    this.#setBuffering(false)
    this.#audio?.pause()
  }

  resume() {
    if (this.#fallback) return this.#fallback.resume()
    this.#trace('resume', { loaded: !!this.#audio })
    if (this.#state === 'stopped' || !this.#segment) return
    this.#state = 'playing'
    if (this.#audio && this.#audioHref === this.#segment.href) return this.#play()
    // After a failure the element is gone, so narration opens its file again where it was.
    void this.#goTo(this.#segment, this.#clip?.begin ?? this.#segment.begin, ++this.#playId)
  }

  stop() {
    this.#fallback?.stop()
    this.#trace('stop')
    this.#playId++
    this.#unhighlight()
    this.#state = 'stopped'
    this.#setBuffering(false)
    this.#release()
    this.#segment = null
    this.#clip = null
    this.#next = null
    this.#failures = []
    this.#advancing = false
  }

  setRate(rate: number) {
    this.#rate = rate
    this.#fallback?.setRate(rate)
    if (this.#audio) this.#audio.playbackRate = rate
  }

  setVolume(volume: number) {
    this.#volume = volume
    this.#fallback?.setVolume(volume)
    if (this.#audio) this.#audio.volume = volume
  }
}
