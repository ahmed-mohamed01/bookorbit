// Android gives a page in the background no working output for an audio pipeline built there, so
// after a file switch narration would play on silently and its media notification go away. The
// narration element is routed through one AudioContext, whose output stays open for the session.
// Only on Android: iOS suspends an AudioContext once the screen locks.
let context: AudioContext | null = null
const routed = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

type Trace = (event: string, detail?: Record<string, unknown>) => void

function shouldRoute(): boolean {
  return typeof AudioContext !== 'undefined' && /Android/i.test(globalThis.navigator?.userAgent ?? '')
}

export function routeAudio(audio: HTMLMediaElement, trace: Trace) {
  if (!shouldRoute() || routed.has(audio)) return
  try {
    if (!context) {
      const created = new AudioContext()
      created.addEventListener('statechange', () => {
        trace('context', { state: created.state })
        if (created.state !== 'running' && created.state !== 'closed') created.resume().catch(() => {})
      })
      context = created
    }
    const ctx = context
    // An element routed into a context that is not running is silent, so it is only routed once
    // the context runs, and plays on its own until then.
    const connect = () => {
      if (ctx.state !== 'running' || routed.has(audio)) return
      const source = ctx.createMediaElementSource(audio)
      source.connect(ctx.destination)
      routed.set(audio, source)
      trace('routed')
    }
    if (ctx.state === 'running') connect()
    else
      ctx
        .resume()
        .then(connect)
        .catch((e: unknown) => trace('route failed', { message: e instanceof Error ? e.message : String(e) }))
  } catch (e) {
    trace('route failed', { message: e instanceof Error ? e.message : String(e) })
  }
}

export function releaseAudio(audio: HTMLMediaElement) {
  routed.get(audio)?.disconnect()
  routed.delete(audio)
  audio.pause()
  // Detaching the source aborts the in-flight range requests.
  audio.removeAttribute('src')
  audio.load()
}

export function bufferedAhead(audio: HTMLMediaElement): number {
  const t = audio.currentTime
  const { buffered } = audio
  for (let i = 0; i < (buffered?.length ?? 0); i++) {
    if (buffered.start(i) <= t + 0.05 && t < buffered.end(i)) return buffered.end(i) - t
  }
  return 0
}
