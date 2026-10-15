export function textScore(value: string, query: string): number {
  const normalizedValue = normalizeText(value);
  const normalizedQuery = normalizeText(query);
  if (normalizedValue === normalizedQuery) return 1;
  if (normalizedValue.startsWith(normalizedQuery)) return 0.85;
  if (normalizedValue.includes(normalizedQuery)) return 0.65;
  return trigramSimilarity(normalizedValue, normalizedQuery) * 0.4;
}

export function normalizeText(value: string): string {
  return value
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  return (2 * shared) / (a.size + b.size);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const result = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}
