import type { PlaceholderCoverStyle } from '@bookorbit/types'
import { renderPlaceholder, type PlaceholderStrings } from '@/features/book/lib/placeholder'

export interface Colors {
  dark: string
  light: string
  accent: string
  mid: string
  darkL?: number
}

export interface Bust {
  hr: number
  hx: number
  hy: number
  sw: number
  top: number
  neck: number
  shoulders: string
  neckPath: string
  head: string
  all: string
}

type FigureRenderer = (b: Bust, c: Colors) => string

/** One oklch colour pulled out of the engine's markup: lightness, chroma, and the original string. */
interface ArtworkColor {
  l: number
  c: number
  h: number
  s: string
}

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

function rng(seed: number): () => number {
  let s = seed || 1
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

// Pull the engine's own colours out of its markup and sort them by lightness and chroma.
export function colorsOf(markup: string): Colors {
  const found = [...markup.matchAll(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)].map((m) => ({
    l: +(m[1] ?? '0'),
    c: +(m[2] ?? '0'),
    h: +(m[3] ?? '0'),
    s: m[0],
  }))
  const uniq = [...new Map(found.map((c) => [c.s, c])).values()]
  if (!uniq.length) return { dark: 'oklch(0.2 0.02 265)', light: 'oklch(0.95 0.01 85)', accent: 'oklch(0.6 0.18 30)', mid: 'oklch(0.6 0.05 265)' }
  const byL = [...uniq].sort((a, b) => a.l - b.l)
  const dark = byL[0] as ArtworkColor
  const light = byL[byL.length - 1] as ArtworkColor
  const vivid = [...uniq].filter((c) => c.l > 0.35 && c.l < 0.88).sort((a, b) => b.c - a.c)
  const accent = (vivid[0] ?? byL[Math.floor(byL.length / 2)]) as ArtworkColor
  const mid = (vivid[1] ?? accent) as ArtworkColor
  return { dark: dark.s, light: light.s, accent: accent.s, mid: mid.s, darkL: dark.l }
}

// One bust shape in the engine's 600x600 square design space, nudged per author.
function bust(seed: number): Bust {
  const r = rng(seed)
  const hr = 78 + r() * 18
  const hx = 300 + (r() - 0.5) * 16
  const hy = 228 + r() * 18
  const sw = 180 + r() * 40
  const top = hy + hr + 26 + r() * 10
  const neck = 34 + r() * 10
  const shoulders = `M ${300 - sw - 20} 640 C ${300 - sw - 10} ${top + 70} ${300 - sw * 0.55} ${top} ${300 - neck} ${top - 6} L ${300 + neck} ${top - 6} C ${300 + sw * 0.55} ${top} ${300 + sw + 10} ${top + 70} ${300 + sw + 20} 640 Z`
  const neckPath = `M ${hx - neck * 0.75} ${hy + hr * 0.6} L ${hx + neck * 0.75} ${hy + hr * 0.6} L ${300 + neck} ${top} L ${300 - neck} ${top} Z`
  return {
    hr,
    hx,
    hy,
    sw,
    top,
    neck,
    shoulders,
    neckPath,
    head: `<circle cx="${hx}" cy="${hy}" r="${hr}"/>`,
    all: `<path d="${shoulders}"/><path d="${neckPath}"/><circle cx="${hx}" cy="${hy}" r="${hr}"/>`,
  }
}

const PROFILE =
  'M 92 640 C 100 520 170 470 236 452 C 214 430 196 404 190 372 C 168 350 160 312 170 280 C 176 196 238 146 318 150 C 390 154 430 202 432 252 L 438 286 L 462 320 C 466 328 460 334 450 334 L 446 350 C 450 356 448 362 440 366 L 444 378 C 446 392 436 402 418 404 C 400 406 388 410 386 422 L 386 452 C 440 470 500 510 512 640 Z'

const FIGURES: Record<PlaceholderCoverStyle, FigureRenderer> = {
  bauhaus(b, c) {
    return (
      `<circle cx="300" cy="330" r="232" fill="${c.light}"/>` +
      `<g fill="${c.dark}"><path d="${b.shoulders}"/><path d="${b.neckPath}"/></g>` +
      `<path d="${b.shoulders}" fill="${c.accent}" clip-path="url(#half)"/>` +
      `<circle cx="${b.hx}" cy="${b.hy}" r="${b.hr}" fill="${c.mid === c.accent ? c.dark : c.mid}"/>` +
      `<defs><clipPath id="half"><rect x="300" y="0" width="300" height="640"/></clipPath></defs>`
    )
  },
  constructivist(b, c) {
    const t = `rotate(-7 300 380)`
    const hr = b.hr
    const head = `${b.hx - hr * 0.8},${b.hy - hr} ${b.hx + hr * 0.75},${b.hy - hr * 0.92} ${b.hx + hr},${b.hy + hr * 0.15} ${b.hx + hr * 0.5},${b.hy + hr} ${b.hx - hr * 0.6},${b.hy + hr * 0.95} ${b.hx - hr},${b.hy}`
    const body = `${300 - b.sw - 40},640 ${300 - b.sw * 0.7},${b.top + 10} ${300 - b.neck},${b.top - 10} ${300 + b.neck},${b.top - 10} ${300 + b.sw * 0.75},${b.top + 20} ${300 + b.sw + 40},640`
    return (
      `<g transform="${t}"><polygon points="${body}" fill="${c.dark}"/><polygon points="${head}" fill="${c.dark}"/></g>` +
      `<polygon points="40,600 600,250 600,330 120,640" fill="${c.accent}" opacity=".92"/>`
    )
  },
  memphis(b, c) {
    const ink = (c.darkL ?? 1) < 0.35 ? c.dark : 'oklch(0.2 0.02 265)'
    return (
      `<g transform="translate(18 14)" fill="${ink}">${b.all}</g>` +
      `<g fill="${c.mid}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"><path d="${b.shoulders}"/><circle cx="${b.hx}" cy="${b.hy}" r="${b.hr}"/></g>`
    )
  },
  clothbound(b, c) {
    const gold = 'oklch(0.76 0.11 80)'
    return (
      `<defs><clipPath id="oval"><ellipse cx="300" cy="320" rx="200" ry="250"/></clipPath></defs>` +
      `<ellipse cx="300" cy="320" rx="200" ry="250" fill="${c.light}"/>` +
      `<g clip-path="url(#oval)"><path d="${PROFILE}" fill="${c.dark}" transform="translate(10 20)"/></g>` +
      `<ellipse cx="300" cy="320" rx="212" ry="262" fill="none" stroke="${gold}" stroke-width="6"/>` +
      `<ellipse cx="300" cy="320" rx="226" ry="276" fill="none" stroke="${gold}" stroke-width="2.5"/>`
    )
  },
  poster(b, c) {
    const s = 1.38
    return `<g transform="translate(300 600) scale(${s}) translate(-300 -560)" fill="${(c.darkL ?? 1) < 0.4 ? c.light : c.dark}" opacity=".94">${b.all}</g>`
  },
  aurora(b, c) {
    return (
      `<defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter></defs>` +
      `<g fill="none" stroke="${c.light}" stroke-width="22" filter="url(#glow)" opacity=".9">${b.all}</g>` +
      `<g fill="oklch(0.14 0.03 265)">${b.all}</g>`
    )
  },
  vista(b, c) {
    const y = 70
    return (
      `<g transform="translate(0 ${y})" fill="${c.dark}">${b.all}</g>` +
      `<path d="M0 560 C 120 520 210 540 300 556 C 400 572 500 530 600 548 L600 700 L0 700 Z" fill="${c.dark}"/>`
    )
  },
  marbled(b, c) {
    return (
      `<path fill-rule="evenodd" fill="oklch(0.95 0.015 85)" d="M-100 -100 H700 V760 H-100 Z ${b.shoulders} M ${b.hx - b.hr} ${b.hy} a ${b.hr} ${b.hr} 0 1 0 ${b.hr * 2} 0 a ${b.hr} ${b.hr} 0 1 0 ${-b.hr * 2} 0 Z"/>` +
      `<g fill="none" stroke="${c.dark}" stroke-width="4"><path d="${b.shoulders}"/><circle cx="${b.hx}" cy="${b.hy}" r="${b.hr}"/></g>`
    )
  },
  paperback(b, c) {
    const ink = c.accent
    return (
      `<circle cx="300" cy="300" r="150" fill="oklch(0.97 0.01 85)" stroke="${ink}" stroke-width="10"/>` +
      `<defs><clipPath id="roundel"><circle cx="300" cy="300" r="140"/></clipPath></defs>` +
      `<g clip-path="url(#roundel)" fill="${ink}"><g transform="translate(300 300) scale(.46) translate(-300 -300) translate(0 40)">${b.all}</g></g>`
    )
  },
}

let nextId = 0

/**
 * SVG markup for an author without a portrait: the cover engine's artwork with no text, plus one
 * figure layer on top, coloured from that same artwork so the silhouette always matches the
 * author's book covers.
 */
export function renderAuthorPlaceholder(
  style: PlaceholderCoverStyle,
  name: string,
  size: { width: number; height: number },
  strings: PlaceholderStrings,
): string {
  const seed = name.trim() || '?'
  const art = renderPlaceholder(style, { title: '', authors: [seed], seed }, size, strings)
  // Portrait slots crop the square figure to its middle 400 units and lift it clear of the name bar.
  const view = size.width / size.height >= 0.85 ? '0 0 600 600' : '100 40 400 600'
  const c = colorsOf(art)
  const b = bust(hash(seed + style))
  const draw = FIGURES[style] ?? FIGURES.bauhaus
  const uid = `ap${(nextId++).toString(36)}`
  const fig = draw(b, c)
    .replace(/id="(\w+)"/g, `id="$1${uid}"`)
    .replace(/url\(#(\w+)\)/g, `url(#$1${uid})`)
  return (
    art +
    `<svg viewBox="${view}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" style="position:absolute;inset:0" aria-hidden="true">${fig}</svg>`
  )
}
