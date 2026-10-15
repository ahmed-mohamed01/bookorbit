import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { authorsMatch } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  webSerialNovelIndex,
  webSerialNovelIndexSources,
  type NewWebSerialNovelIndexSourceRow,
  type WebSerialNovelIndexRow,
  type WebSerialNovelIndexSourceRow,
} from './schema/web-serials.schema';

type Db = NodePgDatabase<typeof schema>;
type Executor = Pick<Db, 'insert'>;

/**
 * What a fill run expects the stored fill state to still be: the next page it read or wrote (a fill) or a finished fill (a
 * top-up). A rebuild or remove changes or deletes the row, so a run that outlived it writes nothing.
 */
export interface NovelIndexSourceGuard {
  nextPage?: number;
  fillState?: WebSerialNovelIndexSourceRow['fillState'];
}

/** One series page on one source, as written to the light novel index. `titleKey` and `mtl` are derived by the caller. */
export interface NovelIndexEntryInput {
  sourceId: string;
  path: string;
  url: string | null;
  title: string;
  titleKey: string;
  mtl: boolean;
  coverUrl: string | null;
  /** Known only from a search hit or an opened page; a catalogue page lists none. */
  author: string | null;
}

export interface NovelIndexDetailsInput extends NovelIndexEntryInput {
  status: WebSerialNovelIndexRow['status'];
  chapterCount: number;
}

export interface NovelIndexUpsertResult {
  added: number;
  updated: number;
}

export type NovelIndexHit = Pick<
  WebSerialNovelIndexRow,
  'sourceId' | 'path' | 'url' | 'title' | 'mtl' | 'coverUrl' | 'matchId' | 'status' | 'chapterCount'
>;

export type NovelIndexCandidateRow = NovelIndexHit & Pick<WebSerialNovelIndexRow, 'author'>;

interface NovelIndexPoolRow extends Record<string, unknown> {
  source_id: string;
  path: string;
  url: string | null;
  title: string;
  title_key: string;
  mtl: boolean;
  cover_url: string | null;
  match_id: string | null;
  status: WebSerialNovelIndexRow['status'];
  chapter_count: number | null;
  prefix: boolean;
}

export type UnmatchedNovelIndexRow = Pick<WebSerialNovelIndexRow, 'sourceId' | 'path' | 'titleKey'> & { author: string };

export interface NovelIndexSuggestionRow {
  matchId: string | null;
  title: string;
  mtlOnly: boolean;
  sourcesCount: number;
  entries: Array<{ sourceId: string; path: string; coverUrl: string | null; mtl: boolean }>;
}

const NOVEL_INDEX_SEARCH_LIMIT = 60;
const UNMATCHED_LOOKUP_LIMIT = 500;
const NOVEL_SUGGEST_POOL = 200;
/** Below this length a trigram has nothing to work with, so short queries match title prefixes only. */
const TRIGRAM_MIN_LENGTH = 3;
/** Up to this many trigram matches in the user's sources are ranked in full; past it the GiST index ranks by distance. */
const TRIGRAM_FILTER_CAP = 1000;

interface SuggestionEntryRow {
  sourceId: string;
  path: string;
  coverUrl: string | null;
  mtl: boolean;
  titleKey: string;
  author: string | null;
}

interface SuggestionGroupRow extends Record<string, unknown> {
  match_id: string | null;
  title: string;
  entries: SuggestionEntryRow[];
}

/**
 * Catalogue matching needs an author, so a copy known only from browsing stays unmatched and would show as its own
 * suggestion next to the matched series of the same title. It joins that series when its author agrees or is unknown,
 * and only when exactly one matched series carries the title.
 */
function foldUnmatchedCopies(groups: readonly SuggestionGroupRow[]): SuggestionGroupRow[] {
  const ranked = groups.map((group, rank) => ({ rank, group: { ...group, entries: [...group.entries] } }));
  const byTitle = new Map<string, Array<(typeof ranked)[number]>>();
  for (const item of ranked) {
    if (item.group.match_id === null) continue;
    for (const key of new Set(item.group.entries.map((entry) => entry.titleKey))) byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
  }
  const knownAuthors = new Map(ranked.map(({ group }) => [group, group.entries.flatMap((entry) => (entry.author ? [entry.author] : []))] as const));
  for (const item of ranked) {
    if (item.group.match_id !== null) continue;
    item.group.entries = item.group.entries.filter((entry) => {
      const targets = (byTitle.get(entry.titleKey) ?? []).filter(({ group }) => {
        const known = knownAuthors.get(group)!;
        return !entry.author || known.length === 0 || authorsMatch([entry.author], known);
      });
      if (targets.length !== 1) return true;
      targets[0]!.group.entries.push(entry);
      targets[0]!.rank = Math.min(targets[0]!.rank, item.rank);
      return false;
    });
  }
  return ranked
    .filter(({ group }) => group.entries.length > 0)
    .sort((left, right) => left.rank - right.rank)
    .map(({ group }) => ({
      ...group,
      entries: group.entries.sort((left, right) => Number(left.mtl) - Number(right.mtl) || Number(!left.coverUrl) - Number(!right.coverUrl)),
    }));
}

function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function dedupeIndexEntries<T extends { sourceId: string; path: string }>(entries: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) byKey.set(`${entry.sourceId}\u0000${entry.path}`, entry);
  return [...byKey.values()];
}

function sourceGuard(sourceId: string, guard: NovelIndexSourceGuard): SQL | undefined {
  const s = webSerialNovelIndexSources;
  return and(
    eq(s.sourceId, sourceId),
    guard.nextPage === undefined ? undefined : eq(s.nextPage, guard.nextPage),
    guard.fillState === undefined ? undefined : eq(s.fillState, guard.fillState),
  );
}

async function upsertEntries(db: Executor, entries: readonly NovelIndexEntryInput[]): Promise<NovelIndexUpsertResult> {
  const rows = dedupeIndexEntries(entries);
  if (rows.length === 0) return { added: 0, updated: 0 };
  const t = webSerialNovelIndex;
  const written = await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.sourceId, t.path],
      set: {
        url: sql`coalesce(excluded.url, ${t.url})`,
        title: sql`excluded.title`,
        titleKey: sql`excluded.title_key`,
        mtl: sql`excluded.mtl`,
        coverUrl: sql`coalesce(excluded.cover_url, ${t.coverUrl})`,
        author: sql`coalesce(excluded.author, ${t.author})`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const added = written.filter((row) => row.inserted).length;
  return { added, updated: written.length - added };
}

@Injectable()
export class WebSerialsNovelIndexRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Adds or refreshes index entries; a cover or link the new answer lacks keeps the stored one. */
  async upsertNovelIndexEntries(entries: readonly NovelIndexEntryInput[]): Promise<NovelIndexUpsertResult> {
    return upsertEntries(this.db, entries);
  }

  /**
   * Writes one fetched catalogue page and the fill progress together, only while the guard still holds. The fill state row
   * is locked first, so a remove or rebuild running at the same time either waits for the page or turns it into a no-op.
   */
  async commitNovelIndexPage(
    sourceId: string,
    guard: NovelIndexSourceGuard,
    entries: readonly NovelIndexEntryInput[],
    patch: (written: NovelIndexUpsertResult) => Partial<Omit<NewWebSerialNovelIndexSourceRow, 'sourceId'>>,
  ): Promise<NovelIndexUpsertResult | null> {
    return this.db.transaction(async (tx) => {
      const s = webSerialNovelIndexSources;
      const [locked] = await tx.select({ sourceId: s.sourceId }).from(s).where(sourceGuard(sourceId, guard)).for('update');
      if (!locked) return null;
      const written = await upsertEntries(tx, entries);
      await tx.update(s).set(patch(written)).where(eq(s.sourceId, sourceId));
      return written;
    });
  }

  /** What opening a novel learned: its status and chapter count, stamped with `details_at`. */
  async recordNovelIndexDetails(entry: NovelIndexDetailsInput): Promise<void> {
    const t = webSerialNovelIndex;
    const now = new Date();
    await this.db
      .insert(t)
      .values({ ...entry, detailsAt: now })
      .onConflictDoUpdate({
        target: [t.sourceId, t.path],
        set: {
          url: sql`coalesce(excluded.url, ${t.url})`,
          title: sql`excluded.title`,
          titleKey: sql`excluded.title_key`,
          mtl: sql`excluded.mtl`,
          coverUrl: sql`coalesce(excluded.cover_url, ${t.coverUrl})`,
          author: sql`coalesce(excluded.author, ${t.author})`,
          status: entry.status,
          chapterCount: entry.chapterCount,
          lastSeenAt: now,
          detailsAt: now,
        },
      });
  }

  async setNovelIndexMatch(sourceId: string, path: string, matchId: string): Promise<void> {
    await this.db
      .update(webSerialNovelIndex)
      .set({ matchId })
      .where(and(eq(webSerialNovelIndex.sourceId, sourceId), eq(webSerialNovelIndex.path, path)));
  }

  /** Unmatched entries with a known author carrying one of the title keys: what lazy matching may claim, bounded. */
  async findUnmatchedNovelIndexByTitleKeys(titleKeys: readonly string[], limit = UNMATCHED_LOOKUP_LIMIT): Promise<UnmatchedNovelIndexRow[]> {
    if (titleKeys.length === 0) return [];
    const t = webSerialNovelIndex;
    const rows = await this.db
      .select({ sourceId: t.sourceId, path: t.path, titleKey: t.titleKey, author: t.author })
      .from(t)
      .where(and(inArray(t.titleKey, [...titleKeys]), sql`${t.matchId} is null`, sql`${t.author} is not null`))
      .orderBy(asc(t.titleKey), asc(t.sourceId), asc(t.path))
      .limit(limit);
    return rows.filter((row): row is UnmatchedNovelIndexRow => row.author !== null);
  }

  /** Gives each still unmatched entry its series id, in one statement; an entry matched meanwhile keeps its id. */
  async setNovelIndexMatches(matches: ReadonlyArray<{ sourceId: string; path: string; matchId: string }>): Promise<number> {
    if (matches.length === 0) return 0;
    const values = sql.join(
      matches.map((match) => sql`(${match.sourceId}, ${match.path}, ${match.matchId})`),
      sql`, `,
    );
    const t = webSerialNovelIndex;
    const result = await this.db.execute(
      sql`update ${t} set "match_id" = v.match_id from (values ${values}) as v(source_id, path, match_id) where ${t.sourceId} = v.source_id and ${t.path} = v.path and ${t.matchId} is null`,
    );
    return result.rowCount ?? 0;
  }

  /**
   * The bounded candidate pool both index searches rank: the first title-prefix matches in index order, plus (for three
   * characters or more) the closest word-similarity matches, one row per entry. Each half is capped so a very common query
   * costs about what a rare one does. Run it through `rankNovelIndexPool`.
   *
   * The similarity half asks the GIN index first, which finds a rare (or absent) title and the matches of a few sources
   * quickly. Only when more than `TRIGRAM_FILTER_CAP` rows match does it take the closest ones from the GiST index in
   * distance order instead, which sorting thousands of matches could not keep up with.
   */
  private novelIndexPool(titleKey: string, sourceIds: readonly string[], size: number): SQL {
    const t = webSerialNovelIndex;
    const prefix = likePrefix(titleKey);
    const ids = sql.join(
      sourceIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const columns = sql`${t.sourceId} as source_id, ${t.path} as path, ${t.url} as url, ${t.title} as title, ${t.titleKey} as title_key, ${t.mtl} as mtl,
      ${t.coverUrl} as cover_url, ${t.matchId} as match_id, ${t.status} as status, ${t.chapterCount} as chapter_count, ${t.author} as author`;
    const prefixed = sql`(select ${columns}, true as prefix from ${t}
      where ${t.sourceId} in (${ids}) and ${t.titleKey} like ${prefix}
      order by ${t.titleKey} using ~<~ limit ${size})`;
    if (titleKey.length < TRIGRAM_MIN_LENGTH) return prefixed;
    // No limit inside the CTE: a limit there lets the planner walk another index row by row hoping to stop early, and
    // the counter below only ever pulls one row past the cap from it anyway.
    const filtered = sql`select ${columns} from ${t} where ${t.sourceId} in (${ids}) and ${titleKey} <% lower(${t.titleKey})`;
    const matches = sql`(select count(*) from (select 1 from filtered limit ${TRIGRAM_FILTER_CAP + 1}) capped)`;
    const fromFilter = sql`(select *, title_key like ${prefix} as prefix from filtered
      where ${matches} <= ${TRIGRAM_FILTER_CAP}
      order by word_similarity(${titleKey}, title_key) desc limit ${size})`;
    const byDistance = sql`(select ${columns}, ${t.titleKey} like ${prefix} as prefix from ${t}
      where ${matches} > ${TRIGRAM_FILTER_CAP} and ${t.sourceId} in (${ids}) and ${titleKey} <% ${t.titleKey}
      order by ${titleKey} <<-> ${t.titleKey} limit ${size})`;
    return sql`(with filtered as materialized (${filtered})
      select distinct on (source_id, path) * from (${prefixed} union all ${fromFilter} union all ${byDistance}) halves
      order by source_id, path, prefix desc)`;
  }

  /**
   * Under a small limit the planner guesses a sequential scan finds enough trigram matches soon, and pays a word
   * similarity per row for a rare (typo) query; with sequential scans off it uses the trigram and prefix indexes.
   */
  private rankNovelIndexPool<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return (await tx.execute<T>(query)).rows as T[];
    });
  }

  /** The statement `searchNovelIndex` runs; public so the scale check can read its plan. */
  novelIndexSearchQuery(titleKey: string, sourceIds: readonly string[], limit = NOVEL_INDEX_SEARCH_LIMIT): SQL {
    return sql`select * from (${this.novelIndexPool(titleKey, sourceIds, NOVEL_SUGGEST_POOL)}) pool
      order by (case when prefix then 1 else 0 end) + word_similarity(${titleKey}, title_key) - (case when mtl then 0.5 else 0 end) desc, length(title_key), title_key
      limit ${Math.min(Math.max(1, limit), NOVEL_INDEX_SEARCH_LIMIT)}`;
  }

  /** Index search for one query key within the given sources: title prefixes first, then word similarity, machine translations below. */
  async searchNovelIndex(titleKey: string, sourceIds: readonly string[], limit = NOVEL_INDEX_SEARCH_LIMIT): Promise<NovelIndexHit[]> {
    if (sourceIds.length === 0 || titleKey.length === 0) return [];
    const rows = await this.rankNovelIndexPool<NovelIndexPoolRow>(this.novelIndexSearchQuery(titleKey, sourceIds, limit));
    return rows.map((row) => ({
      sourceId: row.source_id,
      path: row.path,
      url: row.url,
      title: row.title,
      mtl: row.mtl,
      coverUrl: row.cover_url,
      matchId: row.match_id,
      status: row.status,
      chapterCount: row.chapter_count,
    }));
  }

  /**
   * Autocomplete: the bounded candidate pool grouped into series by match id, else by title key. Groups with a prefix
   * match come first, then groups with a non-machine-translated copy, then similarity. Every group of the pool is folded,
   * since folding can merge any number of them into one.
   */
  async suggestNovelIndex(titleKey: string, sourceIds: readonly string[], limit: number): Promise<NovelIndexSuggestionRow[]> {
    if (sourceIds.length === 0 || titleKey.length === 0) return [];
    const rows = await this.rankNovelIndexPool<SuggestionGroupRow>(sql`with hits as (
  select source_id, path, title, title_key, author, mtl, cover_url, match_id, prefix,
    word_similarity(${titleKey}, title_key) as score,
    coalesce('m:' || match_id, 't:' || title_key) as group_key
  from (${this.novelIndexPool(titleKey, sourceIds, NOVEL_SUGGEST_POOL)}) pool
)
select max(match_id) as match_id,
  (array_agg(title order by mtl, prefix desc, score desc, length(title)))[1] as title,
  json_agg(json_build_object('sourceId', source_id, 'path', path, 'coverUrl', cover_url, 'mtl', mtl, 'titleKey', title_key, 'author', author)
    order by mtl, (cover_url is null), score desc) as entries
from hits
group by group_key
order by bool_or(prefix) desc, bool_and(mtl), max(score) desc, min(length(title)), group_key`);
    return foldUnmatchedCopies(rows)
      .slice(0, limit)
      .map((row) => ({
        matchId: row.match_id,
        title: row.title,
        mtlOnly: row.entries.every((entry) => entry.mtl),
        sourcesCount: new Set(row.entries.map((entry) => entry.sourceId)).size,
        entries: row.entries.map(({ sourceId, path, coverUrl, mtl }) => ({ sourceId, path, coverUrl, mtl })),
      }));
  }

  /** Index entries for one MangaBaka series: matched to it, or (still unmatched) carrying one of its titles. */
  async findNovelIndexCandidates(
    matchId: string,
    titleKeys: readonly string[],
    sourceIds: readonly string[],
    limit = NOVEL_INDEX_SEARCH_LIMIT,
  ): Promise<NovelIndexCandidateRow[]> {
    if (sourceIds.length === 0) return [];
    const t = webSerialNovelIndex;
    const byTitle = titleKeys.length > 0 ? and(sql`${t.matchId} is null`, inArray(t.titleKey, [...titleKeys])) : undefined;
    return this.db
      .select({
        sourceId: t.sourceId,
        path: t.path,
        url: t.url,
        title: t.title,
        mtl: t.mtl,
        coverUrl: t.coverUrl,
        matchId: t.matchId,
        status: t.status,
        chapterCount: t.chapterCount,
        author: t.author,
      })
      .from(t)
      .where(and(inArray(t.sourceId, [...sourceIds]), byTitle ? or(eq(t.matchId, matchId), byTitle) : eq(t.matchId, matchId)))
      .orderBy(asc(t.mtl), sql`${t.chapterCount} desc nulls last`, asc(t.sourceId))
      .limit(limit);
  }

  /** Index entries carrying any of the given title keys, matched to a series or not. */
  async findNovelIndexByTitleKeys(
    titleKeys: readonly string[],
    sourceIds: readonly string[],
    limit = NOVEL_INDEX_SEARCH_LIMIT,
  ): Promise<NovelIndexHit[]> {
    if (sourceIds.length === 0 || titleKeys.length === 0) return [];
    const t = webSerialNovelIndex;
    return this.db
      .select({
        sourceId: t.sourceId,
        path: t.path,
        url: t.url,
        title: t.title,
        mtl: t.mtl,
        coverUrl: t.coverUrl,
        matchId: t.matchId,
        status: t.status,
        chapterCount: t.chapterCount,
      })
      .from(t)
      .where(and(inArray(t.sourceId, [...sourceIds]), inArray(t.titleKey, [...titleKeys])))
      .orderBy(asc(t.mtl), sql`${t.chapterCount} desc nulls last`, asc(t.sourceId))
      .limit(limit);
  }

  /** Paths of the given ones the index already holds for the source; the top-up stops at a page of only known entries. */
  async findKnownNovelIndexPaths(sourceId: string, paths: readonly string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const rows = await this.db
      .select({ path: webSerialNovelIndex.path })
      .from(webSerialNovelIndex)
      .where(and(eq(webSerialNovelIndex.sourceId, sourceId), inArray(webSerialNovelIndex.path, [...paths])));
    return new Set(rows.map((row) => row.path));
  }

  async countNovelIndexEntries(sourceId: string): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(webSerialNovelIndex).where(eq(webSerialNovelIndex.sourceId, sourceId));
    return row?.value ?? 0;
  }

  async listNovelIndexSources(): Promise<WebSerialNovelIndexSourceRow[]> {
    return this.db.select().from(webSerialNovelIndexSources).orderBy(asc(webSerialNovelIndexSources.sourceId));
  }

  /** Creates the fill state of sources the index has not seen yet; existing ones are left alone. */
  async ensureNovelIndexSources(sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.db
      .insert(webSerialNovelIndexSources)
      .values(sourceIds.map((sourceId) => ({ sourceId })))
      .onConflictDoNothing();
  }

  /** Updates existing fill state only, so a run that outlived a remove cannot bring the source back. False when nothing matched. */
  async saveNovelIndexSource(
    sourceId: string,
    patch: Partial<Omit<NewWebSerialNovelIndexSourceRow, 'sourceId'>>,
    guard: NovelIndexSourceGuard = {},
  ): Promise<boolean> {
    const updated = await this.db
      .update(webSerialNovelIndexSources)
      .set(patch)
      .where(sourceGuard(sourceId, guard))
      .returning({ sourceId: webSerialNovelIndexSources.sourceId });
    return updated.length > 0;
  }

  /** Forgets sources entirely. The fill state goes first: it waits for a page being written, whose entries the second delete then sees. */
  async deleteNovelIndexSources(sourceIds: readonly string[]): Promise<number> {
    if (sourceIds.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      await tx.delete(webSerialNovelIndexSources).where(inArray(webSerialNovelIndexSources.sourceId, [...sourceIds]));
      const removed = await tx
        .delete(webSerialNovelIndex)
        .where(inArray(webSerialNovelIndex.sourceId, [...sourceIds]))
        .returning({ id: webSerialNovelIndex.id });
      return removed.length;
    });
  }

  /** Starts a source's fill over from the first page and drops its entries, fill state first for the same reason as a remove. */
  async resetNovelIndexSource(sourceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const reset = {
        fillState: 'pending' as const,
        nextPage: 1,
        fillSort: null,
        filledAt: null,
        lastTopupAt: null,
        entries: 0,
        emptyPage: null,
        firstPageFailures: 0,
        recheckAt: null,
        lastError: null,
      };
      await tx
        .insert(webSerialNovelIndexSources)
        .values({ sourceId, ...reset })
        .onConflictDoUpdate({ target: webSerialNovelIndexSources.sourceId, set: reset });
      await tx.delete(webSerialNovelIndex).where(eq(webSerialNovelIndex.sourceId, sourceId));
    });
  }

  async findNovelIndexCover(sourceId: string, path: string): Promise<string | null> {
    const [row] = await this.db
      .select({ coverUrl: webSerialNovelIndex.coverUrl })
      .from(webSerialNovelIndex)
      .where(and(eq(webSerialNovelIndex.sourceId, sourceId), eq(webSerialNovelIndex.path, path)))
      .limit(1);
    return row?.coverUrl ?? null;
  }
}
