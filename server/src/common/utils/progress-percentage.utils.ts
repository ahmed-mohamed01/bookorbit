// Progress percentages are stored as Postgres `real`, which keeps about 7 significant digits, so a
// value read back never strictly equals the full-precision double a client sent. Anything finer
// than this is storage noise, not movement.
const STORED_PERCENTAGE_EPSILON = 1e-4;

export function isStoredPercentageChanged(previous: number | null | undefined, next: number): boolean {
  if (previous == null) return true;
  return Math.abs(previous - next) > STORED_PERCENTAGE_EPSILON;
}
