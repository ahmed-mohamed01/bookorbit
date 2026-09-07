/**
 * Title and flag shapes shared by slot resolution and the verdict step.
 *
 * Both stages ask the same questions of a work - is this a dramatized audio production, is this a
 * repackaged collection, does Hardcover's `compilation` boolean mean anything here - and they used to
 * answer them with their own near-copies of the same regexes. The copies drifted: one matched
 * `graphic ?audio` and the other only `graphicaudio`, and one refused to trust `compilation` on its
 * own while the other trusted it outright, which hid `An Autumn War`, `Axiom` and `Cold Hearted`.
 */

/** A GraphicAudio-style production, or one numbered part of one. Never a book in its own right. */
export const DRAMATIZED_ADAPTATION_PATTERN = /dramatized adaptation|graphic ?audio|\(\s*\d+\s+of\s+\d+\s*\)|\bpart \d+ of \d+\b/i;

/** A physically split volume: "<Book>, Part 2", "<Book>: Part Two". */
export const SPLIT_PART_SUFFIX_PATTERN = /[,:]\s*part\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** A title that announces itself as a bundle of other books. */
export const COLLECTION_TITLE_PATTERN =
  /\b(omnibus|box(?:ed)? ?set|complete series|collection|anthology|bundle|sampler|books?\s*\d+\s*[-–—]\s*\d+|\d+[- ]books?\b|trilogy|duology)\b/i;

/**
 * Known divergence, deliberately left in place.
 *
 * slot-resolution refuses to act on Hardcover's bare `compilation` boolean without corroboration,
 * because it is set on single novels: `Axiom` is Artorian's Archives #1, `An Autumn War` is Long
 * Price Quartet #3, `Cold Hearted` is Tooth & Claw #1. verdict.ts still trusts it, which hides those
 * three.
 *
 * Relaxing verdict to match was measured across 48 authors: it recovers 6 real novels and exposes
 * about 14 genuine omnibuses, anthologies and magazines that hold a series position and carry no
 * bundle word - `The Complete Wheel of Time`, `Shadow and Betrayal`, `Unfettered III`, `Interzone
 * 157`, `The Living Dead`. Net negative, so the divergence stands.
 *
 * A correct fix needs the two signals slot-resolution has and verdict does not: `book_category_id`
 * (8 = Collection) and the author-credit count that drives multi_author_anthology. Both live on the
 * raw Hardcover observations. The clean shape is to decide "is this a collection" once, in slot
 * resolution, and let verdict read the answer rather than re-deriving it.
 */
