const QUALIFIER_TOKEN =
  "(?:web\\s*novels?|light\\s*novels?|novels?|wn|ln|mtl|machine\\s*translat(?:ed|ions?)|kr|cn|jp|ko|zh|en|korean|chinese|japanese|english)";
const QUALIFIER_GROUP = new RegExp(`\\s*[(\\[]\\s*${QUALIFIER_TOKEN}(?:\\s*[,/&-]?\\s*${QUALIFIER_TOKEN})*\\s*[)\\]]`, "giu");
const MTL_GROUP = /[([]\s*(?:[^()[\]]*[\s,/&-])?(?:mtl|machine\s*translat(?:ed|ions?))(?:[\s,/&-][^()[\]]*)?\s*[)\]]/iu;
const MTL_PREFIX = /^\s*mtl(?:\s*[-:]\s*|\s+)/iu;

/** Edition tags such as "(Web Novel KR)", "[MTL]" or a leading "MTL-" say how a site labels a copy, not what the series is called. */
export function stripEditionQualifiers(title: string): string {
  return title.replace(QUALIFIER_GROUP, "").replace(MTL_PREFIX, "").trim();
}

export function isMachineTranslationTitle(title: string): boolean {
  if (MTL_PREFIX.test(title)) return true;
  for (const match of title.matchAll(new RegExp(QUALIFIER_GROUP.source, "giu"))) {
    if (MTL_GROUP.test(match[0])) return true;
  }
  return false;
}

/** Key for deciding that two titles name the same series: qualifiers, case, accents, apostrophe style and punctuation do not matter. */
export function normalizeSerialTitle(value: string): string {
  return stripEditionQualifiers(value)
    .replace(/\s*\((?:official|doujinshi)(?:\s+[^)]*)?\)\s*$/iu, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLE = /^(?:the|a|an) /u;
const SUBTITLE_SEPARATOR = /:|\s[-–]\s/u;
const MIN_BASE_LENGTH = 3;
const PART_NUMBER = "(?:\\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)";
const ROMANIZED_NUMBER = "(?:ichi|ni|san|yon|shi|go|roku|nana|shichi|hachi|kyuu|kyu|ku|juu|ju|\\d+)";
const TRAILING_PART_MARKERS = [
  new RegExp(` (?:part|season|book|volume|vol|arc) ${PART_NUMBER}$`, "u"),
  new RegExp(` (?:\\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|final) (?:part|season|arc)$`, "u"),
  new RegExp(` dai ?${ROMANIZED_NUMBER} ?(?:bu|shou|sho|ki)$`, "u"),
  / arc$/u,
];

/**
 * The name of the whole series a part belongs to: "The Water Magician: The Central Provinces Arc" and "Water Magician"
 * both give "water magician". Only meaningful together with an author check, since unrelated series share base titles.
 */
export function baseSeriesTitle(title: string): string {
  const stripped = stripEditionQualifiers(title);
  const separator = stripped.search(SUBTITLE_SEPARATOR);
  const head = separator > 0 ? withoutLeadingArticle(normalizeSerialTitle(stripped.slice(0, separator))) : "";
  let base = head.length >= MIN_BASE_LENGTH ? head : withoutLeadingArticle(normalizeSerialTitle(stripped));
  for (let changed = true; changed;) {
    changed = false;
    for (const marker of TRAILING_PART_MARKERS) {
      const next = base.replace(marker, "");
      if (next !== base && next.length >= MIN_BASE_LENGTH) {
        base = next;
        changed = true;
      }
    }
  }
  return base;
}

function withoutLeadingArticle(value: string): string {
  const next = value.replace(LEADING_ARTICLE, "");
  return next.length > 0 ? next : value;
}

/**
 * Romanized Japanese writes a long vowel as "ō", "ou", "oo" or just "o": "Kubō", "Kubou" and "Kubo" are one name. Only a
 * token made of Japanese syllables is folded, and "oo" only at its end, so "Kim Young" and "Kim Yong" or "Moore" and
 * "More" stay apart.
 */
const ROMANIZED_JAPANESE = /^(?:(?:[kgsztdnhbpmr]y?|sh|ch|ts|j|f|w|y)?[aeiou]|n)+$/u;
const LONG_VOWEL = /([aeiu])\1|ou|oo$/gu;
/** Looser folding for deciding two names are different people: "Ookubo", "Ohkubo" and "Okubo" are one name too. */
const LOOSE_LONG_VOWEL = /([aeiou])\1|ou/gu;
const PINYIN_SYLLABLE =
  /^(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(?:iang|iong|uang|ang|eng|ing|ong|ian|iao|uai|uan|ai|ei|ao|ou|an|en|in|un|ia|ie|iu|ua|uo|ui|ue|ve|er|a|o|e|i|u|v)$/u;
/** Credits name a role after the person: "Oda Eiichiro (Story & Art)", "DUBU (REDICE STUDIO)", "Naoki Urasawa - Art". */
const ROLE_GROUP = /\s*[([][^)\]]*[)\]]/gu;
const ROLE_SUFFIX = /\s+[-\u2013\u2014]\s+.*$/u;

function authorKey(name: string): string {
  return normalizeSerialTitle(name)
    .split(" ")
    .filter(Boolean)
    .map((part) => (ROMANIZED_JAPANESE.test(part) ? part.replace(LONG_VOWEL, (pair) => pair[0]!) : part))
    .sort()
    .join(" ");
}

/** One entry per credited person. "Urasawa, Naoki" may be one person written surname first, so it also counts as a whole. */
function creatorNames(values: readonly string[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    for (const listed of value.replace(ROLE_GROUP, " ").split(/[;/]|\band\b/iu)) {
      const parts = listed
        .split(",")
        .map((part) => part.replace(ROLE_SUFFIX, "").trim())
        .filter(Boolean);
      if (parts.length === 2 && parts.every((part) => !/\s/u.test(part))) names.push(`${parts[1]} ${parts[0]}`);
      for (const part of parts) names.push(...part.split("&"));
    }
  }
  return names.map((name) => name.trim()).filter(Boolean);
}

function authorKeys(names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of creatorNames(names)) {
    const key = authorKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

/** Same person on both sides, whatever the name order: "Kubou Tadashi" and "Tadashi Kubou" agree. */
export function authorsMatch(left: readonly string[], right: readonly string[]): boolean {
  const known = authorKeys(right);
  if (known.size === 0) return false;
  for (const key of authorKeys(left)) if (known.has(key)) return true;
  return false;
}

const PLACEHOLDER_AUTHORS = new Set(["unknown", "anonymous", "n a"]);

interface ComparableName {
  /** Spellings of the name with spaces, hyphens and apostrophes gone, in written and in sorted token order. */
  forms: string[];
  /** Pinyin-shaped ("Wo Chi Xi Hong Shi"): sites often translate such a pen name ("I Eat Tomatoes") instead. */
  pinyin: boolean;
}

function comparableName(name: string): ComparableName | null {
  const plain = normalizeSerialTitle(name.replace(/['\u2019`-]/gu, ""));
  if (!plain || PLACEHOLDER_AUTHORS.has(plain) || !/^[a-z0-9 ]+$/u.test(plain) || !/[a-z]/u.test(plain)) return null;
  const tokens = plain.split(" ").map((token) => {
    const folded = token.replace(/oh(?![aeiou])/gu, "o");
    return ROMANIZED_JAPANESE.test(folded) ? folded.replace(LOOSE_LONG_VOWEL, (pair) => pair[0]!) : token;
  });
  return {
    forms: [...new Set([tokens.join(""), [...tokens].sort().join("")])],
    pinyin: tokens.length >= 2 && tokens.every((token) => PINYIN_SYLLABLE.test(token)),
  };
}

function comparableNames(values: readonly string[]): ComparableName[] {
  return creatorNames(values)
    .map(comparableName)
    .filter((name) => name !== null);
}

/**
 * Both sides name a real person in Latin script and none of them agree: a same-titled work by someone else. Only names
 * that can be compared count: a name in another script never contradicts, nor does a pinyin name against a translated one.
 * Pass the series' artists with its authors, since a site may credit the artist alone.
 */
export function authorsContradict(left: readonly string[], right: readonly string[]): boolean {
  const known = comparableNames(right);
  const other = comparableNames(left);
  const forms = new Set(known.flatMap((name) => name.forms));
  if (other.some((name) => name.forms.some((form) => forms.has(form)))) return false;
  return other.some((name) => known.some((candidate) => candidate.pinyin === name.pinyin));
}

/** The series name without its subtitle, keeping the original wording: "The Water Magician: The Central Provinces Arc" gives "The Water Magician". */
export function baseSeriesDisplayTitle(title: string): string {
  const stripped = stripEditionQualifiers(title);
  const separator = stripped.search(SUBTITLE_SEPARATOR);
  const head = separator > 0 ? stripped.slice(0, separator).trim() : "";
  let base = head.length >= MIN_BASE_LENGTH ? head : stripped;
  for (let changed = true; changed;) {
    changed = false;
    for (const marker of TRAILING_PART_MARKERS) {
      const next = base.replace(new RegExp(marker.source, "iu"), "");
      if (next !== base && next.length >= MIN_BASE_LENGTH) {
        base = next.trim();
        changed = true;
      }
    }
  }
  return base;
}
