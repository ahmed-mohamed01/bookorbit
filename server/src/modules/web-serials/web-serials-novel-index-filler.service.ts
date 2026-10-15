import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';

import type { WebSerialNovelIndexSource, WebSerialNovelIndexStatus } from '@bookorbit/types';
import { SystemCron } from '../../common/decorators/system-cron.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { NovelSourcesClient, type NovelBrowseOptions, type NovelSourceEntry } from './engines/novel-sources.client';
import type { WebSerialNovelIndexSourceRow } from './schema/web-serials.schema';
import { describeError } from './web-serials-log.utils';
import { novelIndexEntry, WebSerialsNovelIndexService, type NovelIndexScope } from './web-serials-novel-index.service';
import { WebSerialsSchemaBootstrapService } from './web-serials-schema-bootstrap.service';
import { WebSerialsNovelIndexRepository, type NovelIndexEntryInput, type NovelIndexSourceGuard } from './web-serials-novel-index.repository';
import { WebSerialsRepository } from './web-serials.repository';
import { WebSerialErrorCode } from '@bookorbit/types';
import { codedError } from './web-serials-error.utils';

const FILL_EVENT = 'web_serials.novel_index_fill';
const ADMIN_EVENT = 'web_serials.novel_index_admin';
export const NOVEL_INDEX_PAGE_DELAY_MS = 3_000;
export const NOVEL_INDEX_PAGE_CAP = 2_000;
export const NOVEL_INDEX_TOPUP_PAGES = 10;
export const NOVEL_INDEX_TOPUP_INTERVAL_MS = 3 * 60 * 60_000;
/** A site answering a challenge or error page usually still does a few minutes later, so a recheck waits a top-up interval. */
export const NOVEL_INDEX_RECHECK_DELAY_MS = NOVEL_INDEX_TOPUP_INTERVAL_MS;
const BROWSE_TIMEOUT_MS = 45_000;
const ERROR_MAX_LENGTH = 300;
/** Failed first pages of the preferred sort, on separate runs, before the fill settles for a fallback sort for good. */
const FIRST_PAGE_RETRIES = 1;

type RunMode = 'fill' | 'topup';

interface RunOutcome {
  sort: string;
  pages: number;
  added: number;
  updated: number;
  state: WebSerialNovelIndexSourceRow['fillState'];
  stopped:
    'end' | 'unconfirmed_end' | 'retry_later' | 'no_sort' | 'known' | 'budget' | 'page_cap' | 'topup_cap' | 'disabled' | 'aborted' | 'superseded';
}

interface FilterOption {
  label?: unknown;
  value?: unknown;
}

const LATEST_OPTION = /latest|update|recent|new/i;
const FILL_OPTION = /alpha|a\s*-\s*z|name|title/i;
const POPULAR_OPTION = /popular|view|hot|trend|rank/i;
const SORT_FILTER = /sort|order/i;
const DEFAULT_OPTION = /default/i;
const GENERIC_LATEST = 'latest';
const GENERIC_DEFAULT = 'default';
const NO_SORT_WORKED = 'No sort order worked for this source';

export interface BrowseCandidate {
  /** Stable identifier persisted as the chosen fill sort. */
  sort: string;
  options: NovelBrowseOptions;
}

/**
 * The browse options to try for a source, best first. The fill prefers A-Z, then the source default, then popular and
 * latest orders; top-ups prefer the source's own latest/updated orders, then the generic latest switch. A source's
 * sort can be broken or empty, so the runner falls through the list on page 1.
 */
export function browseCandidatesFor(filters: unknown, mode: RunMode): BrowseCandidate[] {
  const definitions = filters && typeof filters === 'object' && !Array.isArray(filters) ? (filters as Record<string, unknown>) : {};
  const candidates: BrowseCandidate[] = [];
  const add = (candidate: BrowseCandidate) => {
    if (!candidates.some((existing) => existing.sort === candidate.sort)) candidates.push(candidate);
  };
  for (const [key, raw] of Object.entries(definitions)) {
    if (!raw || typeof raw !== 'object') continue;
    const definition = raw as { label?: unknown; options?: unknown; value?: unknown };
    if (!Array.isArray(definition.options) || !SORT_FILTER.test(`${key} ${typeof definition.label === 'string' ? definition.label : ''}`)) continue;
    const options = definition.options as FilterOption[];
    const describe = (option: FilterOption) => `${textOf(option.value)} ${textOf(option.label)}`;
    const matching = (pattern: RegExp) => options.filter((option) => pattern.test(describe(option)));
    const withValue = (option: FilterOption): BrowseCandidate => ({
      sort: `${key}=${textOf(option.value)}`,
      options: { latest: false, filters: { ...definitions, [key]: { ...definition, value: option.value } } },
    });
    const sourceDefault = (): BrowseCandidate => {
      const empty = options.find((option) => textOf(option.value) === '' || DEFAULT_OPTION.test(textOf(option.label)));
      return empty ? withValue(empty) : { sort: `${key}=${textOf(definition.value)}`, options: { latest: false, filters: definitions } };
    };
    if (mode === 'topup') {
      matching(LATEST_OPTION).forEach((option) => add(withValue(option)));
      if (candidates.length === 0) continue;
      break;
    }
    matching(FILL_OPTION).forEach((option) => add(withValue(option)));
    add(sourceDefault());
    matching(POPULAR_OPTION).forEach((option) => add(withValue(option)));
    matching(LATEST_OPTION).forEach((option) => add(withValue(option)));
    return candidates;
  }
  if (mode === 'topup') add({ sort: GENERIC_LATEST, options: { latest: true } });
  else add({ sort: GENERIC_DEFAULT, options: { latest: false } });
  return candidates;
}

interface RunPlan {
  fromPage: number;
  candidates: BrowseCandidate[];
}

function planRun(source: NovelSourceEntry, row: WebSerialNovelIndexSourceRow, mode: RunMode): RunPlan {
  const candidates = browseCandidatesFor(source.filters, mode);
  if (mode === 'topup') return { fromPage: 1, candidates };
  const resumeFrom = Math.max(1, row.nextPage);
  if (resumeFrom === 1) return { fromPage: 1, candidates };
  // Progress saved before the sort was recorded came from the first candidate, which is what the old picker chose.
  const stored = row.fillSort ? candidates.find((candidate) => candidate.sort === row.fillSort) : candidates[0];
  return stored ? { fromPage: resumeFrom, candidates: [stored] } : { fromPage: 1, candidates };
}

function textOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Fills the light novel index by paging each enabled source's catalogue: one source at a time, one page every few
 * seconds, a daily request budget per source, resumable from the stored next page. Filled sources get top-ups from
 * their latest listing until a page holds only known entries.
 */
@Injectable()
export class WebSerialsNovelIndexFillerService implements OnModuleDestroy {
  private readonly logger = new Logger(WebSerialsNovelIndexFillerService.name);
  private running: Promise<void> | null = null;
  private current: string | null = null;
  private readonly requested = new Set<string>();
  private readonly controller = new AbortController();

  constructor(
    private readonly repo: WebSerialsRepository,
    private readonly indexRepo: WebSerialsNovelIndexRepository,
    private readonly index: WebSerialsNovelIndexService,
    private readonly client: NovelSourcesClient,
    private readonly bootstrap: WebSerialsSchemaBootstrapService,
  ) {}

  onModuleDestroy(): void {
    this.controller.abort();
  }

  /** Overridden in tests: the pause between two pages of one source. */
  protected sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  protected now(): Date {
    return new Date();
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  @SystemCron('*/5 * * * *')
  async tick(): Promise<void> {
    if (!this.running) {
      this.running = this.runDue().finally(() => {
        this.running = null;
        this.current = null;
      });
    }
    await this.running;
  }

  async status(): Promise<WebSerialNovelIndexStatus> {
    const scope = await this.index.scope();
    const budget = await this.dailyBudget();
    const rows = await this.indexRepo.listNovelIndexSources();
    const installed = scope ? await this.index.installedSources(scope.connection) : [];
    const byId = new Map(rows.map((row) => [row.sourceId, row]));
    const day = today(this.now());
    const ids = installed.length > 0 ? installed.map((source) => source.id) : rows.map((row) => row.sourceId);
    const names = new Map(installed.map((source) => [source.id, source.name]));
    const sources = ids.map((sourceId): WebSerialNovelIndexSource => {
      const row = byId.get(sourceId);
      return {
        sourceId,
        name: names.get(sourceId) ?? sourceId,
        enabled: scope?.enabledSourceIds.includes(sourceId) ?? false,
        fillState: row?.fillState ?? 'pending',
        nextPage: row?.nextPage ?? 1,
        entries: row?.entries ?? 0,
        filledAt: row?.filledAt?.toISOString() ?? null,
        lastTopupAt: row?.lastTopupAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        requestsToday: row && row.requestsDay === day ? row.requestsToday : 0,
        running: this.current === sourceId,
      };
    });
    return { dailyBudget: budget, sources, unavailable: scope !== null && installed.length === 0 && rows.length > 0 };
  }

  /** Runs the source next (a fill, or a top-up when it is already filled) without waiting for the schedule. */
  async fillNow(sourceId: string, user: RequestUser): Promise<WebSerialNovelIndexStatus> {
    const startedAt = Date.now();
    await this.requireInstalled(sourceId);
    this.logger.log(
      `[${ADMIN_EVENT}] [end] source=${sourceId} userId=${user.id} action=fill durationMs=${Date.now() - startedAt} - novel index fill requested`,
    );
    this.requested.add(sourceId);
    this.kick();
    return this.status();
  }

  /** Forgets everything the index holds for the source and fills it again from the first page. */
  async rebuild(sourceId: string, user: RequestUser): Promise<WebSerialNovelIndexStatus> {
    const startedAt = Date.now();
    await this.requireInstalled(sourceId);
    if (this.current === sourceId)
      throw new BadRequestException(
        codedError('This source is being indexed right now. Try again when it finishes.', WebSerialErrorCode.NovelIndexBusy),
      );
    await this.indexRepo.resetNovelIndexSource(sourceId);
    this.logger.log(
      `[${ADMIN_EVENT}] [end] source=${sourceId} userId=${user.id} action=rebuild durationMs=${Date.now() - startedAt} - novel index rebuild requested`,
    );
    this.requested.add(sourceId);
    this.kick();
    return this.status();
  }

  private kick(): void {
    if (this.running) return;
    void this.tick().catch(() => undefined);
  }

  private async requireInstalled(sourceId: string): Promise<NovelIndexScope> {
    const scope = await this.index.scope();
    if (!scope) throw new BadRequestException(codedError('LNReader sources are not configured', WebSerialErrorCode.EngineNotConfigured));
    const installed = await this.client.listInstalled(scope.connection);
    if (!installed.some((source) => source.id === sourceId))
      throw new NotFoundException(codedError('That novel source is not installed', WebSerialErrorCode.NovelSourceNotInstalled));
    return scope;
  }

  private async dailyBudget(): Promise<number> {
    return (await this.repo.getSettings())?.novelIndexDailyBudget ?? 1500;
  }

  private async runDue(): Promise<void> {
    await this.bootstrap.ready;
    const signal = this.controller.signal;
    // A source runs at most once per pass unless an admin asks again, so a failing source cannot spin.
    const attempted = new Set<string>();
    for (;;) {
      if (signal.aborted) return;
      const scope = await this.index.scope();
      if (!scope) return;
      let installed: NovelSourceEntry[];
      const listedAt = Date.now();
      try {
        installed = await this.client.listInstalled(scope.connection);
      } catch (error) {
        const { errorClass, message } = describeError(error);
        this.logger.warn(
          `[${FILL_EVENT}] [fail] step=sources durationMs=${Date.now() - listedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - could not list sources`,
        );
        return;
      }
      await this.syncSources(installed);
      const next = await this.nextDue(scope, installed, attempted);
      if (!next) return;
      attempted.add(next.source.id);
      this.requested.delete(next.source.id);
      this.current = next.source.id;
      await this.runSource(scope, next.source, next.row, next.mode, signal);
      this.current = null;
    }
  }

  /**
   * Adds fill state for newly installed sources. A source missing from the list keeps its entries: the service may have
   * lost its data or point elsewhere for a while, and re-crawling costs days. Only an admin removing the source deletes them.
   */
  private async syncSources(installed: NovelSourceEntry[]): Promise<void> {
    const known = new Set((await this.indexRepo.listNovelIndexSources()).map((row) => row.sourceId));
    await this.indexRepo.ensureNovelIndexSources(installed.map((source) => source.id).filter((id) => !known.has(id)));
  }

  private async nextDue(
    scope: NovelIndexScope,
    installed: NovelSourceEntry[],
    attempted: ReadonlySet<string>,
  ): Promise<{ source: NovelSourceEntry; row: WebSerialNovelIndexSourceRow; mode: RunMode } | null> {
    const rows = new Map((await this.indexRepo.listNovelIndexSources()).map((row) => [row.sourceId, row]));
    const budget = await this.dailyBudget();
    const now = this.now();
    const day = today(now);
    const enabled = installed.filter(
      (source) => scope.enabledSourceIds.includes(source.id) && rows.has(source.id) && (!attempted.has(source.id) || this.requested.has(source.id)),
    );
    const ordered = [...enabled.filter((source) => this.requested.has(source.id)), ...enabled.filter((source) => !this.requested.has(source.id))];
    for (const source of ordered) {
      const row = rows.get(source.id)!;
      const used = row.requestsDay === day ? row.requestsToday : 0;
      if (used >= budget) continue;
      if (row.fillState !== 'done') {
        if (row.recheckAt && row.recheckAt > now && !this.requested.has(source.id)) continue;
        return { source, row, mode: 'fill' };
      }
      const topupDue = !row.lastTopupAt || now.getTime() - row.lastTopupAt.getTime() >= NOVEL_INDEX_TOPUP_INTERVAL_MS;
      if (topupDue || this.requested.has(source.id)) return { source, row, mode: 'topup' };
    }
    return null;
  }

  private async runSource(
    scope: NovelIndexScope,
    source: NovelSourceEntry,
    row: WebSerialNovelIndexSourceRow,
    mode: RunMode,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    const plan = planRun(source, row, mode);
    this.logger.log(
      `[${FILL_EVENT}] [start] source=${source.id} mode=${mode} fromPage=${plan.fromPage} sort=${plan.candidates.length === 1 ? plan.candidates[0].sort : 'auto'} - novel index run started`,
    );
    const cursor: RunCursor = { mode, expectedNext: row.nextPage };
    try {
      const outcome = await this.page(scope, source, row, cursor, plan, signal);
      this.logger.log(
        `[${FILL_EVENT}] [end] source=${source.id} mode=${mode} sort=${outcome.sort} pages=${outcome.pages} added=${outcome.added} updated=${outcome.updated} durationMs=${Date.now() - startedAt} state=${outcome.state} stopped=${outcome.stopped} - novel index run completed`,
      );
      if (outcome.stopped === 'page_cap') {
        this.logger.warn(
          `[${FILL_EVENT}] [end] source=${source.id} durationMs=${Date.now() - startedAt} pageCap=${NOVEL_INDEX_PAGE_CAP} - novel index stopped at the page cap`,
        );
      }
    } catch (error) {
      const { errorClass, message } = describeError(error);
      await this.indexRepo
        .saveNovelIndexSource(source.id, { lastError: message.slice(0, ERROR_MAX_LENGTH) }, runGuard(cursor))
        .catch(() => undefined);
      this.logger.warn(
        `[${FILL_EVENT}] [fail] source=${source.id} mode=${mode} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - novel index run failed`,
      );
    }
  }

  private recheckAt(): Date {
    return new Date(this.now().getTime() + NOVEL_INDEX_RECHECK_DELAY_MS);
  }

  private dropCandidate(
    source: NovelSourceEntry,
    mode: RunMode,
    candidate: BrowseCandidate,
    pending: BrowseCandidate[],
    reason: string,
    browsedAt: number,
  ) {
    this.logger.warn(
      `[${FILL_EVENT}] [end] source=${source.id} mode=${mode} sort="${sanitizeLogValue(candidate.sort)}" durationMs=${Date.now() - browsedAt} outcome=sort_dropped reason="${sanitizeLogValue(reason)}" - sort order failed on page 1, trying the next`,
    );
    return pending.slice(1);
  }

  private async noSortWorked(
    source: NovelSourceEntry,
    mode: RunMode,
    outcome: RunOutcome,
    lastFailure: string | null,
    guard: NovelIndexSourceGuard,
  ): Promise<RunOutcome> {
    const lastError = (lastFailure ? `${NO_SORT_WORKED} (${lastFailure})` : NO_SORT_WORKED).slice(0, ERROR_MAX_LENGTH);
    const saved = await this.indexRepo.saveNovelIndexSource(
      source.id,
      mode === 'fill'
        ? { fillState: 'pending', nextPage: 1, fillSort: null, firstPageFailures: 0, recheckAt: this.recheckAt(), lastError }
        : { lastTopupAt: this.now(), lastError },
      guard,
    );
    if (!saved) return superseded(outcome);
    return { ...outcome, state: mode === 'fill' ? 'pending' : 'done', stopped: 'no_sort' };
  }

  private async page(
    scope: NovelIndexScope,
    source: NovelSourceEntry,
    row: WebSerialNovelIndexSourceRow,
    cursor: RunCursor,
    plan: RunPlan,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const { mode } = cursor;
    const { fromPage } = plan;
    let pending = [...plan.candidates];
    let chosen: BrowseCandidate | null = plan.candidates.length === 1 && fromPage > 1 ? plan.candidates[0] : null;
    let lastFailure: string | null = null;
    let attempts = 0;
    const budget = await this.dailyBudget();
    let day = today(this.now());
    let used = row.requestsDay === day ? row.requestsToday : 0;
    let entries = row.entries;
    // Every write is guarded by the state this run last saw, so a remove or rebuild during a browse ends the run untouched.
    const guard = (): NovelIndexSourceGuard => runGuard(cursor);
    const save = (patch: Parameters<WebSerialsNovelIndexRepository['saveNovelIndexSource']>[1]) =>
      this.indexRepo.saveNovelIndexSource(source.id, patch, guard());
    const outcome: RunOutcome = {
      sort: chosen?.sort ?? 'auto',
      pages: 0,
      added: 0,
      updated: 0,
      state: mode === 'fill' ? 'filling' : 'done',
      stopped: 'end',
    };
    const lastPage = mode === 'fill' ? NOVEL_INDEX_PAGE_CAP : NOVEL_INDEX_TOPUP_PAGES;

    for (let page = fromPage; ; page += 1) {
      if (signal.aborted) return { ...outcome, stopped: 'aborted' };
      if (page > lastPage) {
        if (mode === 'fill') {
          if (!(await save({ fillState: 'done', filledAt: this.now(), lastError: 'Stopped at the page cap' }))) return superseded(outcome);
          return { ...outcome, state: 'done', stopped: 'page_cap' };
        }
        if (!(await save({ lastTopupAt: this.now() }))) return superseded(outcome);
        return { ...outcome, stopped: 'topup_cap' };
      }
      if ((await this.index.scope())?.enabledSourceIds.includes(source.id) !== true) return { ...outcome, stopped: 'disabled' };
      if (today(this.now()) !== day) {
        day = today(this.now());
        used = 0;
      }
      if (used >= budget) {
        if (mode === 'fill' && !(await save({ fillState: 'paused' }))) return superseded(outcome);
        return { ...outcome, state: mode === 'fill' ? 'paused' : 'done', stopped: 'budget' };
      }
      if (attempts > 0) await this.sleep(NOVEL_INDEX_PAGE_DELAY_MS, signal);
      if (signal.aborted) return { ...outcome, stopped: 'aborted' };

      used += 1;
      attempts += 1;
      if (!(await save({ requestsToday: used, requestsDay: day }))) return superseded(outcome);
      const candidate = chosen ?? pending[0];
      const browsedAt = Date.now();
      let result: Awaited<ReturnType<NovelSourcesClient['browse']>>;
      try {
        result = await this.client.browse(
          scope.connection,
          source.id,
          page,
          candidate.options,
          AbortSignal.any([signal, AbortSignal.timeout(BROWSE_TIMEOUT_MS)]),
        );
      } catch (error) {
        if (chosen || signal.aborted) throw error;
        lastFailure = describeError(error).message;
        // The sort a fill settles on is kept until it finishes, so one timeout must not cost the preferred order.
        if (mode === 'fill' && candidate === plan.candidates[0] && row.firstPageFailures < FIRST_PAGE_RETRIES) {
          const saved = await save({
            firstPageFailures: row.firstPageFailures + 1,
            lastError: lastFailure.slice(0, ERROR_MAX_LENGTH),
            recheckAt: this.recheckAt(),
          });
          if (!saved) return superseded(outcome);
          return { ...outcome, state: row.fillState, stopped: 'retry_later' };
        }
        pending = this.dropCandidate(source, mode, candidate, pending, lastFailure, browsedAt);
        if (pending.length === 0) return this.noSortWorked(source, mode, outcome, lastFailure, guard());
        page -= 1;
        continue;
      }
      outcome.pages += 1;
      const items = result.items.flatMap((item): NovelIndexEntryInput[] => {
        const entry = novelIndexEntry(source.id, item.path ?? '', item.name ?? '', item.url ?? null, item.cover ?? null);
        return entry ? [entry] : [];
      });
      if (items.length === 0 && !chosen) {
        pending = this.dropCandidate(source, mode, candidate, pending, 'no items on page 1', browsedAt);
        if (pending.length === 0) return this.noSortWorked(source, mode, outcome, lastFailure, guard());
        page -= 1;
        continue;
      }
      if (items.length === 0) {
        if (mode === 'fill' && row.emptyPage !== page) {
          // Sites answer a challenge or error page with an empty list too; only a repeat on a later run ends the fill.
          const saved = await save({ fillState: 'filling', nextPage: page, emptyPage: page, entries, recheckAt: this.recheckAt() });
          if (!saved) return superseded(outcome);
          return { ...outcome, state: 'filling', stopped: 'unconfirmed_end' };
        }
        if (mode === 'fill') {
          const total = await this.indexRepo.countNovelIndexEntries(source.id);
          const saved = await save({
            fillState: 'done',
            filledAt: this.now(),
            lastTopupAt: this.now(),
            entries: total,
            emptyPage: null,
            recheckAt: null,
            lastError: null,
          });
          if (!saved) return superseded(outcome);
          return { ...outcome, state: 'done', stopped: 'end' };
        }
        if (!(await save({ lastTopupAt: this.now(), lastError: null }))) return superseded(outcome);
        return { ...outcome, stopped: 'end' };
      }
      if (!chosen) {
        chosen = candidate;
        outcome.sort = candidate.sort;
      }
      const fillSort = chosen.sort;
      const written = await this.indexRepo.commitNovelIndexPage(source.id, guard(), items, ({ added }) =>
        mode === 'fill'
          ? {
              fillState: 'filling',
              nextPage: page + 1,
              entries: entries + added,
              fillSort,
              emptyPage: null,
              firstPageFailures: 0,
              recheckAt: null,
              lastError: null,
            }
          : { entries: entries + added, lastError: null },
      );
      if (!written) return superseded(outcome);
      outcome.added += written.added;
      outcome.updated += written.updated;
      entries += written.added;
      if (mode === 'fill') {
        cursor.expectedNext = page + 1;
        continue;
      }
      if (written.added === 0) {
        if (!(await save({ lastTopupAt: this.now() }))) return superseded(outcome);
        return { ...outcome, stopped: 'known' };
      }
    }
  }
}

interface RunCursor {
  mode: RunMode;
  expectedNext: number;
}

function runGuard(cursor: RunCursor): NovelIndexSourceGuard {
  return cursor.mode === 'fill' ? { nextPage: cursor.expectedNext } : { fillState: 'done' };
}

function superseded(outcome: RunOutcome): RunOutcome {
  return { ...outcome, stopped: 'superseded' };
}
