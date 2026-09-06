export type SpineTextRef = { spineIndex: number; text: string };

// Compute an anchor's ebook fraction in [0, 1]: the character offset of `phrase`
// within the concatenated spine text (spines joined in spineIndex order, no
// separators) divided by the total character count. Returns null when the target
// spine is absent, the phrase is not found in it, or the concatenation is empty.
// Deterministic and total.
export function computeAnchorFraction(spines: readonly SpineTextRef[], spineIndex: number, phrase: string): number | null {
  if (!Array.isArray(spines) || spines.length === 0 || !phrase) return null;

  const ordered = [...spines].sort((a, b) => a.spineIndex - b.spineIndex);

  let cumulativeBefore = 0;
  let totalChars = 0;
  let target: SpineTextRef | undefined;
  for (const spine of ordered) {
    const length = typeof spine.text === 'string' ? spine.text.length : 0;
    if (spine.spineIndex < spineIndex) cumulativeBefore += length;
    if (spine.spineIndex === spineIndex) target = spine;
    totalChars += length;
  }

  if (!target || totalChars === 0) return null;

  const indexInSpine = target.text.indexOf(phrase);
  if (indexInSpine === -1) return null;

  return (cumulativeBefore + indexInSpine) / totalChars;
}
