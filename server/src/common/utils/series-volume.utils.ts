/**
 * Which volume of a series a title or a series number names, for the two places that must not take
 * one volume for another: owned-book matching on the watchlist and ebook/audiobook pairing. Both read
 * volumes through this one word list, so they cannot drift apart.
 */

/** Words that put a volume number after them: "Book Seven", "Volume 6", "Vol. 2", "Tome 3". */
export const VOLUME_MARKER_WORDS = ['book', 'volume', 'vol', 'tome'] as const;

/** Spelled-out volumes, read only right after a marker word: "Six of Crows" is a title, "Book Six" a volume. */
export const VOLUME_NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const;

export interface SeriesPlacedTitle {
  title: string;
  seriesName: string | null;
  seriesIndex: string | null;
}

interface StatedVolume {
  volume: number;
  /** Whether a marker word names the volume, rather than a bare number the title may reuse as a word. */
  marked: boolean;
  /** The words naming what the volume belongs to: "Beware of Chicken" in "Beware of Chicken Volume 6". */
  front: string;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?|${VOLUME_NUMBER_WORDS.join('|')})`;
const MARKED_VOLUME = new RegExp(String.raw`\b(?:${VOLUME_MARKER_WORDS.join('|')})\.?\s*${NUMBER}\b`, 'gi');
// "Beware of Chicken 5: A Xianxia Cultivation Novel" and "The Primal Hunter 16".
const NUMBER_BEFORE_SUBTITLE = /^(.*?\S)\s+(\d+(?:\.\d+)?)\s*:/;
const TRAILING_NUMBER = /^(.*?\S)[\s,]+(\d+(?:\.\d+)?)\s*$/;

function key(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

function numberValue(token: string): number {
  const word = VOLUME_NUMBER_WORDS.indexOf(token.toLowerCase() as (typeof VOLUME_NUMBER_WORDS)[number]);
  return word >= 0 ? word + 1 : Number.parseFloat(token);
}

// A four-digit year trailing a library file name ("Warbreaker - 2009") is not a volume.
function isYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1800 && value <= 2099;
}

/**
 * The volume a title states outright, or null. A leading file index ("2. Elantris") and a trailing
 * year are not volumes; a number only counts after a marker word, before a subtitle, or at the end.
 */
export function statedVolume(title: string): StatedVolume | null {
  const marked = [...title.matchAll(MARKED_VOLUME)].pop();
  if (marked?.index != null) {
    const before = title.slice(0, marked.index);
    // Inside "(The Stormlight Archive, Book 2)" the volume belongs to what the bracket names.
    const bracket = before.lastIndexOf('(');
    const front = bracket > before.lastIndexOf(')') ? before.slice(bracket + 1) : before;
    return { volume: numberValue(marked[1]), marked: true, front: front.replace(/[\s,:;\-–(]+$/, '') };
  }
  for (const pattern of [NUMBER_BEFORE_SUBTITLE, TRAILING_NUMBER]) {
    const match = pattern.exec(title);
    if (!match) continue;
    const volume = Number.parseFloat(match[2]);
    if (!isYear(volume)) return { volume, marked: false, front: match[1].replace(/[\s,:;\-–(]+$/, '') };
  }
  return null;
}

/** A bare title as a library may store it: "Beware of Chicken", "...(2022)", "...: A Xianxia Cultivation Novel". */
function bareTitleKeys(title: string): string[] {
  const withoutBrackets = title.replace(/(?:\s*[([][^)\]]*[)\]])+\s*$/, '');
  return [key(title), key(withoutBrackets), key(withoutBrackets.split(':')[0])];
}

function seriesPosition(index: string | null): number | null {
  if (index == null || index.trim() === '') return null;
  const value = Number.parseFloat(index);
  return Number.isFinite(value) ? value : null;
}

/**
 * The volume a side states, disregarded when an UNMARKED number contradicts the side's own series
 * position: that number is part of the title ("The 100" at #1, "Catch-22" at #1), not a volume. A
 * marked volume is never disregarded, since a marker word is an explicit claim.
 */
function statedVolumeGuarded(side: SeriesPlacedTitle, position: number | null): StatedVolume | null {
  const stated = statedVolume(side.title);
  return stated && !stated.marked && position != null && position !== stated.volume ? null : stated;
}

/**
 * True when two books already matched by title are different volumes of one series:
 *
 * - both carry a number in the same series and the numbers differ. The series names must be equal,
 *   format labels included: "Mistborn" and "Mistborn: Wax and Wayne" number The Alloy of Law #4 and
 *   #1, and "The Water Magician (Manga)" is not "The Water Magician (Light Novel)". Equal numbers
 *   alone prove nothing; the stated-volume checks below still run.
 * - a bare number the title carries is not a volume at all when the book's own series number says
 *   otherwise: "The 100" in series "The 100" #1 is the first book, not volume 100. Only a marker
 *   word states a volume the series position cannot veto.
 * - both titles state a volume and the volumes differ: "Book Seven" and "Book Three".
 * - one stated volume's front is the other book's own whole title: that title names the series, and
 *   the book is its bare first one ("The 100" against "The 100 (The 100, Book 1)"), so only a stated
 *   volume other than 1 differs.
 * - one title states volume N of a series the other book is numbered in, at a different number.
 * - one title states a volume other than 1 and the other is that series' bare title with no number at
 *   all, which is the first book: "Beware of Chicken Volume 6" against "Beware of Chicken". A bare
 *   title that is not the series ("Words of Radiance" against "...(The Stormlight Archive, Book 2)")
 *   says nothing about the volume.
 */
export function seriesVolumeConflict(left: SeriesPlacedTitle, right: SeriesPlacedTitle): boolean {
  const leftPosition = seriesPosition(left.seriesIndex);
  const rightPosition = seriesPosition(right.seriesIndex);
  const sameSeries = Boolean(left.seriesName && right.seriesName && key(left.seriesName) === key(right.seriesName));
  if (sameSeries && leftPosition != null && rightPosition != null && leftPosition !== rightPosition) return true;

  const leftStated = statedVolumeGuarded(left, leftPosition);
  const rightStated = statedVolumeGuarded(right, rightPosition);
  if (leftStated && rightStated) {
    // A stated volume whose front is the other book's whole title reads that title as the series it
    // opens, and the other book as that series' bare first one: "The 100" against "The 100 (The 100,
    // Book 1)" is the same book either way, so the trailing number is the only thing left to compare.
    const namesOthersTitle = (stated: StatedVolume, other: SeriesPlacedTitle): boolean => {
      const frontKey = key(stated.front);
      // The other book's FULL title: "Rise of the Living Forge (Book 2)" keeps its own volume in brackets.
      return frontKey !== '' && frontKey === key(other.title);
    };
    if (namesOthersTitle(rightStated, left)) return rightStated.volume !== 1;
    if (namesOthersTitle(leftStated, right)) return leftStated.volume !== 1;
    return leftStated.volume !== rightStated.volume;
  }

  const oneSided = (stated: StatedVolume | null, statedSide: SeriesPlacedTitle, other: SeriesPlacedTitle, otherPosition: number | null) => {
    if (!stated) return false;
    const series = new Set([key(stated.front), ...(statedSide.seriesName ? [key(statedSide.seriesName)] : [])]);
    series.delete('');
    if (otherPosition != null) return Boolean(other.seriesName && series.has(key(other.seriesName))) && otherPosition !== stated.volume;
    return stated.volume !== 1 && bareTitleKeys(other.title).some((bare) => series.has(bare));
  };
  return oneSided(leftStated, left, right, rightPosition) || oneSided(rightStated, right, left, leftPosition);
}
