import * as CFI from './epubcfi.js'

const NS = {
  CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
  XHTML: 'http://www.w3.org/1999/xhtml',
  OPF: 'http://www.idpf.org/2007/opf',
  EPUB: 'http://www.idpf.org/2007/ops',
  DC: 'http://purl.org/dc/elements/1.1/',
  DCTERMS: 'http://purl.org/dc/terms/',
  ENC: 'http://www.w3.org/2001/04/xmlenc#',
  NCX: 'http://www.daisy.org/z3986/2005/ncx/',
  XLINK: 'http://www.w3.org/1999/xlink',
  SMIL: 'http://www.w3.org/ns/SMIL',
}

const MIME = {
  XML: 'application/xml',
  NCX: 'application/x-dtbncx+xml',
  XHTML: 'application/xhtml+xml',
  HTML: 'text/html',
  CSS: 'text/css',
  SVG: 'image/svg+xml',
  JS: /\/(x-)?(javascript|ecmascript)/,
}

// https://www.w3.org/TR/epub-33/#sec-reserved-prefixes
const PREFIX = {
  a11y: 'http://www.idpf.org/epub/vocab/package/a11y/#',
  dcterms: 'http://purl.org/dc/terms/',
  marc: 'http://id.loc.gov/vocabulary/',
  media: 'http://www.idpf.org/epub/vocab/overlays/#',
  onix: 'http://www.editeur.org/ONIX/book/codelists/current.html#',
  rendition: 'http://www.idpf.org/vocab/rendition/#',
  schema: 'http://schema.org/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  msv: 'http://www.idpf.org/epub/vocab/structure/magazine/#',
  prism: 'http://www.prismstandard.org/specifications/3.0/PRISM_CV_Spec_3.0.htm#',
}

const RELATORS = {
  art: 'artist',
  aut: 'author',
  clr: 'colorist',
  edt: 'editor',
  ill: 'illustrator',
  nrt: 'narrator',
  trl: 'translator',
  pbl: 'publisher',
}

const ONIX5 = {
  '02': 'isbn',
  '06': 'doi',
  15: 'isbn',
  26: 'doi',
  34: 'issn',
}

// convert to camel case
const camel = (x) => x.toLowerCase().replace(/[-:](.)/g, (_, g) => g.toUpperCase())

// strip and collapse ASCII whitespace
// https://infra.spec.whatwg.org/#strip-and-collapse-ascii-whitespace
const normalizeWhitespace = (str) =>
  str
    ? str
        .replace(/[\t\n\f\r ]+/g, ' ')
        .replace(/^[\t\n\f\r ]+/, '')
        .replace(/[\t\n\f\r ]+$/, '')
    : ''

const filterAttribute = (attr, value, isList) =>
  isList
    ? (el) => el.getAttribute(attr)?.split(/\s/)?.includes(value)
    : typeof value === 'function'
      ? (el) => value(el.getAttribute(attr))
      : (el) => el.getAttribute(attr) === value

const getAttributes =
  (...xs) =>
  (el) =>
    el ? Object.fromEntries(xs.map((x) => [camel(x), el.getAttribute(x)])) : null

const getElementText = (el) => normalizeWhitespace(el?.textContent)

const childGetter = (doc, ns) => {
  if (!doc?.documentElement)
    return {
      $: () => null,
      $$: () => [],
      $$$: () => [],
    }
  // ignore the namespace if it doesn't appear in document at all
  const useNS = doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns)
  const f = useNS ? (el, name) => (el) => el.namespaceURI === ns && el.localName === name : (el, name) => (el) => el.localName === name
  return {
    $: (el, name) => [...el.children].find(f(el, name)),
    $$: (el, name) => [...el.children].filter(f(el, name)),
    $$$: useNS ? (el, name) => [...el.getElementsByTagNameNS(ns, name)] : (el, name) => [...el.getElementsByTagName(name)],
  }
}

const resolveURL = (url, relativeTo) => {
  try {
    if (relativeTo.includes(':')) return new URL(url, relativeTo)
    // the base needs to be a valid URL, so set a base URL and then remove it
    const root = 'https://invalid.invalid/'
    const obj = new URL(url, root + relativeTo)
    obj.search = ''
    return decodeURI(obj.href.replace(root, ''))
  } catch (e) {
    console.warn(e)
    return url
  }
}

const isExternal = (uri) => /^(?!blob)\w+:/i.test(uri)

// like `path.relative()` in Node.js
const pathRelative = (from, to) => {
  if (!from) return to
  const as = from.replace(/\/$/, '').split('/')
  const bs = to.replace(/\/$/, '').split('/')
  const i = (as.length > bs.length ? as : bs).findIndex((_, i) => as[i] !== bs[i])
  return i < 0
    ? ''
    : Array(as.length - i)
        .fill('..')
        .concat(bs.slice(i))
        .join('/')
}

const pathDirname = (str) => str.slice(0, str.lastIndexOf('/') + 1)

// replace asynchronously and sequentially
// same technique as https://stackoverflow.com/a/48032528
const replaceSeries = async (str, regex, f) => {
  const matches = []
  str.replace(regex, (...args) => (matches.push(args), null))
  const results = []
  for (const args of matches) results.push(await f(...args))
  return str.replace(regex, () => results.shift())
}

const regexEscape = (str) => str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

const tidy = (obj) => {
  for (const [key, val] of Object.entries(obj))
    if (val == null) delete obj[key]
    else if (Array.isArray(val)) {
      obj[key] = val.filter((x) => x).map((x) => (typeof x === 'object' && !Array.isArray(x) ? tidy(x) : x))
      if (!obj[key].length) delete obj[key]
      else if (obj[key].length === 1) obj[key] = obj[key][0]
    } else if (typeof val === 'object') {
      obj[key] = tidy(val)
      if (!Object.keys(val).length) delete obj[key]
    }
  const keys = Object.keys(obj)
  if (keys.length === 1 && keys[0] === 'name') return obj[keys[0]]
  return obj
}

// https://www.w3.org/TR/epub/#sec-prefix-attr
const getPrefixes = (doc) => {
  const map = new Map(Object.entries(PREFIX))
  const value = doc.documentElement.getAttributeNS(NS.EPUB, 'prefix') || doc.documentElement.getAttribute('prefix')
  if (value) for (const [, prefix, url] of value.matchAll(/(.+): +(.+)[ \t\r\n]*/g)) map.set(prefix, url)
  return map
}

// https://www.w3.org/TR/epub-rs/#sec-property-values
// but ignoring the case where the prefix is omitted
const getPropertyURL = (value, prefixes) => {
  if (!value) return null
  const [a, b] = value.split(':')
  const prefix = b ? a : null
  const reference = b ? b : a
  const baseURL = prefixes.get(prefix)
  return baseURL ? baseURL + reference : null
}

const getMetadata = (opf) => {
  const { $ } = childGetter(opf, NS.OPF)
  const $metadata = $(opf.documentElement, 'metadata')

  // first pass: convert to JS objects
  const els = Object.groupBy($metadata.children, (el) =>
    el.namespaceURI === NS.DC ? 'dc' : el.namespaceURI === NS.OPF && el.localName === 'meta' ? (el.hasAttribute('name') ? 'legacyMeta' : 'meta') : '',
  )
  const baseLang = $metadata.getAttribute('xml:lang') ?? opf.documentElement.getAttribute('xml:lang') ?? 'und'
  const prefixes = getPrefixes(opf)
  const parse = (el) => {
    const property = el.getAttribute('property')
    const scheme = el.getAttribute('scheme')
    return {
      property: getPropertyURL(property, prefixes) ?? property,
      scheme: getPropertyURL(scheme, prefixes) ?? scheme,
      lang: el.getAttribute('xml:lang'),
      value: getElementText(el),
      props: getProperties(el),
      // `opf:` attributes from EPUB 2 & EPUB 3.1 (removed in EPUB 3.2)
      attrs: Object.fromEntries(
        Array.from(el.attributes)
          .filter((attr) => attr.namespaceURI === NS.OPF)
          .map((attr) => [attr.localName, attr.value]),
      ),
    }
  }
  const refines = Map.groupBy(els.meta ?? [], (el) => el.getAttribute('refines'))
  const getProperties = (el) => {
    const els = refines.get(el ? '#' + el.getAttribute('id') : null)
    if (!els) return null
    return Object.groupBy(els.map(parse), (x) => x.property)
  }
  const dc = Object.fromEntries(Object.entries(Object.groupBy(els.dc, (el) => el.localName)).map(([name, els]) => [name, els.map(parse)]))
  const properties = getProperties() ?? {}
  const legacyMeta = Object.fromEntries(els.legacyMeta?.map((el) => [el.getAttribute('name'), el.getAttribute('content')]) ?? [])

  // second pass: map to webpub
  const one = (x) => x?.[0]?.value
  const prop = (x, p) => one(x?.props?.[p])
  const makeLanguageMap = (x) => {
    if (!x) return null
    const alts = x.props?.['alternate-script'] ?? []
    const altRep = x.attrs['alt-rep']
    if (!alts.length && (!x.lang || x.lang === baseLang) && !altRep) return x.value
    const map = { [x.lang ?? baseLang]: x.value }
    if (altRep) map[x.attrs['alt-rep-lang']] = altRep
    for (const y of alts) map[y.lang] ??= y.value
    return map
  }
  const makeContributor = (x) =>
    x
      ? {
          name: makeLanguageMap(x),
          sortAs: makeLanguageMap(x.props?.['file-as']?.[0]) ?? x.attrs['file-as'],
          role: x.props?.role?.filter((x) => x.scheme === PREFIX.marc + 'relators')?.map((x) => x.value) ?? [x.attrs.role],
          code: prop(x, 'term') ?? x.attrs.term,
          scheme: prop(x, 'authority') ?? x.attrs.authority,
        }
      : null
  const makeCollection = (x) => ({
    name: makeLanguageMap(x),
    // NOTE: webpub requires number but EPUB allows values like "2.2.1"
    position: one(x.props?.['group-position']),
  })
  const makeAltIdentifier = (x) => {
    const { value } = x
    if (/^urn:/i.test(value)) return value
    if (/^doi:/i.test(value)) return `urn:${value}`
    const type = x.props?.['identifier-type']
    if (!type) {
      const scheme = x.attrs.scheme
      if (!scheme) return value
      // https://idpf.github.io/epub-registries/identifiers/
      // but no "jdcn", which isn't a registered URN namespace
      if (/^(doi|isbn|uuid)$/i.test(scheme)) return `urn:${scheme}:${value}`
      // NOTE: webpub requires scheme to be a URI; EPUB allows anything
      return { scheme, value }
    }
    if (type.scheme === PREFIX.onix + 'codelist5') {
      const nid = ONIX5[type.value]
      if (nid) return `urn:${nid}:${value}`
    }
    return value
  }
  const belongsTo = Object.groupBy(properties['belongs-to-collection'] ?? [], (x) =>
    prop(x, 'collection-type') === 'series' ? 'series' : 'collection',
  )
  const mainTitle = dc.title?.find((x) => prop(x, 'title-type') === 'main') ?? dc.title?.[0]
  const metadata = {
    identifier: getIdentifier(opf),
    title: makeLanguageMap(mainTitle),
    sortAs: makeLanguageMap(mainTitle?.props?.['file-as']?.[0]) ?? mainTitle?.attrs?.['file-as'] ?? legacyMeta?.['calibre:title_sort'],
    subtitle: dc.title?.find((x) => prop(x, 'title-type') === 'subtitle')?.value,
    language: dc.language?.map((x) => x.value),
    description: one(dc.description),
    publisher: makeContributor(dc.publisher?.[0]),
    published: dc.date?.find((x) => x.attrs.event === 'publication')?.value ?? one(dc.date),
    modified: one(properties[PREFIX.dcterms + 'modified']) ?? dc.date?.find((x) => x.attrs.event === 'modification')?.value,
    subject: dc.subject?.map(makeContributor),
    belongsTo: {
      collection: belongsTo.collection?.map(makeCollection),
      series:
        (belongsTo.series?.map(makeCollection) ?? legacyMeta?.['calibre:series'])
          ? {
              name: legacyMeta?.['calibre:series'],
              position: parseFloat(legacyMeta?.['calibre:series_index']),
            }
          : null,
    },
    altIdentifier: dc.identifier?.map(makeAltIdentifier),
    source: dc.source?.map(makeAltIdentifier), // NOTE: not in webpub schema
    rights: one(dc.rights), // NOTE: not in webpub schema
  }
  const remapContributor = (defaultKey) => (x) => {
    const keys = new Set(x.role?.map((role) => RELATORS[role] ?? defaultKey))
    return [keys.size ? keys : [defaultKey], x]
  }
  for (const [keys, val] of [].concat(
    dc.creator?.map(makeContributor)?.map(remapContributor('author')) ?? [],
    dc.contributor?.map(makeContributor)?.map(remapContributor('contributor')) ?? [],
  ))
    for (const key of keys)
      if (metadata[key]) metadata[key].push(val)
      else metadata[key] = [val]
  tidy(metadata)
  if (metadata.altIdentifier === metadata.identifier) delete metadata.altIdentifier

  const rendition = {}
  const media = {}
  for (const [key, val] of Object.entries(properties)) {
    if (key.startsWith(PREFIX.rendition)) rendition[camel(key.replace(PREFIX.rendition, ''))] = one(val)
    else if (key.startsWith(PREFIX.media)) media[camel(key.replace(PREFIX.media, ''))] = one(val)
  }
  if (media.duration) media.duration = parseClock(media.duration)
  return { metadata, rendition, media }
}

const parseNav = (doc, resolve = (f) => f) => {
  const { $, $$, $$$ } = childGetter(doc, NS.XHTML)
  const resolveHref = (href) => (href ? decodeURI(resolve(href)) : null)
  const parseLI = (getType) => ($li) => {
    const $a = $($li, 'a') ?? $($li, 'span')
    const $ol = $($li, 'ol')
    const href = resolveHref($a?.getAttribute('href'))
    const label = getElementText($a) || $a?.getAttribute('title')
    // TODO: get and concat alt/title texts in content
    const result = { label, href, subitems: parseOL($ol) }
    if (getType) result.type = $a?.getAttributeNS(NS.EPUB, 'type')?.split(/\s/)
    return result
  }
  const parseOL = ($ol, getType) => ($ol ? $$($ol, 'li').map(parseLI(getType)) : null)
  const parseNav = ($nav, getType) => parseOL($($nav, 'ol'), getType)

  const $$nav = $$$(doc, 'nav')
  let toc = null,
    pageList = null,
    landmarks = null,
    others = []
  for (const $nav of $$nav) {
    const type = $nav.getAttributeNS(NS.EPUB, 'type')?.split(/\s/) ?? []
    if (type.includes('toc')) toc ??= parseNav($nav)
    else if (type.includes('page-list')) pageList ??= parseNav($nav)
    else if (type.includes('landmarks')) landmarks ??= parseNav($nav, true)
    else
      others.push({
        label: getElementText($nav.firstElementChild),
        type,
        list: parseNav($nav),
      })
  }
  return { toc, pageList, landmarks, others }
}

const parseNCX = (doc, resolve = (f) => f) => {
  if (!doc?.documentElement) return { toc: null, pageList: null, others: [] }
  const { $, $$ } = childGetter(doc, NS.NCX)
  const resolveHref = (href) => (href ? decodeURI(resolve(href)) : null)
  const parseItem = (el) => {
    const $label = $(el, 'navLabel')
    const $content = $(el, 'content')
    const label = getElementText($label)
    const href = resolveHref($content.getAttribute('src'))
    if (el.localName === 'navPoint') {
      const els = $$(el, 'navPoint')
      return { label, href, subitems: els.length ? els.map(parseItem) : null }
    }
    return { label, href }
  }
  const parseList = (el, itemName) => $$(el, itemName).map(parseItem)
  const getSingle = (container, itemName) => {
    const $container = $(doc.documentElement, container)
    return $container ? parseList($container, itemName) : null
  }
  return {
    toc: getSingle('navMap', 'navPoint'),
    pageList: getSingle('pageList', 'pageTarget'),
    others: $$(doc.documentElement, 'navList').map((el) => ({
      label: getElementText($(el, 'navLabel')),
      list: parseList(el, 'navTarget'),
    })),
  }
}

const parseClock = (str) => {
  if (!str) return
  const parts = str.split(':').map((x) => parseFloat(x))
  if (parts.length === 3) {
    const [h, m, s] = parts
    return h * 60 * 60 + m * 60 + s
  }
  if (parts.length === 2) {
    const [m, s] = parts
    return m * 60 + s
  }
  const [x, unit] = str.split(/(?=[^\d.])/)
  const n = parseFloat(x)
  const f = unit === 'h' ? 60 * 60 : unit === 'min' ? 60 : unit === 'ms' ? 0.001 : 1
  return n * f
}

// BookOrbit fork: buffering for streamed media-overlay audio.
// The next clip is warmed this long before the current one ends, so a
// chapter boundary does not wait on its probe, metadata and first bytes.
const PRELOAD_LEAD_SECONDS = 45
// Within this distance of the boundary the next clip is warmed even if the
// current one is not fully buffered yet.
const PRELOAD_FORCE_SECONDS = 15
// After a stall, playback resumes once this much audio is buffered ahead, so a
// slow link plays in longer runs instead of stuttering on every bit of data.
// Starts and seeks play at once: right after a seek the browser is still
// filling the media before the playhead, so waiting there only adds delay.
const REBUFFER_SECONDS = 3
const SEEK_SETTLE_MS = 5000
const BUFFER_WAIT_MAX_MS = 8000
const STREAM_RETRY_DELAYS_MS = [1000, 3000, 8000]
// A stream that keeps failing after it played gets fresh retries, but only
// this many within the window, so a dead link ends in an error, not a loop.
const MAX_STREAM_FAILURES = 6
const STREAM_FAILURE_WINDOW_MS = 5 * 60 * 1000
const HAVE_METADATA = 1

const bufferedAhead = (audio) => {
  const t = audio.currentTime
  const { buffered } = audio
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.05 && t < buffered.end(i)) return buffered.end(i) - t
  }
  return 0
}

// Resolves once `seconds` of audio (or the rest of the file) is buffered, the
// browser stops fetching, or BUFFER_WAIT_MAX_MS passes.
const whenBuffered = (audio, seconds) =>
  new Promise((resolve) => {
    const remaining = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime - 0.25 : Infinity
    const target = Math.max(0, Math.min(seconds, remaining))
    const events = ['progress', 'canplay', 'suspend', 'emptied', 'error']
    let timer
    const finish = () => {
      clearTimeout(timer)
      for (const type of events) audio.removeEventListener(type, check)
      resolve()
    }
    const check = (e) => {
      if (e?.type === 'suspend' || e?.type === 'emptied' || e?.type === 'error' || bufferedAhead(audio) >= target) finish()
    }
    timer = setTimeout(finish, BUFFER_WAIT_MAX_MS)
    for (const type of events) audio.addEventListener(type, check)
    check()
  })

const releaseAudio = (audio) => {
  audio.pause()
  // Detaching the source aborts the in-flight range requests.
  audio.removeAttribute('src')
  audio.load()
}

class MediaOverlay extends EventTarget {
  #entries
  #lastMediaOverlayItem
  #smil = new Map()
  #sectionIndex
  #audioIndex
  #itemIndex
  #audio
  #audioSrc = null
  #audioStreamed = false
  // A skip within the same file hands the playing element to the newer
  // playback, so its listeners check this rather than the id they began with.
  #audioPlaybackId = 0
  #streamFailures = []
  #preload = null
  #preloadFor = null
  #preparing = Promise.resolve(false)
  #buffering = false
  #volume = 1
  #rate = 1
  #state
  #playbackId = 0
  constructor(book, loadXML) {
    super()
    this.book = book
    this.loadXML = loadXML
  }
  #parseSMIL(item) {
    let entries = this.#smil.get(item)
    if (!entries) {
      entries = this.loadXML(item.href).then((doc) => {
        const resolve = (href) => (href ? resolveURL(href, item.href) : null)
        const { $, $$$ } = childGetter(doc, NS.SMIL)
        return $$$(doc, 'par').reduce((arr, $par) => {
          const text = resolve($($par, 'text')?.getAttribute('src'))
          const $audio = $($par, 'audio')
          if (!text || !$audio) return arr
          const src = resolve($audio.getAttribute('src'))
          const begin = parseClock($audio.getAttribute('clipBegin'))
          const end = parseClock($audio.getAttribute('clipEnd'))
          const last = arr.at(-1)
          if (last?.src === src) last.items.push({ text, begin, end })
          else arr.push({ src, items: [{ text, begin, end }] })
          return arr
        }, [])
      })
      entries.catch(() => this.#smil.delete(item))
      this.#smil.set(item, entries)
      // Playback only moves between neighbouring sections, so a few suffice.
      if (this.#smil.size > 3) this.#smil.delete(this.#smil.keys().next().value)
    }
    return entries
  }
  async #loadSMIL(item, playbackId) {
    if (this.#lastMediaOverlayItem === item) return playbackId === this.#playbackId
    const entries = await this.#parseSMIL(item)
    if (playbackId !== this.#playbackId) return false
    this.#audioIndex = -1
    this.#itemIndex = -1
    this.#entries = entries
    this.#lastMediaOverlayItem = item
    return true
  }
  get #activeAudio() {
    return this.#entries[this.#audioIndex]
  }
  get #activeItem() {
    return this.#activeAudio?.items?.[this.#itemIndex]
  }
  #error(e) {
    console.error(e)
    this.dispatchEvent(new CustomEvent('error', { detail: e }))
  }
  #highlight() {
    this.dispatchEvent(new CustomEvent('highlight', { detail: this.#activeItem }))
  }
  #unhighlight() {
    this.dispatchEvent(new CustomEvent('unhighlight', { detail: this.#activeItem }))
  }
  #setBuffering(buffering) {
    if (this.#buffering === buffering) return
    this.#buffering = buffering
    this.dispatchEvent(new CustomEvent('buffering', { detail: buffering }))
  }
  #playAudio(audio) {
    audio.play().catch((e) => {
      if (e?.name !== 'AbortError') this.#error(e)
    })
  }
  async #rebuffer(audio, isCurrent) {
    audio.pause()
    this.#setBuffering(true)
    await whenBuffered(audio, REBUFFER_SECONDS)
    if (!isCurrent() || this.#state === 'paused') return
    this.#playAudio(audio)
  }
  // BookOrbit fork: chapter audio is streamed from a URL when the book can
  // provide one. getMediaUrl resolves null when streaming is not possible for
  // this file and throws when the server could not be reached.
  async #loadAudioSource(src, blob) {
    if (!blob && this.book.getMediaUrl) {
      const url = await this.book.getMediaUrl(src)
      if (url) return { url, streamed: true }
    }
    return { blob: await this.book.loadBlob(src) }
  }
  // A dropped connection or an expired session is retried with backoff at the
  // current sentence. Downloading the whole file is the last resort, and only
  // when the server answers but the audio element never manages to play.
  #retryStream(audioIndex, itemIndex, attempt, serverAnswered, error) {
    const now = Date.now()
    this.#streamFailures = this.#streamFailures.filter((at) => now - at < STREAM_FAILURE_WINDOW_MS)
    this.#streamFailures.push(now)
    if (this.#streamFailures.length > MAX_STREAM_FAILURES) {
      this.#setBuffering(false)
      return this.#error(error)
    }
    if (attempt >= STREAM_RETRY_DELAYS_MS.length) {
      this.#setBuffering(false)
      if (serverAnswered) return this.#play(audioIndex, itemIndex, undefined, { blob: true }).catch((e) => this.#error(e))
      return this.#error(error)
    }
    this.#setBuffering(true)
    const playbackId = this.#playbackId
    setTimeout(() => {
      if (playbackId !== this.#playbackId) return
      this.#play(audioIndex, itemIndex, undefined, { attempt: attempt + 1 }).catch((e) => this.#error(e))
    }, STREAM_RETRY_DELAYS_MS[attempt])
  }
  #seekWithin(audioIndex, itemIndex, playbackId) {
    const audio = this.#audio
    this.#unhighlight()
    this.#audioIndex = audioIndex
    this.#itemIndex = itemIndex
    this.#audioPlaybackId = playbackId
    audio.currentTime = this.#activeItem.begin ?? 0
    this.#highlight()
    if (this.#state !== 'paused' && audio.paused) this.#playAudio(audio)
  }
  // A warmed element for the same file is used even when playback starts at
  // another sentence: seeking it is cheaper than a new probe and index.
  #takePreload(src) {
    const preload = this.#preload
    this.#preload = null
    if (!preload) return null
    if (preload.src === src && !preload.audio.error) return preload.audio
    releaseAudio(preload.audio)
    return null
  }
  #dropPreload() {
    if (this.#preload) releaseAudio(this.#preload.audio)
    this.#preload = null
  }
  async #findClip(sectionIndex, filter = () => true) {
    for (let index = sectionIndex; index < this.book.sections.length; index++) {
      const section = this.book.sections[index]
      if (!section?.id) return null
      if (!section.mediaOverlay) {
        // start() drops the filter once it moves past the requested section.
        filter = () => true
        continue
      }
      const entries = await this.#parseSMIL(section.mediaOverlay)
      for (const { src, items } of entries) {
        for (let j = 0; j < items.length; j++) {
          if (items[j].text.split('#')[0] === section.id && filter(items[j], j, items)) return { src, begin: items[j].begin ?? 0 }
        }
      }
      return null
    }
    return null
  }
  #nextClip() {
    const next = this.#entries[this.#audioIndex + 1]
    if (next) return { src: next.src, begin: next.items[0]?.begin ?? 0 }
    return this.#findClip(this.#sectionIndex + 1)
  }
  async #warm(clip, preload, isStale) {
    const url = await this.book.getMediaUrl(clip.src)
    if (!url || isStale()) return
    const audio = new Audio(url)
    audio.preload = preload
    const warmed = { ...clip, audio }
    audio.addEventListener(
      'loadedmetadata',
      () => {
        audio.currentTime = warmed.begin
      },
      { once: true },
    )
    this.#dropPreload()
    this.#preload = warmed
  }
  #maybePreload(audio) {
    if (this.#preloadFor === audio || !this.book.getMediaUrl) return
    const clipEnd = this.#activeAudio.items.at(-1)?.end
    const left = (Number.isFinite(clipEnd) ? clipEnd : audio.duration) - audio.currentTime
    const secondsLeft = left / (this.#rate || 1)
    if (!(secondsLeft <= PRELOAD_LEAD_SECONDS)) return
    // Keep the link for the current clip until it is buffered to its end.
    if (secondsLeft > PRELOAD_FORCE_SECONDS && bufferedAhead(audio) < left - 0.5) return
    this.#preloadFor = audio
    this.#preloadNext(audio).catch(() => {})
  }
  async #preloadNext(current) {
    const isStale = () => this.#audio !== current
    const clip = await this.#nextClip()
    if (clip && !isStale()) await this.#warm(clip, 'auto', isStale)
  }
  // BookOrbit fork: lets the reader warm narration for where play would start,
  // so pressing play is instant. Fetches only the index and a little audio.
  // Calls run one after another so overlapping ones never warm a file twice.
  prepare(sectionIndex, filter) {
    const run = () => this.#prepare(sectionIndex, filter)
    this.#preparing = this.#preparing.then(run, run)
    return this.#preparing
  }
  async #prepare(sectionIndex, filter) {
    if (this.#audio || !this.book.getMediaUrl) return false
    const playbackId = this.#playbackId
    const isStale = () => !!this.#audio || playbackId !== this.#playbackId
    // As startMediaOverlayWithFallback: no match plays the section from its start.
    const clip = (await this.#findClip(sectionIndex, filter)) ?? (filter ? await this.#findClip(sectionIndex) : null)
    if (!clip || isStale()) return false
    if (this.#preload?.src === clip.src && !this.#preload.audio.error) {
      if (this.#preload.begin === clip.begin) return true
      this.#preload.begin = clip.begin
      if (this.#preload.audio.readyState >= HAVE_METADATA) this.#preload.audio.currentTime = clip.begin
      return true
    }
    await this.#warm(clip, 'metadata', isStale)
    return !isStale()
  }
  async #play(audioIndex, itemIndex, playbackId = ++this.#playbackId, { attempt = 0, blob = false } = {}) {
    const target = this.#entries[audioIndex]
    if (!attempt && !blob && this.#audio && !this.#audio.error && target?.src === this.#audioSrc && target.items[itemIndex]) {
      return this.#seekWithin(audioIndex, itemIndex, playbackId)
    }
    this.#stop()
    this.#audioIndex = audioIndex
    this.#itemIndex = itemIndex
    const src = this.#activeAudio?.src
    if (!src || !this.#activeItem) return this.start(this.#sectionIndex + 1, undefined, playbackId)
    const begin = this.#activeItem.begin ?? 0

    let audio = attempt || blob ? null : this.#takePreload(src)
    if (audio) audio.preload = 'auto'
    let source = audio ? { url: audio.src, streamed: true } : null
    if (!source) {
      this.#setBuffering(true)
      try {
        source = await this.#loadAudioSource(src, blob)
      } catch (e) {
        if (playbackId === this.#playbackId) this.#retryStream(audioIndex, itemIndex, attempt, false, e)
        return
      }
    }
    if (playbackId !== this.#playbackId) return
    const streamed = source.streamed === true
    const url = streamed ? source.url : URL.createObjectURL(source.blob)
    audio ??= new Audio(url)
    this.#audio = audio
    this.#audioSrc = src
    this.#audioStreamed = streamed
    this.#audioPlaybackId = playbackId
    const isCurrent = () => this.#audio === audio && this.#audioPlaybackId === this.#playbackId
    let hasPlayed = false
    audio.volume = this.#volume
    audio.playbackRate = this.#rate
    audio.addEventListener('timeupdate', () => {
      if (!isCurrent() || audio.paused) return
      const t = audio.currentTime
      const { items } = this.#activeAudio
      if (streamed) this.#maybePreload(audio)
      if (t > this.#activeItem?.end) {
        this.#unhighlight()
        if (this.#itemIndex === items.length - 1) {
          this.#play(this.#audioIndex + 1, 0).catch((e) => this.#error(e))
          return
        }
      }
      const oldIndex = this.#itemIndex
      while (items[this.#itemIndex + 1]?.begin <= t) this.#itemIndex++
      if (this.#itemIndex !== oldIndex) this.#highlight()
    })
    audio.addEventListener('error', () => {
      if (!isCurrent()) return
      this.#setBuffering(false)
      if (!streamed) return this.#error(new Error(`Failed to load ${src}`))
      // A stream that had been playing earns a fresh set of retries.
      this.#retryStream(this.#audioIndex, this.#itemIndex, hasPlayed ? 0 : attempt, true, new Error(`Failed to stream ${src}`))
    })
    audio.addEventListener('playing', () => {
      hasPlayed = true
      if (!isCurrent()) return
      this.#setBuffering(false)
      this.#highlight()
    })
    // The browser resumes after a stall as soon as any data arrives, which
    // stutters on a slow link; hold playback until a few seconds are buffered.
    // Stalls just after a seek are left to the browser, see REBUFFER_SECONDS.
    let holdStallsFrom = 0
    audio.addEventListener('seeking', () => {
      holdStallsFrom = performance.now() + SEEK_SETTLE_MS
    })
    audio.addEventListener('waiting', () => {
      if (!isCurrent() || this.#state !== 'playing') return
      this.#setBuffering(true)
      if (hasPlayed && !audio.seeking && performance.now() >= holdStallsFrom) this.#rebuffer(audio, isCurrent)
    })
    audio.addEventListener('ended', () => {
      if (!isCurrent()) return
      this.#unhighlight()
      if (!streamed) URL.revokeObjectURL(url)
      this.#audio = null
      this.#audioSrc = null
      this.#play(this.#audioIndex + 1, 0).catch((e) => this.#error(e))
    })
    if (this.#state === 'paused') {
      this.#setBuffering(false)
      this.#highlight()
      audio.currentTime = begin
    } else if (streamed) {
      // Seeking once metadata is known lets the browser fetch from the clip
      // position instead of buffering the file from its start.
      const startStreamed = () => {
        if (!isCurrent()) return
        if (audio.currentTime !== begin) audio.currentTime = begin
        if (this.#state === 'paused') return this.#setBuffering(false)
        this.#state = 'playing'
        this.#playAudio(audio)
      }
      if (audio.readyState >= HAVE_METADATA) startStreamed()
      else audio.addEventListener('loadedmetadata', startStreamed, { once: true })
    } else
      audio.addEventListener(
        'canplaythrough',
        () => {
          if (!isCurrent()) return
          // for some reason need to seek in `canplaythrough`
          // or it won't play when skipping in WebKit
          audio.currentTime = begin
          this.#state = 'playing'
          this.#setBuffering(false)
          audio.play().catch((e) => this.#error(e))
        },
        { once: true },
      )
  }
  async start(sectionIndex, filter = () => true, playbackId = ++this.#playbackId) {
    if (playbackId !== this.#playbackId) return false
    this.#audio?.pause()
    const section = this.book.sections[sectionIndex]
    const href = section?.id
    if (!href) return false

    const { mediaOverlay } = section
    if (!mediaOverlay) return this.start(sectionIndex + 1, undefined, playbackId)
    this.#sectionIndex = sectionIndex
    if (!(await this.#loadSMIL(mediaOverlay, playbackId))) return false

    for (let i = 0; i < this.#entries.length; i++) {
      const { items } = this.#entries[i]
      for (let j = 0; j < items.length; j++) {
        if (items[j].text.split('#')[0] === href && filter(items[j], j, items)) {
          await this.#play(i, j, playbackId).catch((e) => this.#error(e))
          return true
        }
      }
    }
    return false
  }
  pause() {
    this.#state = 'paused'
    this.#setBuffering(false)
    this.#audio?.pause()
  }
  resume() {
    this.#state = 'playing'
    this.#audio?.play().catch((e) => this.#error(e))
  }
  #stop() {
    this.#setBuffering(false)
    if (this.#audio) {
      if (this.#audioStreamed) releaseAudio(this.#audio)
      else {
        this.#audio.pause()
        URL.revokeObjectURL(this.#audio.src)
      }
      this.#audio = null
      this.#audioSrc = null
      this.#unhighlight()
    }
  }
  stop() {
    this.#playbackId++
    this.#state = 'stopped'
    this.#stop()
    this.#dropPreload()
    this.#streamFailures = []
  }
  prev() {
    if (this.#itemIndex > 0) this.#play(this.#audioIndex, this.#itemIndex - 1)
    else if (this.#audioIndex > 0) this.#play(this.#audioIndex - 1, this.#entries[this.#audioIndex - 1].items.length - 1)
    else if (this.#sectionIndex > 0) this.start(this.#sectionIndex - 1, (_, i, items) => i === items.length - 1)
  }
  next() {
    this.#play(this.#audioIndex, this.#itemIndex + 1)
  }
  setVolume(volume) {
    this.#volume = volume
    if (this.#audio) this.#audio.volume = volume
  }
  setRate(rate) {
    this.#rate = rate
    if (this.#audio) this.#audio.playbackRate = rate
  }
}

const isUUID = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/

const getUUID = (opf) => {
  for (const el of opf.getElementsByTagNameNS(NS.DC, 'identifier')) {
    const [id] = getElementText(el).split(':').slice(-1)
    if (isUUID.test(id)) return id
  }
  return ''
}

const getIdentifier = (opf) =>
  getElementText(opf.getElementById(opf.documentElement.getAttribute('unique-identifier')) ?? opf.getElementsByTagNameNS(NS.DC, 'identifier')[0])

// https://www.w3.org/publishing/epub32/epub-ocf.html#sec-resource-obfuscation
const deobfuscate = async (key, length, blob) => {
  const array = new Uint8Array(await blob.slice(0, length).arrayBuffer())
  length = Math.min(length, array.length)
  for (var i = 0; i < length; i++) array[i] = array[i] ^ key[i % key.length]
  return new Blob([array, blob.slice(length)], { type: blob.type })
}

const WebCryptoSHA1 = async (str) => {
  const data = new TextEncoder().encode(str)
  const buffer = await globalThis.crypto.subtle.digest('SHA-1', data)
  return new Uint8Array(buffer)
}

const deobfuscators = (sha1 = WebCryptoSHA1) => ({
  'http://www.idpf.org/2008/embedding': {
    key: (opf) =>
      sha1(
        getIdentifier(opf)
          // eslint-disable-next-line no-control-regex
          .replaceAll(/[\u0020\u0009\u000d\u000a]/g, ''),
      ),
    decode: (key, blob) => deobfuscate(key, 1040, blob),
  },
  'http://ns.adobe.com/pdf/enc#RC': {
    key: (opf) => {
      const uuid = getUUID(opf).replaceAll('-', '')
      return Uint8Array.from({ length: 16 }, (_, i) => parseInt(uuid.slice(i * 2, i * 2 + 2), 16))
    },
    decode: (key, blob) => deobfuscate(key, 1024, blob),
  },
})

class Encryption {
  #uris = new Map()
  #decoders = new Map()
  #algorithms
  constructor(algorithms) {
    this.#algorithms = algorithms
  }
  async init(encryption, opf) {
    if (!encryption) return
    const data = Array.from(encryption.getElementsByTagNameNS(NS.ENC, 'EncryptedData'), (el) => ({
      algorithm: el.getElementsByTagNameNS(NS.ENC, 'EncryptionMethod')[0]?.getAttribute('Algorithm'),
      uri: el.getElementsByTagNameNS(NS.ENC, 'CipherReference')[0]?.getAttribute('URI'),
    }))
    for (const { algorithm, uri } of data) {
      if (!this.#decoders.has(algorithm)) {
        const algo = this.#algorithms[algorithm]
        if (!algo) {
          console.warn('Unknown encryption algorithm')
          continue
        }
        const key = await algo.key(opf)
        this.#decoders.set(algorithm, (blob) => algo.decode(key, blob))
      }
      this.#uris.set(uri, algorithm)
    }
  }
  getDecoder(uri) {
    return this.#decoders.get(this.#uris.get(uri)) ?? ((x) => x)
  }
  isEncrypted(uri) {
    return this.#uris.has(uri)
  }
}

class Resources {
  constructor({ opf, resolveHref }) {
    this.opf = opf
    const { $, $$, $$$ } = childGetter(opf, NS.OPF)

    const $manifest = $(opf.documentElement, 'manifest')
    const $spine = $(opf.documentElement, 'spine')
    const $$itemref = $$($spine, 'itemref')

    this.manifest = $$($manifest, 'item')
      .map(getAttributes('href', 'id', 'media-type', 'properties', 'media-overlay'))
      .map((item) => {
        item.href = resolveHref(item.href)
        item.properties = item.properties?.split(/\s/)
        return item
      })
    this.manifestById = new Map(this.manifest.map((item) => [item.id, item]))
    this.spine = $$itemref
      .map(getAttributes('idref', 'id', 'linear', 'properties'))
      .map((item) => ((item.properties = item.properties?.split(/\s/)), item))
    this.pageProgressionDirection = $spine.getAttribute('page-progression-direction')

    this.navPath = this.getItemByProperty('nav')?.href
    this.ncxPath = (this.getItemByID($spine.getAttribute('toc')) ?? this.manifest.find((item) => item.mediaType === MIME.NCX))?.href

    const $guide = $(opf.documentElement, 'guide')
    if ($guide)
      this.guide = $$($guide, 'reference')
        .map(getAttributes('type', 'title', 'href'))
        .map(({ type, title, href }) => ({
          label: title,
          type: type.split(/\s/),
          href: resolveHref(href),
        }))

    this.cover =
      this.getItemByProperty('cover-image') ??
      // EPUB 2 compat
      this.getItemByID($$$(opf, 'meta').find(filterAttribute('name', 'cover'))?.getAttribute('content')) ??
      this.getItemByHref(this.guide?.find((ref) => ref.type.includes('cover'))?.href)

    this.cfis = CFI.fromElements($$itemref)
  }
  getItemByID(id) {
    return this.manifestById.get(id)
  }
  getItemByHref(href) {
    return this.manifest.find((item) => item.href === href)
  }
  getItemByProperty(prop) {
    return this.manifest.find((item) => item.properties?.includes(prop))
  }
  resolveCFI(cfi) {
    const parts = CFI.parse(cfi)
    const top = (parts.parent ?? parts).shift()
    let $itemref = CFI.toElement(this.opf, top)
    // make sure it's an idref; if not, try again without the ID assertion
    // mainly because Epub.js used to generate wrong ID assertions
    // https://github.com/futurepress/epub.js/issues/1236
    if ($itemref && $itemref.nodeName !== 'idref') {
      top.at(-1).id = null
      $itemref = CFI.toElement(this.opf, top)
    }
    const idref = $itemref?.getAttribute('idref')
    const index = this.spine.findIndex((item) => item.idref === idref)
    const anchor = (doc) => CFI.toRange(doc, parts)
    return { index, anchor }
  }
}

class Loader {
  #cache = new Map()
  #children = new Map()
  #refCount = new Map()
  #getDirectUrl = null // Function to get direct streaming URLs for lazy loading
  eventTarget = new EventTarget()
  constructor({ loadText, loadBlob, resources, getDirectUrl }) {
    this.loadText = loadText
    this.loadBlob = loadBlob
    this.manifest = resources.manifest
    this.assets = resources.manifest
    this.#getDirectUrl = getDirectUrl ?? null
    // needed only when replacing in (X)HTML w/o parsing (see below)
    //.filter(({ mediaType }) => ![MIME.XHTML, MIME.HTML].includes(mediaType))
  }

  // Check if a media type is an image
  #isImage(mediaType) {
    return mediaType?.startsWith('image/') ?? false
  }

  // Check if a media type is a font
  #isFont(mediaType) {
    return (
      mediaType?.includes('font') ||
      mediaType === 'application/vnd.ms-opentype' ||
      mediaType === 'application/x-font-ttf' ||
      mediaType === 'application/x-font-otf' ||
      mediaType === 'application/x-font-woff' ||
      mediaType === 'font/otf' ||
      mediaType === 'font/ttf' ||
      mediaType === 'font/woff' ||
      mediaType === 'font/woff2'
    )
  }
  async createURL(href, data, type, parent) {
    if (!data) return ''
    const detail = { data, type }
    Object.defineProperty(detail, 'name', { value: href }) // readonly
    const event = new CustomEvent('data', { detail })
    this.eventTarget.dispatchEvent(event)
    const newData = await event.detail.data
    const newType = await event.detail.type
    const url = URL.createObjectURL(new Blob([newData], { type: newType }))
    this.#cache.set(href, url)
    this.#refCount.set(href, 1)
    if (parent) {
      const childList = this.#children.get(parent)
      if (childList) childList.push(href)
      else this.#children.set(parent, [href])
    }
    return url
  }
  ref(href, parent) {
    const childList = this.#children.get(parent)
    if (!childList?.includes(href)) {
      this.#refCount.set(href, this.#refCount.get(href) + 1)
      //console.log(`referencing ${href}, now ${this.#refCount.get(href)}`)
      if (childList) childList.push(href)
      else this.#children.set(parent, [href])
    }
    return this.#cache.get(href)
  }
  unref(href) {
    if (!this.#refCount.has(href)) return
    const count = this.#refCount.get(href) - 1
    //console.log(`unreferencing ${href}, now ${count}`)
    if (count < 1) {
      //console.log(`unloading ${href}`)
      URL.revokeObjectURL(this.#cache.get(href))
      this.#cache.delete(href)
      this.#refCount.delete(href)
      // unref children
      const childList = this.#children.get(href)
      if (childList) while (childList.length) this.unref(childList.pop())
      this.#children.delete(href)
    } else this.#refCount.set(href, count)
  }
  // load manifest item, recursively loading all resources as needed
  async loadItem(item, parents = []) {
    if (!item) return null
    const { href, mediaType } = item

    const isScript = MIME.JS.test(item.mediaType)
    const detail = { type: mediaType, isScript, allow: true }
    const event = new CustomEvent('load', { detail })
    this.eventTarget.dispatchEvent(event)
    const allow = await event.detail.allow
    if (!allow) return null

    const parent = parents.at(-1)
    if (this.#cache.has(href)) return this.ref(href, parent)

    const shouldReplace =
      (isScript || [MIME.XHTML, MIME.HTML, MIME.CSS, MIME.SVG].includes(mediaType)) &&
      // prevent circular references
      parents.every((p) => p !== href)
    if (shouldReplace) return this.loadReplaced(item, parents)
    // NOTE: this can be replaced with `Promise.try()`
    const tryLoadBlob = Promise.resolve().then(() => this.loadBlob(href))
    return this.createURL(href, tryLoadBlob, mediaType, parent)
  }
  async loadHref(href, base, parents = []) {
    if (isExternal(href)) return href
    const path = resolveURL(href, base)
    const item = this.manifest.find((item) => item.href === path)
    if (!item) return href
    return this.loadItem(item, parents.concat(base))
  }
  async loadReplaced(item, parents = []) {
    const { href, mediaType } = item
    const parent = parents.at(-1)
    let str = ''
    try {
      str = await this.loadText(href)
    } catch (e) {
      return this.createURL(href, Promise.reject(e), mediaType, parent)
    }
    if (!str) return null

    // note that one can also just use `replaceString` for everything:
    // ```
    // const replaced = await this.replaceString(str, href, parents)
    // return this.createURL(href, replaced, mediaType, parent)
    // ```
    // which is basically what Epub.js does, which is simpler, but will
    // break things like iframes (because you don't want to replace links)
    // or text that just happen to be paths

    // parse and replace in HTML
    if ([MIME.XHTML, MIME.HTML, MIME.SVG].includes(mediaType)) {
      let doc = new DOMParser().parseFromString(str, mediaType)
      // change to HTML if it's not valid XHTML
      if (mediaType === MIME.XHTML && (doc.querySelector('parsererror') || !doc.documentElement?.namespaceURI)) {
        console.warn(doc.querySelector('parsererror')?.innerText ?? 'Invalid XHTML')
        item.mediaType = MIME.HTML
        doc = new DOMParser().parseFromString(str, item.mediaType)
      }
      // replace hrefs in XML processing instructions
      // this is mainly for SVGs that use xml-stylesheet
      if ([MIME.XHTML, MIME.SVG].includes(item.mediaType)) {
        let child = doc.firstChild
        while (child instanceof ProcessingInstruction) {
          if (child.data) {
            const replacedData = await replaceSeries(child.data, /(?:^|\s*)(href\s*=\s*['"])([^'"]*)(['"])/i, (_, p1, p2, p3) =>
              this.loadHref(p2, href, parents).then((p2) => `${p1}${p2}${p3}`),
            )
            child.replaceWith(doc.createProcessingInstruction(child.target, replacedData))
          }
          child = child.nextSibling
        }
      }
      // replace hrefs (excluding anchors)
      const replace = async (el, attr) => el.setAttribute(attr, await this.loadHref(el.getAttribute(attr), href, parents))

      // Helper to check if element is an image that should use direct URL
      const shouldUseDirectUrl = (el, attr) => {
        if (!this.#getDirectUrl) return false
        const srcAttr = el.getAttribute(attr)
        if (!srcAttr || isExternal(srcAttr)) return false
        const path = resolveURL(srcAttr, href)
        const item = this.manifest.find((item) => item.href === path)
        return item && this.#isImage(item.mediaType)
      }

      // Replace with direct URL (for images) - browser loads on-demand
      const replaceWithDirectUrl = (el, attr) => {
        const srcAttr = el.getAttribute(attr)
        const path = resolveURL(srcAttr, href)
        const directUrl = this.#getDirectUrl(path)
        if (directUrl) {
          el.setAttribute(attr, directUrl)
          return true
        }
        return false
      }

      // Process link elements (stylesheets, etc.)
      for (const el of doc.querySelectorAll('link[href]')) await replace(el, 'href')

      // Process elements with src attribute
      // For images: use direct URLs so browser can load on-demand
      // For others: load and create blob URL
      for (const el of doc.querySelectorAll('[src]')) {
        if (shouldUseDirectUrl(el, 'src')) {
          replaceWithDirectUrl(el, 'src')
        } else {
          await replace(el, 'src')
        }
      }

      // Process poster attributes (videos)
      for (const el of doc.querySelectorAll('[poster]')) {
        if (shouldUseDirectUrl(el, 'poster')) {
          replaceWithDirectUrl(el, 'poster')
        } else {
          await replace(el, 'poster')
        }
      }

      for (const el of doc.querySelectorAll('object[data]')) await replace(el, 'data')
      for (const el of doc.querySelectorAll('[*|href]:not([href])'))
        el.setAttributeNS(NS.XLINK, 'href', await this.loadHref(el.getAttributeNS(NS.XLINK, 'href'), href, parents))

      // Process srcset attributes
      for (const el of doc.querySelectorAll('[srcset]'))
        el.setAttribute(
          'srcset',
          await replaceSeries(el.getAttribute('srcset'), /(\s*)(.+?)\s*((?:\s[\d.]+[wx])+\s*(?:,|$)|,\s+|$)/g, (_, p1, p2, p3) =>
            this.loadHref(p2, href, parents).then((p2) => `${p1}${p2}${p3}`),
          ),
        )
      // replace inline styles
      for (const el of doc.querySelectorAll('style')) if (el.textContent) el.textContent = await this.replaceCSS(el.textContent, href, parents)
      for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', await this.replaceCSS(el.getAttribute('style'), href, parents))
      // TODO: replace inline scripts? probably not worth the trouble
      const result = new XMLSerializer().serializeToString(doc)
      return this.createURL(href, result, item.mediaType, parent)
    }

    const result = mediaType === MIME.CSS ? await this.replaceCSS(str, href, parents) : await this.replaceString(str, href, parents)
    return this.createURL(href, result, mediaType, parent)
  }
  async replaceCSS(str, href, parents = []) {
    // For url() references, use direct URLs for fonts and images (lazy loading)
    // This avoids fetching all fonts/images upfront - browser fetches on-demand
    const replacedUrls = await replaceSeries(str, /url\(\s*["']?([^'"\n]*?)\s*["']?\s*\)/gi, async (_, url) => {
      if (isExternal(url)) return `url("${url}")`

      const path = resolveURL(url, href)
      const item = this.manifest.find((item) => item.href === path)

      // If we have getDirectUrl and this is a font or image, use direct URL
      // This lets the browser fetch on-demand instead of us prefetching everything
      if (this.#getDirectUrl && item && (this.#isFont(item.mediaType) || this.#isImage(item.mediaType))) {
        const directUrl = this.#getDirectUrl(path)
        if (directUrl) return `url("${directUrl}")`
      }

      // For other resources (like CSS), load them normally
      const loadedUrl = await this.loadHref(url, href, parents)
      return `url("${loadedUrl}")`
    })

    // apart from `url()`, strings can be used for `@import` (but why?!)
    // CSS imports need to be loaded and processed
    const replacedImports = await replaceSeries(replacedUrls, /@import\s*["']([^"'\n]*?)["']/gi, (_, url) =>
      this.loadHref(url, href, parents).then((url) => `@import "${url}"`),
    )

    // Add font-display: swap to @font-face rules that don't have it
    // This ensures text is visible immediately while fonts load
    return replacedImports.replace(/@font-face\s*\{([^}]*)\}/gi, (match, content) => {
      // Check if font-display is already set
      if (/font-display\s*:/i.test(content)) {
        return match
      }
      // Add font-display: swap before the closing brace
      return `@font-face {${content}font-display: swap;}`
    })
  }
  // find & replace all possible relative paths for all assets without parsing
  replaceString(str, href, parents = []) {
    const assetMap = new Map()
    const urls = this.assets
      .map((asset) => {
        // do not replace references to the file itself
        if (asset.href === href) return
        // href was decoded and resolved when parsing the manifest
        const relative = pathRelative(pathDirname(href), asset.href)
        const relativeEnc = encodeURI(relative)
        const rootRelative = '/' + asset.href
        const rootRelativeEnc = encodeURI(rootRelative)
        const set = new Set([relative, relativeEnc, rootRelative, rootRelativeEnc])
        for (const url of set) assetMap.set(url, asset)
        return Array.from(set)
      })
      .flat()
      .filter((x) => x)
    if (!urls.length) return str
    const regex = new RegExp(urls.map(regexEscape).join('|'), 'g')
    return replaceSeries(str, regex, async (match) => this.loadItem(assetMap.get(match.replace(/^\//, '')), parents.concat(href)))
  }
  unloadItem(item) {
    this.unref(item?.href)
  }
  destroy() {
    for (const url of this.#cache.values()) URL.revokeObjectURL(url)
  }
}

const getHTMLFragment = (doc, id) => doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)

const getPageSpread = (properties) => {
  for (const p of properties) {
    if (p === 'page-spread-left' || p === 'rendition:page-spread-left') return 'left'
    if (p === 'page-spread-right' || p === 'rendition:page-spread-right') return 'right'
    if (p === 'rendition:page-spread-center') return 'center'
  }
}

const getDisplayOptions = (doc) => {
  if (!doc) return null
  return {
    fixedLayout: getElementText(doc.querySelector('option[name="fixed-layout"]')),
    openToSpread: getElementText(doc.querySelector('option[name="open-to-spread"]')),
  }
}

export class EPUB {
  parser = new DOMParser()
  #loader
  #encryption
  #getDirectUrl = null
  #loaderMediaUrl = null
  constructor({ loadText, loadBlob, getSize, getDirectUrl, getMediaUrl, sha1 }) {
    this.loadText = loadText
    this.loadBlob = loadBlob
    this.getSize = getSize
    this.#getDirectUrl = getDirectUrl ?? null
    this.#loaderMediaUrl = getMediaUrl ?? null
    this.#encryption = new Encryption(deobfuscators(sha1))
  }
  async #loadXML(uri) {
    const str = await this.loadText(uri)
    if (!str) return null
    const doc = this.parser.parseFromString(str, MIME.XML)
    if (doc.querySelector('parsererror'))
      throw new Error(`XML parsing error: ${uri}
${doc.querySelector('parsererror').innerText}`)
    return doc
  }
  async init() {
    const $container = await this.#loadXML('META-INF/container.xml')
    if (!$container) throw new Error('Failed to load container file')

    const opfs = Array.from($container.getElementsByTagNameNS(NS.CONTAINER, 'rootfile'), getAttributes('full-path', 'media-type')).filter(
      (file) => file.mediaType === 'application/oebps-package+xml',
    )

    if (!opfs.length) throw new Error('No package document defined in container')
    const opfPath = opfs[0].fullPath
    const opf = await this.#loadXML(opfPath)
    if (!opf) throw new Error('Failed to load package document')

    const $encryption = await this.#loadXML('META-INF/encryption.xml')
    await this.#encryption.init($encryption, opf)

    this.resources = new Resources({
      opf,
      resolveHref: (url) => resolveURL(url, opfPath),
    })
    this.#loader = new Loader({
      loadText: this.loadText,
      loadBlob: (uri) => Promise.resolve(this.loadBlob(uri)).then(this.#encryption.getDecoder(uri)),
      resources: this.resources,
      getDirectUrl: this.#getDirectUrl,
    })
    this.transformTarget = this.#loader.eventTarget
    this.sections = this.resources.spine
      .map((spineItem, index) => {
        const { idref, linear, properties = [] } = spineItem
        const item = this.resources.getItemByID(idref)
        if (!item) {
          console.warn(`Could not find item with ID "${idref}" in manifest`)
          return null
        }
        return {
          id: item.href,
          load: () => this.#loader.loadItem(item),
          unload: () => this.#loader.unloadItem(item),
          createDocument: () => this.loadDocument(item),
          size: this.getSize(item.href),
          cfi: this.resources.cfis[index],
          linear,
          pageSpread: getPageSpread(properties),
          resolveHref: (href) => resolveURL(href, item.href),
          mediaOverlay: item.mediaOverlay ? this.resources.getItemByID(item.mediaOverlay) : null,
        }
      })
      .filter((s) => s)

    const { navPath, ncxPath } = this.resources
    if (navPath)
      try {
        const resolve = (url) => resolveURL(url, navPath)
        const navDoc = await this.#loadXML(navPath)
        if (navDoc) {
          const nav = parseNav(navDoc, resolve)
          this.toc = nav.toc
          this.pageList = nav.pageList
          this.landmarks = nav.landmarks
        }
      } catch (e) {
        console.warn(e)
      }
    if (!this.toc && ncxPath)
      try {
        const resolve = (url) => resolveURL(url, ncxPath)
        const ncxDoc = await this.#loadXML(ncxPath)
        if (ncxDoc) {
          const ncx = parseNCX(ncxDoc, resolve)
          this.toc = ncx.toc
          this.pageList = ncx.pageList
        }
      } catch (e) {
        console.warn(e)
      }
    this.landmarks ??= this.resources.guide

    const { metadata, rendition, media } = getMetadata(opf)
    this.metadata = metadata
    this.rendition = rendition
    this.media = media
    this.dir = this.resources.pageProgressionDirection
    const displayOptions = getDisplayOptions(
      (await this.#loadXML('META-INF/com.apple.ibooks.display-options.xml')) ?? (await this.#loadXML('META-INF/com.kobobooks.display-options.xml')),
    )
    if (displayOptions) {
      if (displayOptions.fixedLayout === 'true') this.rendition.layout ??= 'pre-paginated'
      if (displayOptions.openToSpread === 'false')
        this.sections.find((section) => section.linear !== 'no').pageSpread ??= this.dir === 'rtl' ? 'left' : 'right'
    }
    return this
  }
  async loadDocument(item) {
    const str = await this.loadText(item.href)
    if (!str) throw new Error(`Failed to load section document: ${item.href}`)
    return this.parser.parseFromString(str, item.mediaType)
  }
  // BookOrbit fork: a streamable URL for media-overlay audio, or null when the
  // loader cannot provide one or the file has to be decoded in memory.
  async getMediaUrl(href) {
    if (!this.#loaderMediaUrl || this.#encryption.isEncrypted(href)) return null
    return this.#loaderMediaUrl(href)
  }
  getMediaOverlay() {
    return new MediaOverlay(this, this.#loadXML.bind(this))
  }
  resolveCFI(cfi) {
    return this.resources.resolveCFI(cfi)
  }
  resolveHref(href) {
    const [path, hash] = href.split('#')
    const item = this.resources.getItemByHref(decodeURI(path))
    if (!item) return null
    const index = this.resources.spine.findIndex(({ idref }) => idref === item.id)
    const anchor = hash ? (doc) => getHTMLFragment(doc, hash) : () => 0
    return { index, anchor }
  }
  splitTOCHref(href) {
    return href?.split('#') ?? []
  }
  getTOCFragment(doc, id) {
    return doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
  }
  isExternal(uri) {
    return isExternal(uri)
  }
  async getCover() {
    const cover = this.resources?.cover
    return cover?.href ? new Blob([await this.loadBlob(cover.href)], { type: cover.mediaType }) : null
  }
  async getCalibreBookmarks() {
    const txt = await this.loadText('META-INF/calibre_bookmarks.txt')
    const magic = 'encoding=json+base64:'
    if (txt?.startsWith(magic)) {
      const json = atob(txt.slice(magic.length))
      return JSON.parse(json)
    }
  }
  destroy() {
    this.#loader?.destroy()
  }
}
