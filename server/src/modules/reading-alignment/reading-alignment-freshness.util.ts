// Strict recency comparison used by the alignment sync and resolver to apply newest-wins: a candidate
// time only wins when it is strictly newer than what it is compared against. A missing `other` (no prior
// value) counts as older, so the candidate wins.
export function isStrictlyNewer(candidate: Date, other: Date | undefined): boolean {
  if (!other) return true;
  return candidate.getTime() > other.getTime();
}
