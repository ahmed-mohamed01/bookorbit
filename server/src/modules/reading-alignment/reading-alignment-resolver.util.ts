// A single alignment anchor: a point that ties an absolute audiobook second to a
// fractional position in the concatenated ebook spine text. `ebookFraction` is in
// [0, 1]; `phrase`/`spineIndex` let a client re-locate the exact ebook position.
export type Anchor = {
  audioSeconds: number;
  ebookFraction: number;
  spineIndex: number;
  phrase: string;
};

export interface EbookResolution {
  spineIndex: number;
  phrase: string;
  // Interpolated ebook fraction expressed as a percentage in [0, 100]. A coarse
  // fallback for when the client cannot locate `phrase` exactly.
  percentage: number;
}

// Minimum anchors required to interpolate between two points.
const MIN_ANCHORS = 2;

function usableAnchors(anchors: readonly Anchor[]): Anchor[] {
  return anchors.filter((a) => a != null && typeof a.ebookFraction === 'number' && Number.isFinite(a.ebookFraction));
}

// Given a value and a monotonic axis, find the two bracketing anchors and the
// interpolation weight t in [0, 1] between them. Assumes `sorted` is ascending on
// the axis and has at least two entries. Clamps at both ends.
function bracket(sorted: Anchor[], value: number, axis: (a: Anchor) => number): { lo: Anchor; hi: Anchor; t: number } {
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (value <= axis(first)) return { lo: first, hi: first, t: 0 };
  if (value >= axis(last)) return { lo: last, hi: last, t: 0 };

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (value >= axis(lo) && value <= axis(hi)) {
      const span = axis(hi) - axis(lo);
      const t = span > 0 ? (value - axis(lo)) / span : 0;
      return { lo, hi, t };
    }
  }
  return { lo: last, hi: last, t: 0 };
}

// Map an absolute audiobook second to an ebook position. Returns the NEAREST
// anchor's phrase + spineIndex (for an exact client-side phrase search) alongside
// an interpolated percentage (coarse fallback). Null when fewer than two usable
// anchors exist.
export function audioSecondsToEbook(anchors: readonly Anchor[], audioSeconds: number): EbookResolution | null {
  const sorted = usableAnchors(anchors).sort((a, b) => a.audioSeconds - b.audioSeconds);
  if (sorted.length < MIN_ANCHORS) return null;

  const { lo, hi, t } = bracket(sorted, audioSeconds, (a) => a.audioSeconds);
  const fraction = lo.ebookFraction + t * (hi.ebookFraction - lo.ebookFraction);
  const nearest = t < 0.5 ? lo : hi;

  return {
    spineIndex: nearest.spineIndex,
    phrase: nearest.phrase,
    percentage: clampPercentage(fraction * 100),
  };
}

// Map an ebook fraction in [0, 1] to an absolute audiobook second by interpolating
// on the ebookFraction axis. Clamps at both ends. Null when fewer than two usable
// anchors exist.
export function ebookFractionToAudioSeconds(anchors: readonly Anchor[], ebookFraction: number): number | null {
  const sorted = usableAnchors(anchors).sort((a, b) => a.ebookFraction - b.ebookFraction);
  if (sorted.length < MIN_ANCHORS) return null;

  const { lo, hi, t } = bracket(sorted, ebookFraction, (a) => a.ebookFraction);
  return lo.audioSeconds + t * (hi.audioSeconds - lo.audioSeconds);
}

function clampPercentage(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
