// Strict recency comparison used by the alignment sync and resolver to apply newest-wins: a candidate
// time only wins when it is strictly newer than what it is compared against. A missing `other` (no prior
// value) counts as older, so the candidate wins.
export function isStrictlyNewer(candidate: Date, other: Date | undefined): boolean {
  if (!other) return true;
  return candidate.getTime() > other.getTime();
}

// Upper-clamps a device-reported activity time. A client with a broken clock (far future) must never
// have its timestamp written into newest-wins state, where it would outrank every genuine later
// update forever. Past timestamps pass through: they lose newest-wins naturally.
export function clampToPresent(candidate: Date, maxSkewMs: number): Date {
  const ceiling = Date.now() + maxSkewMs;
  return candidate.getTime() > ceiling ? new Date(ceiling) : candidate;
}
