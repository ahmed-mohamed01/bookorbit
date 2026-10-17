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
 * Material about a book rather than a book: annotations, excerpts, previews, companions and guides.
 * Each phrase is narrow on purpose - a bare "guide" or "companion" is a real title (`The Hitchhiker's
 * Guide to the Galaxy`, `The Companions`), so the generic words only count beside a qualifier, and
 * "annotations" and "excerpt" only where the word is the subtitle rather than part of one.
 */
export const SUPPLEMENTAL_TITLE_PATTERN =
  /\bannotations\s*$|\bexcerpt\b(?=\s*:|\s*$)|sneak (?:peek|preview)|\(preview\)\s*$|pocket companion|world guide|lore compendium|\bart ?book\b|colou?ring book|(?:study|reader['’]?s|discussion|book club) guide/i;

/** A tabletop game line filed as a series, whose rulebooks and adventures are not the author's books. */
export const SUPPLEMENTAL_SERIES_PATTERN = /\b(?:roleplaying game|role-playing game|rpg)\b/i;

/**
 * A comic edition named as one in its own title. Hardcover's Graphic Novel category is the primary
 * signal, but it is missing on `The Communist Manifesto: A Graphic Novel` and on every WEBTOON
 * printing of The Primal Hunter.
 */
export const GRAPHIC_NOVEL_TITLE_PATTERN = /\bgraphic novels?\b|\bmanga\b|\bcomics?\b|\bwebtoon\b/i;

/** A translated listing labelled with its language, in the title or the series name. */
export const LANGUAGE_EDITION_PATTERN =
  /[([](?:polish|spanish|german|french|italian|russian|finnish|dutch|portuguese|brazilian portuguese|czech|swedish|danish|norwegian|hungarian|turkish|japanese|chinese|korean|romanian|bulgarian|greek|hebrew|ukrainian|catalan)\s+edition[)\]]/i;

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
