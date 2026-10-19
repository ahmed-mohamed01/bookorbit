import type { MonitoredClassSelection, MonitoredWork } from "../monitored";

function work(overrides: Partial<MonitoredWork>): MonitoredWork {
  const base: MonitoredWork = {
    id: "work-1",
    title: "A Book",
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: "verified",
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: "monitoring",
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
  };
  return { ...base, ...overrides };
}

const book: MonitoredClassSelection = { kinds: ["book"], more: [] };
const hidden: MonitoredClassSelection = { kinds: [], more: ["hidden"] };
const placeholders: MonitoredClassSelection = { kinds: [], more: ["placeholders"] };
const unconfirmed: MonitoredClassSelection = { kinds: [], more: ["unconfirmed"] };
const collection: MonitoredClassSelection = { kinds: ["collection"], more: [] };
const empty: MonitoredClassSelection = { kinds: [], more: [] };

export const classSelectionFixtures: Array<{
  name: string;
  work: MonitoredWork;
  matches: MonitoredClassSelection[];
  misses: MonitoredClassSelection[];
}> = [
  { name: "verified book", work: work({}), matches: [book], misses: [empty, unconfirmed, collection] },
  { name: "verified detected collection", work: work({ kind: "collection" }), matches: [book], misses: [collection, unconfirmed] },
  { name: "probable unknown", work: work({ verdict: "probable" }), matches: [unconfirmed], misses: [book, empty] },
  { name: "suspect collection", work: work({ verdict: "suspect", kind: "collection" }), matches: [collection, unconfirmed], misses: [book, empty] },
  {
    name: "verified flagged collection",
    work: work({ flags: ["wrong_contributor"], kind: "collection" }),
    matches: [collection, unconfirmed],
    misses: [book, placeholders],
  },
  {
    name: "automatic placeholder",
    work: work({ flags: ["placeholder"], kind: "collection" }),
    matches: [placeholders],
    misses: [book, collection, unconfirmed],
  },
  {
    name: "hidden marked placeholder",
    work: work({ userVisibility: "hidden", userKind: "book", flags: ["placeholder"] }),
    matches: [hidden],
    misses: [book, placeholders, unconfirmed],
  },
  {
    name: "kept placeholder",
    work: work({ userVisibility: "visible", flags: ["placeholder"] }),
    matches: [book],
    misses: [placeholders, unconfirmed],
  },
  { name: "book marked placeholder", work: work({ userKind: "book", flags: ["placeholder"] }), matches: [book], misses: [placeholders, unconfirmed] },
  {
    name: "owner collection overrides kept",
    work: work({ userVisibility: "visible", userKind: "collection", kind: "anthology" }),
    matches: [collection],
    misses: [book, unconfirmed],
  },
  { name: "hidden flagged", work: work({ userVisibility: "hidden", flags: ["wrong_contributor"] }), matches: [hidden], misses: [book, unconfirmed] },
  {
    name: "owned suspect collection",
    work: work({ ownedFormats: ["ebook"], verdict: "suspect", flags: ["wrong_contributor"], kind: "collection" }),
    matches: [collection, unconfirmed],
    misses: [book, empty],
  },
];
