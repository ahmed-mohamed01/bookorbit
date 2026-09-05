import { foldDiacritics } from '../monitored-text.utils';
import type { Observation, WorkCluster } from './observation.types';

const EDITION_TAIL_PATTERN =
  /\s*[:,-]?\s*(an? [\w ]{0,14}litrpg[\w ']*|an? (isekai|progression fantasy|gamelit)[\w ']*|unabridged|special edition|deluxe edition|graphicaudio.*|dramatized adaptation.*|web serial)$/i;

const COMPILATION_TITLE_PATTERN =
  /\b(books?\s*\d+\s*[-–—]\s*\d+|omnibus|box ?set|boxed ?set|collection|complete series|bundle|anthology|sampler|trilogy|duology|\d+[- ]book)\b/i;

function isCompilationObservation(observation: Observation): boolean {
  const raw = typeof observation.raw === 'object' && observation.raw !== null ? (observation.raw as Record<string, unknown>) : {};
  return raw.compilation === true || COMPILATION_TITLE_PATTERN.test(observation.title);
}

export function normalizeText(value: string | null | undefined): string {
  return foldDiacritics(value ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeCore(title: string, seriesName?: string | null): string {
  let core = title;
  let previous: string;
  do {
    previous = core;
    core = core.replace(/\s*[([][^)\]]{0,60}[)\]]\s*$/, '');
  } while (core !== previous);
  if (core.trim().length < 3) core = title;
  core = normalizeText(core).replace(EDITION_TAIL_PATTERN, '');
  // Fold audiobook/omnibus part splits into the base title: "... Part 1", "... Part One", "... Pt 2",
  // "... Vol 3", "... part 2 of 6". The individual volumes are the same work as the whole book.
  core = core.replace(/\s+(part|pt|vol|volume)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)(\s+of\s+\S+)?$/i, '').trim();

  const normalizedSeries = normalizeText(seriesName);
  if (normalizedSeries) {
    const escapedSeries = escapeRegExp(normalizedSeries);
    for (const pattern of [
      new RegExp(`^${escapedSeries}\\s*(?:book\\s*)?\\d+\\s*`, 'i'),
      new RegExp(`\\s*${escapedSeries}\\s*(?:book\\s*)?\\d*$`, 'i'),
    ]) {
      const stripped = core.replace(pattern, '').trim();
      if (stripped.length >= 4) core = stripped;
    }
  }

  core = core.replace(/^(?:[a-z]+ ){1,4}?(?:book )?\d+\s+/, (match, offset: number, source: string) => {
    return source.slice(offset + match.length).length >= 4 ? '' : match;
  });
  return core.replace(/\s+/g, ' ').trim() || normalizeText(title);
}

export function diceTokens(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function numericSeriesIndex(value: string | null): number | null {
  // Number('') is 0, so an empty or blank index would invent a shared slot 0 that many unrelated
  // books land in. A missing index is unknown, never zero.
  if (value == null || value.trim() === '' || /[-\u2013\u2014,]/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// A row with at most this fraction of the dominant edition's readership is a minor edition of it - a
// translation, a reprint, a stray listing - rather than a book making its own claim on the identity.
const MINOR_EDITION_RATIO = 0.2;

// Only low-information English function words are removed for fuzzy title comparison.
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for']);

// A core that survives stopword stripping as an empty string carries no title information: a
// non-Latin or punctuation-only title normalizes to '', and treating two such empties as identical
// fuses every unrelated foreign-script work into one blob. An empty side is never similar to
// anything, and the raw-core equality shortcut only counts when the core is real.
function stripStopwords(value: string): string {
  return value
    .split(' ')
    .filter((token) => token && !TITLE_STOPWORDS.has(token))
    .join(' ');
}

// A degenerate core (empty from a non-Latin title, or a bare volume number) is not a title and must
// never drive a merge: it would collapse every foreign-script or "Vol. N" edition into one blob.
function isDegenerateCore(core: string): boolean {
  return core.length < 3 || /^\d+$/.test(core);
}

function titleSimilarity(left: string, right: string): number {
  const strippedLeft = stripStopwords(left);
  const strippedRight = stripStopwords(right);
  if (!strippedLeft || !strippedRight) return left !== '' && left === right ? 1 : 0;
  return diceTokens(strippedLeft, strippedRight);
}

function isTranslationEdition(observation: Observation): boolean {
  const language = observation.language?.toLowerCase();
  return language != null && language !== 'english' && language !== 'en';
}

function metaSlotTitleMatch(left: string, right: string): boolean {
  if (titleSimilarity(left, right) < 0.6) return false;
  const leftTokens = stripStopwords(left).split(' ').filter(Boolean);
  const rightTokens = stripStopwords(right).split(' ').filter(Boolean);
  if (leftTokens.length > 4 || rightTokens.length > 4) return true;
  const rightSet = new Set(rightTokens);
  return new Set(leftTokens.filter((token) => rightSet.has(token))).size >= 2;
}

// A series index only identifies a book WITHIN its own series, and providers file one book under
// different series: Hardcover calls The Lost Metal "Mistborn: Wax & Wayne" #4 while Goodreads and
// Audible call it "Mistborn" #7. Comparing those bare numbers made 4 != 7 read as two different
// books and split the work, leaving the Audible edition to attach to whichever same-titled row did
// happen to share a number - the translation. Indexes are therefore compared only inside a series
// both sides actually claim; when they share no series the index carries no evidence either way and
// the title and year checks decide.
// Slots are read for every pair the passes consider, and rebuilding the map each time turned a linear
// derivation into a quadratic one on large catalogs. The cache is keyed by the observation object, so
// it lives exactly as long as the observation does.
const seriesSlotCache = new WeakMap<Observation, Map<string, number>>();

function seriesSlots(observation: Observation): Map<string, number> {
  const cached = seriesSlotCache.get(observation);
  if (cached) return cached;
  const slots = new Map<string, number>();
  const add = (name: string | null | undefined, index: string | null | undefined): void => {
    const key = normalizeText(name);
    const numeric = numericSeriesIndex(index ?? null);
    if (!key || numeric == null || slots.has(key)) return;
    slots.set(key, numeric);
  };
  add(observation.seriesName, observation.seriesIndex);
  for (const membership of observation.seriesMemberships ?? []) add(membership.name, membership.index);
  seriesSlotCache.set(observation, slots);
  return slots;
}

// How many series both sides place this book at the SAME index. One agreement is what any shared
// slot already gives; two independent series agreeing is evidence no coincidence explains.
function agreeingSlotCount(left: Observation, right: Observation): number {
  const leftSlots = seriesSlots(left);
  let agreed = 0;
  for (const [name, index] of seriesSlots(right)) if (leftSlots.get(name) === index) agreed++;
  return agreed;
}

function featuredSlotKey(observation: Observation): string | null {
  const seriesIndex = numericSeriesIndex(observation.seriesIndex);
  if (!observation.seriesName || seriesIndex == null) return null;
  return `${normalizeText(observation.seriesName)}#${seriesIndex}`;
}

function slotsCompatible(left: Observation, right: Observation): boolean {
  const leftSlots = seriesSlots(left);
  const rightSlots = seriesSlots(right);
  if (leftSlots.size === 0 || rightSlots.size === 0) return true;
  let shared = false;
  for (const [name, index] of leftSlots) {
    const other = rightSlots.get(name);
    if (other == null) continue;
    shared = true;
    if (other === index) return true;
  }
  return !shared;
}

function yearsCompatible(left: Observation, right: Observation): boolean {
  // An audiobook edition routinely ships years after the text edition it narrates, so a year gap
  // between an Audible row and a Hardcover/Goodreads row is not evidence of two different books.
  // Between two text rows a year gap still separates same-titled works, so the check stays there.
  // A translated audiobook is exempt from the exemption: its year gap is a separate translation
  // schedule rather than format lag, and Hardcover carries no language to balance it out.
  const crossFormat = (left.source === 'audible') !== (right.source === 'audible') && !isTranslationEdition(left) && !isTranslationEdition(right);
  return crossFormat || left.releaseYear == null || right.releaseYear == null || Math.abs(left.releaseYear - right.releaseYear) <= 1;
}

function slotAndYearCompatible(left: Observation, right: Observation): boolean {
  return slotsCompatible(left, right) && yearsCompatible(left, right);
}

// Inside one series slot the members are the same book by construction, so the slot pass keeps its
// freedom to fold editions whose years drift (a Goodreads edition year against a Hardcover first
// publication year is routine, and blocking on it costs a flagship work its cross-source evidence).
// The one pair it must not fold is what the year exemption was narrowed to exclude: a translated
// edition runs on its own translation schedule, so a year gap between it and the anchor is evidence
// of a different book rather than of edition or format lag.
function slotEditionCompatible(left: Observation, right: Observation): boolean {
  if (!isTranslationEdition(left) && !isTranslationEdition(right)) return true;
  return slotAndYearCompatible(left, right);
}

const AUTHOR_ROLE_PATTERN = /^(author|writer)$/i;

// Hardcover ships one row per contribution, so the same book id arrives once per role the author
// holds on it ("Author" alongside "Author-duplicate", or "Translator" alongside "Author"). The rows
// differ only in that role, and the role decides the wrong_contributor flag, so the copy that
// survives has to be the strongest claim rather than whichever one the payload happened to put last.
function roleRank(observation: Observation): number {
  if (observation.role == null) return 1;
  return AUTHOR_ROLE_PATTERN.test(observation.role) ? 0 : 2;
}

function observationOrder(left: Observation, right: Observation): number {
  return (
    left.id.localeCompare(right.id) ||
    roleRank(left) - roleRank(right) ||
    (left.role ?? '').localeCompare(right.role ?? '') ||
    right.popularity - left.popularity ||
    left.title.localeCompare(right.title) ||
    (left.releaseDate ?? '').localeCompare(right.releaseDate ?? '') ||
    (left.seriesName ?? '').localeCompare(right.seriesName ?? '') ||
    (left.seriesIndex ?? '').localeCompare(right.seriesIndex ?? '')
  );
}

/**
 * The observation SET in one canonical order, one row per provider work. Every pass below merges
 * greedily and re-reads the clusters it has already built, so the arrival order decides the merge
 * path: the same payload in a different order yields a different catalog, which is what made a
 * refresh move an Audible edition between two works on data that had not changed. Sorting on
 * content makes the matcher a pure function of the set. Dropping repeated ids in the same pass stops
 * one provider work from seeding two clusters, which minted a second catalog row for it.
 */
export function canonicalObservations(input: Observation[]): Observation[] {
  const sorted = [...input].sort(observationOrder);
  return sorted.filter((observation, index) => index === 0 || observation.id !== sorted[index - 1].id);
}

export function matchObservations(input: Observation[]): WorkCluster[] {
  const observations = canonicalObservations(input);
  // Each core costs a handful of regex passes and is read by every later pass, so it is derived once.
  const cores = observations.map((observation) => normalizeCore(observation.title, observation.seriesName));
  const parent = observations.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot;
  };

  const byId = new Map(observations.map((observation, index) => [observation.id, index]));
  for (let index = 0; index < observations.length; index++) {
    const canonicalIndex = observations[index].canonicalId ? byId.get(observations[index].canonicalId!) : undefined;
    if (canonicalIndex == null) continue;
    // A canonical_id is the provider's edition pointer, and providers hang box sets off one of the
    // books they collect. This pass runs before every guarded tier, so an unchecked union planted a
    // compilation inside a real work where no later compilation guard could see it. A box set may
    // only canonical-fold into another box set; otherwise it stays standalone for the guarded tiers.
    if (isCompilationObservation(observations[index]) !== isCompilationObservation(observations[canonicalIndex])) continue;
    union(index, canonicalIndex);
  }

  // Every pass after the canonical fold matches on cluster REPRESENTATIVES (the highest-read edition
  // of each canonical group), never raw observations. Hardcover data has editions whose canonical_id
  // or series slot points at the wrong book; matching on raw rows lets one such bad edge transitively
  // fuse two large correct clusters. A representative carries the dominant edition's real title and
  // slot, so a mis-tagged minor edition stays inside its group and cannot bridge across works.
  const currentReps = (): number[] => {
    const best = new Map<number, number>();
    for (let index = 0; index < observations.length; index++) {
      const root = find(index);
      const current = best.get(root);
      if (
        current == null ||
        observations[index].popularity > observations[current].popularity ||
        (observations[index].popularity === observations[current].popularity && observations[index].id.localeCompare(observations[current].id) < 0)
      ) {
        best.set(root, index);
      }
    }
    return [...best.values()];
  };

  // Slot/year compatibility is not transitive: a member with no year is compatible with every year,
  // so checking only one member (or only the representative) lets it bridge two members that are
  // themselves incompatible. These helpers compare a candidate against EVERY member of both
  // clusters, so a year-incompatible pair can never end up in one cluster. Clusters are small and
  // only pairs that already passed the title test reach here.
  const membersByRoot = (): Map<number, number[]> => {
    const map = new Map<number, number[]>();
    for (let index = 0; index < observations.length; index++) {
      const root = find(index);
      const bucket = map.get(root);
      if (bucket) bucket.push(index);
      else map.set(root, [index]);
    }
    return map;
  };
  const compatibleMembers = (
    groups: Map<number, number[]>,
    left: number,
    right: number,
    compatible: (left: Observation, right: Observation) => boolean = slotAndYearCompatible,
  ): boolean => {
    const leftMembers = groups.get(find(left)) ?? [left];
    const rightMembers = groups.get(find(right)) ?? [right];
    return leftMembers.every((leftMember) => rightMembers.every((rightMember) => compatible(observations[leftMember], observations[rightMember])));
  };
  // The members that speak for a cluster's identity: its dominant edition, and anything with a
  // comparable readership. A row far below that (the same fraction the slot pass calls a minor
  // edition) is a translation or a stray reprint riding along, not a claim about which book this is.
  // When nothing in the cluster has any readership the floor is zero and every member qualifies, so
  // popularity-free data keeps the strict all-member behaviour.
  const identityMembers = (groups: Map<number, number[]>, index: number): number[] => {
    const members = groups.get(find(index)) ?? [index];
    const top = members.reduce((best, member) => (observations[member].popularity > observations[best].popularity ? member : best));
    const floor = observations[top].popularity * MINOR_EDITION_RATIO;
    return members.filter((member) => member === top || observations[member].popularity >= floor);
  };
  // Two things decide whether two clusters are the same work, and they answer to different scopes.
  // A SLOT is structural: a member claiming a different index in a series the other side also claims
  // contradicts the merge however minor that edition is, so every pair is checked.
  // A YEAR dates a printing. One work's editions are printed decades apart - a 2019 Turkish
  // translation, a 2025 Russian reprint - so a minor edition's year says nothing about which book the
  // cluster is, and letting one veto a merge is exactly what kept The Lost Metal and The Well of
  // Ascension from ever joining their own Goodreads and Audible rows, costing them their audiobooks
  // and handing the identity to a translation. Years are therefore compared between the identity
  // members only - which still blocks two comparably-read same-titled books printed years apart.
  // The members whose year actually says something about which book the cluster is. A member with no
  // year states nothing, so a cluster whose dominant edition happens to lack one is NOT year-blind:
  // it falls back to whatever member does carry a year, rather than merging with anything. When the
  // identity members do carry years, the minor editions stay silent - that is the reprint exemption.
  const constrainingMembers = (groups: Map<number, number[]>, index: number): number[] => {
    const known = (candidates: number[]): number[] => candidates.filter((member) => observations[member].releaseYear != null);
    const fromIdentity = known(identityMembers(groups, index));
    return fromIdentity.length > 0 ? fromIdentity : known(groups.get(find(index)) ?? [index]);
  };
  const clustersCompatible = (groups: Map<number, number[]>, left: number, right: number): boolean => {
    if (!compatibleMembers(groups, left, right, slotsCompatible)) return false;
    const rightYears = constrainingMembers(groups, right);
    return constrainingMembers(groups, left).every((leftMember) =>
      rightYears.every((rightMember) => yearsCompatible(observations[leftMember], observations[rightMember])),
    );
  };
  const unionMembers = (groups: Map<number, number[]>, left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const merged = [...(groups.get(leftRoot) ?? [leftRoot]), ...(groups.get(rightRoot) ?? [rightRoot])];
    union(left, right);
    groups.delete(leftRoot);
    groups.delete(rightRoot);
    groups.set(find(left), merged);
  };

  const slotReps = currentReps();
  const slotGroups = membersByRoot();
  const bySlot = new Map<string, number[]>();
  for (const index of slotReps) {
    const key = featuredSlotKey(observations[index]);
    if (key) bySlot.set(key, [...(bySlot.get(key) ?? []), index]);
  }
  // WHICH series a provider features is a per-edition display choice, not a fact about the book:
  // Hardcover features "Mistborn: Wax & Wayne #4" on the English The Lost Metal and "The Mistborn
  // Saga #7" on the Italian translation of that same book, so keying only on the featured slot filed
  // the two as separate works. Both editions still LIST the other's slot in their memberships, so a
  // row also joins a slot that some featured row already opened. Only featured rows open a slot, so
  // this unites editions without inventing groups out of broad meta-series ("The Cosmere #16"), whose
  // per-edition numbering disagrees and would otherwise fuse unrelated books.
  for (const index of slotReps) {
    const featured = featuredSlotKey(observations[index]);
    for (const [name, position] of seriesSlots(observations[index])) {
      const key = `${name}#${position}`;
      if (key === featured) continue;
      const group = bySlot.get(key);
      if (group && !group.includes(index)) group.push(index);
    }
  }
  for (const [slotKey, group] of bySlot) {
    // A specific series slot (series name + numeric index) identifies one book, so a translation or
    // minor edition of it should merge into the dominant original. But broad meta-series (for example
    // "The Cosmere #0") put many DIFFERENT books at one slot, so a slot is NOT a reliable book id.
    // Rule: pick the highest-read edition as the anchor, then merge in another edition only when its
    // title is similar OR it is a minor edition (a small fraction of the anchor's readership). Two
    // comparably-read, differently-titled books at one slot stay separate (they are a meta-series,
    // not editions of one work). Box sets never hard-merge; they join only by title similarity.
    const editions = group.filter((index) => !isCompilationObservation(observations[index]));
    const anchor = editions.reduce<number | null>(
      (best, index) => (best == null || observations[index].popularity > observations[best].popularity ? index : best),
      null,
    );
    if (anchor == null) continue;
    const anchorCore = cores[anchor];
    const anchorPopularity = observations[anchor].popularity;
    const majorCores = new Set(
      editions.filter((index) => observations[index].popularity > anchorPopularity * MINOR_EDITION_RATIO).map((index) => cores[index]),
    );
    const metaSlot = majorCores.size >= 2;
    for (const index of group) {
      if (index === anchor) continue;
      // A box set and one of the books inside it are never the same work, however similar the titles
      // read: an omnibus title spells out the titles it collects, so "Mistborn: The Wax & Wayne
      // Series: Alloy of Law, Shadows of Self, ..." scores above the loose slot threshold against
      // "The Alloy of Law" on the collected titles alone. Compilation-ness must match on both sides.
      if (isCompilationObservation(observations[index]) !== isCompilationObservation(observations[anchor])) continue;
      const core = cores[index];
      // A meta-slot holds many different books, so only a strong title signal may merge two of them.
      // Dice alone is not that signal for short cores: the stopword list is English-only, so two
      // Spanish titles sharing "de"/"la" score above a loose threshold on function words alone.
      // Requiring two shared content tokens makes a short-core meta-slot merge carry real evidence.
      const exactCore = !isDegenerateCore(anchorCore) && anchorCore === core;
      const titleSimilar = exactCore || (metaSlot ? metaSlotTitleMatch(anchorCore, core) : titleSimilarity(anchorCore, core) >= 0.25);
      // Reaching this slot only through a SECONDARY membership is weaker than claiming it as your own
      // series: the row is filed elsewhere and merely also appears here, so the slot on its own says
      // little and a small readership must not be read as "minor edition of the anchor". Such a join
      // has to bring real evidence - the same core, a strong title match, or a SECOND series that
      // independently puts both rows at the same index. One shared slot is not enough on its own.
      // (A single conflicting slot cannot veto: broad meta-series are numbered per edition, and
      // Hardcover files one book at The Cosmere #27, #20 and #16 across its own translations.)
      const membershipJoin = featuredSlotKey(observations[index]) !== slotKey || featuredSlotKey(observations[anchor]) !== slotKey;
      if (membershipJoin && !exactCore && !metaSlotTitleMatch(anchorCore, core) && agreeingSlotCount(observations[anchor], observations[index]) < 2) {
        continue;
      }
      // A specific (non-meta) slot is one book, so fold lower-read editions into the anchor. The
      // meta-slot guard above, not a popularity floor, is what stops distinct books from merging, so
      // this also works for indie or synthetic data where the dominant edition has few readers.
      const isMinorEdition =
        !metaSlot && !isCompilationObservation(observations[index]) && observations[index].popularity <= anchorPopularity * MINOR_EDITION_RATIO;
      if (!titleSimilar && !isMinorEdition) continue;
      // Sharing a slot is not on its own permission to merge: a translated edition whose release sits
      // decades from the anchor's stays separate instead of riding the slot past the narrowed exemption.
      if (!compatibleMembers(slotGroups, anchor, index, slotEditionCompatible)) continue;
      unionMembers(slotGroups, anchor, index);
    }
  }

  const coreReps = currentReps();
  const byCore = new Map<string, number[]>();
  for (const index of coreReps) {
    const observation = observations[index];
    const core = cores[index];
    // Such rows stay singletons and are judged on their own (usually flagged foreign_language).
    if (isDegenerateCore(core)) continue;
    // Box sets never merge by title: "3-book collection" cores are generic and would chain unrelated
    // series' box sets (and through them, real books) into one blob.
    if (isCompilationObservation(observation)) continue;
    byCore.set(core, [...(byCore.get(core) ?? []), index]);
  }
  const coreGroups = membersByRoot();
  for (const group of byCore.values()) {
    for (let index = 1; index < group.length; index++) {
      if (clustersCompatible(coreGroups, group[0], group[index])) unionMembers(coreGroups, group[0], group[index]);
    }
  }

  const reps = currentReps();
  const strippedSizes = cores.map((core) => stripStopwords(core).split(' ').filter(Boolean).length);
  const repGroups = membersByRoot();
  for (let left = 0; left < reps.length; left++) {
    for (let right = left + 1; right < reps.length; right++) {
      const coreA = cores[reps[left]];
      const coreB = cores[reps[right]];
      if (isDegenerateCore(coreA) || isDegenerateCore(coreB)) continue;
      // Dice cannot reach 0.9 unless the two token counts are within a ninth of each other, and this
      // pass compares every pair of representatives - the size test skips almost all of them before
      // any set is built.
      const sizeA = strippedSizes[reps[left]];
      const sizeB = strippedSizes[reps[right]];
      if (sizeA > 0 && sizeB > 0 && 2 * Math.min(sizeA, sizeB) < 0.9 * (sizeA + sizeB)) continue;
      if (titleSimilarity(coreA, coreB) < 0.9) continue;
      if (clustersCompatible(repGroups, reps[left], reps[right])) unionMembers(repGroups, reps[left], reps[right]);
    }
  }

  const clusters = new Map<number, Observation[]>();
  for (let index = 0; index < observations.length; index++) {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), observations[index]]);
  }
  return [...clusters.values()].map((members) => ({ observations: members }));
}
