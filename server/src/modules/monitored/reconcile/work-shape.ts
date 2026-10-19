/**
 * Title shapes shared by slot resolution and the verdict step.
 *
 * Slot resolution is the only stage that decides what kind of work a row is (collection,
 * dramatization, supplemental, split part); the verdict step only flags the listing. Keeping both on
 * these shared patterns is what stops their tests drifting apart again, which once hid `Axiom`,
 * `An Autumn War` and `Cold Hearted` behind Hardcover's bare `compilation` boolean.
 */

/** A GraphicAudio-style production, or one numbered part of one. Never a book in its own right. */
export const DRAMATIZED_ADAPTATION_PATTERN = /dramatized adaptation|graphic ?audio|\(\s*\d+\s+of\s+\d+\s*\)|\bpart \d+ of \d+\b/i;

/**
 * A series Hardcover files dramatized audio episodes under: `Dungeon Crawler Carl Season 1`, or the
 * `Audio Immersion Tunnel` productions. Every row in them is plain category Book, so the series name
 * is the only signal.
 */
export const DRAMATIZED_SERIES_PATTERN = /\bseason\s+\d+\b|audio immersion tunnel/i;

/** A physically split volume: "<Book>, Part 2", "<Book>: Part Two". */
export const SPLIT_PART_SUFFIX_PATTERN = /[,:]\s*part\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** A title that announces itself as a bundle of other books. */
export const COLLECTION_TITLE_PATTERN =
  /\b(omnibus|box(?:ed)? ?set|complete series|collection|anthology|bundle|sampler|books?\s*\d+\s*[-–—]\s*\d+|\d+[- ]books?\b|trilogy|duology)\b/i;

/**
 * Material about a book rather than a book: annotations, excerpts, prologues, previews, companions and guides.
 * Each phrase is narrow on purpose - a bare "guide" or "companion" is a real title (`The Hitchhiker's
 * Guide to the Galaxy`, `The Companions`), so the generic words only count beside a qualifier, and
 * "annotations" and "excerpt" only where the word is the subtitle rather than part of one.
 */
export const SUPPLEMENTAL_TITLE_PATTERN =
  /\bannotations\s*$|:\s*prologue to\b|:\s*prologue\s*$|\bexcerpt\b(?=\s*:|\s*$)|sneak (?:peek|preview)|\(preview\)\s*$|pocket companion|world guide|lore compendium|\bart ?book\b|colou?ring book|(?:study|reader['’]?s|discussion|book club) guide/i;

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
