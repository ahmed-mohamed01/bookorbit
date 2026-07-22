// ABS-specific matching helpers. Everything else the matcher needs (title/author similarity, ISBN
// normalization) is imported directly from upstream's hardcover-import.service so upstream fixes
// reach this fork without a copy to keep in sync.

// Canonical ASIN form for ABS write boundaries and exact-match query inputs.
export function normalizeAsin(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}
