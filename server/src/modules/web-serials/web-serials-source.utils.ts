export const MAX_SOURCE_CANDIDATES = 6;

export function normalizedSourceName(sourceName: string): string {
  return sourceName.trim().toLocaleLowerCase();
}

export function sameSource(left: string, right: string): boolean {
  return normalizedSourceName(left) === normalizedSourceName(right);
}
