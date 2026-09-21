import { BadGatewayException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MONITORED_FORMATS } from '@bookorbit/types';
import type { MonitoredAuthorConfig, MonitoredDatePrecision, MonitoredFormat, ProviderConfigurations } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import { HardcoverClient } from '../metadata-fetch/providers/hardcover/hardcover.client';
import { MonitoredProviderConfigService } from './monitored-provider-config.service';
import {
  MonitoredReleaseProbeStore,
  type ReleaseProbeOutcome,
  type ReleaseProbeRow,
  type ReleaseProbeWork,
  type ReleaseProbeWorkRef,
} from './monitored-release-probe-store.service';
import { MonitoredSettingsService } from './monitored-settings.service';
import { isHardcoverConfigured } from './providers/hardcover-bibliography.provider';
import { fetchAmazonPage, findAmazonFamily, type AmazonPageBudget } from './release-probe/amazon-family';
import type { AmazonProductPage } from './release-probe/amazon-format-family';
import { AmazonProductPageClient } from './release-probe/amazon-product-page.client';
import { AppleBooksClient, appleCountryForAmazonDomain } from './release-probe/apple-books.client';
import { buildHardcoverEvidence, mapHardcoverProbeBook } from './release-probe/hardcover-edition-evidence';
import { decideFormat, nextProbeCheckAt } from './release-probe/probe-decision';
import type { AmazonEvidence, HardcoverEvidence, ProbeDecision, ProbeSnapshot, ProbeSuggestion } from './release-probe/release-probe.types';

export const PROBE_CRON = '0 15 * * * *';
export const WORKS_PER_TICK = 40;
export const REFRESH_PASS_LIMIT = 50;
export const HARDCOVER_SLUGS_PER_QUERY = 50;
export const APPLE_REQUESTS_PER_TICK = 15;
export const AMAZON_PAGES_PER_TICK = 20;
export const SWEEP_AMAZON_PAGES_PER_WORK = 6;
export const APPLE_RETRY_MS = 60 * 60 * 1000;
export const WORK_REFRESH_APPLE_REQUESTS = 1;
export const WORK_REFRESH_AMAZON_PAGES = 4;
export const WORK_REFRESH_COOLDOWN_MS = 30 * 1000;
export const CONFIRMED_DATE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const USER_DATE_FIRST_CHECK_MS = 24 * 60 * 60 * 1000;

const FORMATS = MONITORED_FORMATS;

interface ProbeStats {
  hardcoverQueries: number;
  appleRequests: number;
  amazonPages: number;
  dated: number;
  expected: number;
  unlisted: number;
  suggested: number;
  ledgerResets: number;
  failed: number;
}

/** A tick-wide allowance plus the share of it the owner being processed may spend. */
interface ProbeBudget {
  tick: number;
  owner: number;
}

interface ProbeRun {
  now: Date;
  today: string;
  apple: ProbeBudget;
  amazon: ProbeBudget;
  stats: ProbeStats;
  disabled: boolean;
}

interface StickyEvidenceResult {
  decisions: Record<MonitoredFormat, ProbeDecision | null>;
  rescheduleOnly: Set<MonitoredFormat>;
}

interface ProbeWorkOptions {
  pendingOnly: boolean;
  onDemand: boolean;
}

interface GatheredEvidence {
  decisions: Record<MonitoredFormat, ProbeDecision | null>;
  appleEvidence: { releaseDate: string } | null | undefined;
  appleConsulted: boolean;
  amazonConsulted: boolean;
  appleDeferred: boolean;
}

interface AssembledOutcome {
  outcome: ReleaseProbeOutcome;
  suggestedFormats: Set<MonitoredFormat>;
}

function emptyStats(): ProbeStats {
  return { hardcoverQueries: 0, appleRequests: 0, amazonPages: 0, dated: 0, expected: 0, unlisted: 0, suggested: 0, ledgerResets: 0, failed: 0 };
}

function budgetAvailable(budget: ProbeBudget): boolean {
  return budget.tick > 0 && budget.owner > 0;
}

function spendBudget(budget: ProbeBudget): void {
  budget.tick--;
  budget.owner--;
}

function shareBudget(budget: ProbeBudget, ownersLeft: number): void {
  budget.owner = Math.min(budget.tick, Math.max(1, Math.ceil(budget.tick / ownersLeft)));
}

function errorDetails(error: unknown): { errorClass: string; message: string } {
  return {
    errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
}

function rowFor(work: ReleaseProbeWork, format: MonitoredFormat): ReleaseProbeRow | undefined {
  return work.releases.find((row) => row.format === format);
}

function snapshotFor(work: ReleaseProbeWork): ProbeSnapshot {
  return Object.fromEntries(
    FORMATS.map((format) => {
      const row = rowFor(work, format);
      return [format, row ? { status: row.status, releaseDate: row.releaseDate, source: row.source, autoReleaseDate: row.autoReleaseDate } : null];
    }),
  ) as ProbeSnapshot;
}

function inheritedFor(work: ReleaseProbeWork, format: 'ebook' | 'audiobook'): { date: string | null; precision: MonitoredDatePrecision | null } {
  const date = format === 'ebook' ? work.ebookReleaseDate : work.audioReleaseDate;
  const precision = format === 'ebook' ? work.ebookDatePrecision : work.audioDatePrecision;
  if (date) return { date, precision };
  const stored = rowFor(work, format);
  // Enrolment parks the catalog's inherited date on the pending row and clears the column, so the
  // hint has to be read back from both shapes.
  return (stored?.status === 'expected' || stored?.status === 'pending') && stored.source === null
    ? { date: stored.releaseDate, precision: stored.datePrecision }
    : { date: null, precision: null };
}

function decisionFromRow(row: ReleaseProbeRow): ProbeDecision {
  return {
    status: row.status,
    releaseDate: row.releaseDate,
    precision: row.datePrecision,
    source: row.source,
    asin: row.asin,
    overlay: row.status === 'dated' ? 'set' : 'clear',
  };
}

/** A listing that disappeared is not an update to the owner's date, so only a dated result suggests. */
function suggestionFrom(decision: ProbeDecision | null | undefined): ProbeSuggestion | null {
  return decision?.status === 'dated' && decision.releaseDate
    ? { releaseDate: decision.releaseDate, precision: decision.precision, source: decision.source }
    : null;
}

function distinct(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

@Injectable()
export class MonitoredReleaseProbeService {
  private readonly logger = new Logger(MonitoredReleaseProbeService.name);
  private running = false;
  // Bounded by the cooldown itself: every entry older than one window is dropped on the next call.
  private readonly workRefreshedAt = new Map<string, number>();

  constructor(
    private readonly store: MonitoredReleaseProbeStore,
    private readonly hardcover: HardcoverClient,
    private readonly apple: AppleBooksClient,
    private readonly amazon: AmazonProductPageClient,
    private readonly providerConfigs: MonitoredProviderConfigService,
    private readonly settings: MonitoredSettingsService,
  ) {}

  @Cron(PROBE_CRON)
  async runScheduledProbe(): Promise<void> {
    if (this.running) {
      this.logger.log('[monitored.release_probe.sweep] [end] durationMs=0 skipped=true - previous run still in flight');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    const run = this.newRun(new Date(), true);
    let worksCount = 0;
    let ownersCount = 0;
    try {
      const { releaseProbeEnabled } = await this.settings.getMonitoredSettings();
      if (!releaseProbeEnabled) {
        await this.clearDisabledProbeRows(startedAt);
        return;
      }
      const works = await this.store.findDueWorks(run.now, WORKS_PER_TICK);
      if (!works.length) return;
      worksCount = works.length;
      const byOwner = new Map<number, ReleaseProbeWork[]>();
      for (const work of works) byOwner.set(work.ownerUserId, [...(byOwner.get(work.ownerUserId) ?? []), work]);
      ownersCount = byOwner.size;
      this.logger.log(`[monitored.release_probe.sweep] [start] works=${worksCount} owners=${ownersCount} - release probe sweep started`);
      // Smallest owners first, each offered an equal share of what is still unspent: whatever a
      // small owner leaves on the table flows to the owners after it instead of expiring with the tick.
      const owners = [...byOwner].sort((left, right) => left[1].length - right[1].length || left[0] - right[0]);
      for (const [index, [ownerUserId, ownerWorks]] of owners.entries()) {
        const ownerStartedAt = Date.now();
        shareBudget(run.apple, owners.length - index);
        shareBudget(run.amazon, owners.length - index);
        try {
          const config = await this.providerConfigs.forUser(ownerUserId);
          if (!isHardcoverConfigured(config)) {
            await this.store.recordFailure(
              ownerWorks.map((work) => work.id),
              'HardcoverNotConfigured',
              run.now,
            );
            run.stats.failed += ownerWorks.length;
            continue;
          }
          await this.processOwner(ownerUserId, ownerWorks, config, run, { pendingOnly: false, onDemand: false });
          if (run.disabled) break;
        } catch (error) {
          const { errorClass, message } = errorDetails(error);
          this.logger.warn(
            `[monitored.release_probe.owner] [fail] userId=${ownerUserId} works=${ownerWorks.length} durationMs=${Date.now() - ownerStartedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - release probe owner failed`,
          );
          await this.store.recordFailure(
            ownerWorks.map((work) => work.id),
            errorClass,
            run.now,
          );
          run.stats.failed += ownerWorks.length;
        }
      }
      this.logger.log(
        `[monitored.release_probe.sweep] [end] durationMs=${Date.now() - startedAt} works=${worksCount} hardcoverQueries=${run.stats.hardcoverQueries} appleRequests=${run.stats.appleRequests} amazonPages=${run.stats.amazonPages} dated=${run.stats.dated} expected=${run.stats.expected} unlisted=${run.stats.unlisted} suggested=${run.stats.suggested} ledgerResets=${run.stats.ledgerResets} failed=${run.stats.failed} - release probe sweep completed`,
      );
    } catch (error) {
      const { errorClass, message } = errorDetails(error);
      this.logger.warn(
        `[monitored.release_probe.sweep] [fail] durationMs=${Date.now() - startedAt} works=${worksCount} owners=${ownersCount} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - release probe sweep failed`,
      );
    } finally {
      this.running = false;
    }
  }

  async enrolAndProbe(monitor: MonitoredAuthorConfig, config: ProviderConfigurations): Promise<void> {
    const { releaseProbeEnabled } = await this.settings.getMonitoredSettings();
    if (!releaseProbeEnabled) return;
    const now = new Date();
    await this.store.prune(monitor.id);
    const works = await this.store.findPendingWorksForMonitor(monitor.id, REFRESH_PASS_LIMIT);
    if (!works.length || !isHardcoverConfigured(config)) return;
    await this.processOwner(monitor.ownerUserId, works, config, this.newRun(now, false), { pendingOnly: true, onDemand: false });
  }

  /**
   * Every tier run against a single work on demand. The sweep's tick budgets belong to the sweep, so
   * this carries its own small allowance, and it still honours the pause a throttled provider set.
   */
  async refreshWork(monitor: { id: string; ownerUserId: number }, workId: string): Promise<void> {
    const { releaseProbeEnabled } = await this.settings.getMonitoredSettings();
    if (!releaseProbeEnabled) throw new ConflictException('The release date probe is turned off');
    const startedAt = Date.now();
    let claimedCooldown = false;
    try {
      claimedCooldown = this.assertWorkRefreshAllowed(workId, startedAt);
      const now = new Date();
      const run: ProbeRun = {
        now,
        today: now.toISOString().slice(0, 10),
        apple: { tick: WORK_REFRESH_APPLE_REQUESTS, owner: WORK_REFRESH_APPLE_REQUESTS },
        amazon: { tick: WORK_REFRESH_AMAZON_PAGES, owner: WORK_REFRESH_AMAZON_PAGES },
        stats: emptyStats(),
        disabled: false,
      };
      this.logger.log(
        `[monitored.release_probe.work_refresh] [start] workId="${sanitizeLogValue(workId)}" userId=${monitor.ownerUserId} - on-demand release probe started`,
      );
      const found = await this.store.findWork(workId);
      if (!found) throw new NotFoundException('Monitored work not found');
      let work = found;
      // A work outside the probe window is never enrolled, and it is still decided and stored here:
      // asking for its dates is the owner saying this one work is worth a check.
      if (!work.releases.length) {
        await this.store.enrol(monitor, run.today);
        work = (await this.store.findWork(workId)) ?? work;
      }
      const config = await this.providerConfigs.forUser(monitor.ownerUserId);
      if (isHardcoverConfigured(config)) {
        await this.processOwner(monitor.ownerUserId, [work], config, run, { pendingOnly: false, onDemand: true });
      } else {
        await this.runWork(work, null, config, run, { pendingOnly: false, onDemand: true });
      }
      if (run.stats.failed > 0) throw new BadGatewayException('Release date providers could not be reached');
      this.logger.log(
        `[monitored.release_probe.work_refresh] [end] workId="${sanitizeLogValue(workId)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - startedAt} dated=${run.stats.dated} expected=${run.stats.expected} unlisted=${run.stats.unlisted} suggested=${run.stats.suggested} failed=${run.stats.failed} - on-demand release probe completed`,
      );
    } catch (error) {
      if (claimedCooldown && this.workRefreshedAt.get(workId) === startedAt) this.workRefreshedAt.delete(workId);
      const { errorClass, message } = errorDetails(error);
      this.logger.warn(
        `[monitored.release_probe.work_refresh] [fail] workId="${sanitizeLogValue(workId)}" userId=${monitor.ownerUserId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - on-demand release probe failed`,
      );
      throw error;
    }
  }

  /**
   * The owner's own date, written the way the probe writes its own so the overlay and the release
   * ledger stay in step. The probe keeps checking the format behind it, soon enough that a store
   * moving its date shows up as a suggestion rather than a month later.
   */
  async setUserReleaseDate(work: ReleaseProbeWorkRef, format: MonitoredFormat, releaseDate: string): Promise<number> {
    const { releaseProbeEnabled } = await this.settings.getMonitoredSettings();
    if (!releaseProbeEnabled) throw new ConflictException('The release date probe is turned off');
    const now = new Date();
    const decision: ProbeDecision = { status: 'dated', releaseDate, precision: 'day', source: 'user', asin: null, overlay: 'set' };
    const result = await this.store.saveOutcome(
      work,
      { [format]: { decision, nextCheckAt: new Date(now.getTime() + USER_DATE_FIRST_CHECK_MS) } },
      now,
    );
    return result.ledgerResets;
  }

  /** Hands one format back to the probe. Only the owner's own row may be cleared this way. */
  async clearUserReleaseDate(workId: string, format: MonitoredFormat): Promise<boolean> {
    return this.store.clearUserReleaseDate(workId, format, new Date());
  }

  private assertWorkRefreshAllowed(workId: string, now: number): boolean {
    for (const [id, refreshedAt] of this.workRefreshedAt) {
      if (now - refreshedAt >= WORK_REFRESH_COOLDOWN_MS) this.workRefreshedAt.delete(id);
    }
    if (this.workRefreshedAt.has(workId)) {
      throw new HttpException('These release dates were just refreshed; try again in a few seconds', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.workRefreshedAt.set(workId, now);
    return true;
  }

  private newRun(now: Date, externalTiers: boolean): ProbeRun {
    return {
      now,
      today: now.toISOString().slice(0, 10),
      apple: { tick: externalTiers ? APPLE_REQUESTS_PER_TICK : 0, owner: 0 },
      amazon: { tick: externalTiers ? AMAZON_PAGES_PER_TICK : 0, owner: 0 },
      stats: emptyStats(),
      disabled: false,
    };
  }

  private async processOwner(
    ownerUserId: number,
    works: ReleaseProbeWork[],
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    const hardcoverBySlug = new Map<string, HardcoverEvidence>();
    const slugs = distinct(works.map((work) => work.hardcoverSlug));
    try {
      for (let offset = 0; offset < slugs.length; offset += HARDCOVER_SLUGS_PER_QUERY) {
        const batch = slugs.slice(offset, offset + HARDCOVER_SLUGS_PER_QUERY);
        run.stats.hardcoverQueries++;
        const books = await this.hardcover.fetchEditionsBySlugs(batch, config.hardcover.apiKey, undefined, { surfaceFailures: true });
        for (const book of books) hardcoverBySlug.set(book.slug, buildHardcoverEvidence(mapHardcoverProbeBook(book), run.today));
      }
    } catch (error) {
      const { errorClass, message } = errorDetails(error);
      this.logger.warn(
        `[monitored.release_probe.hardcover] [fail] userId=${ownerUserId} works=${works.length} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Hardcover release probe failed`,
      );
      if (!options.onDemand) {
        await this.store.recordFailure(
          works.map((work) => work.id),
          errorClass,
          run.now,
        );
      }
      run.stats.failed += works.length;
      return;
    }

    for (const work of works) {
      const hardcover = work.hardcoverSlug ? hardcoverBySlug.get(work.hardcoverSlug) : null;
      // A slug the batch answered for without a book is a provider gap, not an empty bibliography:
      // deciding it as "Hardcover knows nothing" would turn silence into negative evidence.
      if (hardcover === undefined) {
        if (!options.onDemand) await this.store.recordFailure([work.id], 'HardcoverBookMissing', run.now);
        run.stats.failed++;
        continue;
      }
      await this.runWork(work, hardcover, config, run, options);
      if (run.disabled) break;
    }
  }

  /** One work decided and stored, with its failure kept off every other work in the same run. */
  private async runWork(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.processWork(work, hardcover, config, run, options);
    } catch (error) {
      const { errorClass, message } = errorDetails(error);
      if (!options.onDemand) await this.store.recordFailure([work.id], errorClass, run.now);
      run.stats.failed++;
      this.logger.warn(
        `[monitored.release_probe.work] [fail] workId="${sanitizeLogValue(work.id)}" durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - release probe work failed`,
      );
    }
  }

  private async processWork(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
  ): Promise<void> {
    const gathered = await this.gatherEvidence(work, hardcover, config, run, options);
    const automatic = gathered.decisions;
    const sticky = this.applyStickyEvidence(work, automatic, run.now, {
      hardcover: hardcover !== null,
      apple: gathered.appleConsulted,
      amazon: gathered.amazonConsulted,
    });
    const assembled = this.assembleOutcome(work, automatic, sticky, run, gathered.appleDeferred, options);
    if (!(await this.ensureProbeEnabled(run))) return;
    await this.recordOutcome(work, assembled, run);
  }

  private async gatherEvidence(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
  ): Promise<GatheredEvidence> {
    const initial: GatheredEvidence = {
      decisions: this.decideAll(work, hardcover, undefined, undefined),
      appleEvidence: undefined,
      appleConsulted: false,
      amazonConsulted: false,
      appleDeferred: false,
    };
    const afterApple = await this.gatherAppleEvidence(work, hardcover, config, run, options, initial);
    return this.gatherAmazonEvidence(work, hardcover, config, run, options, afterApple);
  }

  private async gatherAppleEvidence(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
    gathered: GatheredEvidence,
  ): Promise<GatheredEvidence> {
    const wantsApple = !options.pendingOnly && ['expected', 'unlisted'].includes(gathered.decisions.ebook?.status ?? '');
    if (wantsApple && budgetAvailable(run.apple) && run.now.getTime() >= this.apple.pausedUntil()) {
      const appleStartedAt = Date.now();
      spendBudget(run.apple);
      run.stats.appleRequests++;
      try {
        const apple = await this.apple.searchEbook(work.title, work.authorName, appleCountryForAmazonDomain(config.amazon.domain));
        return {
          ...gathered,
          decisions: this.decideAll(work, hardcover, apple, undefined),
          appleEvidence: apple,
          appleConsulted: true,
        };
      } catch (error) {
        if (error instanceof ProviderThrottleError) {
          const { errorClass, message } = errorDetails(error);
          this.logger.warn(
            `[monitored.release_probe.apple] [fail] workId="${sanitizeLogValue(work.id)}" userId=${work.ownerUserId} durationMs=${Date.now() - appleStartedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - Apple tier paused`,
          );
          return { ...gathered, appleDeferred: true };
        } else {
          throw error;
        }
      }
    }
    return wantsApple ? { ...gathered, appleDeferred: true } : gathered;
  }

  private async gatherAmazonEvidence(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    config: ProviderConfigurations,
    run: ProbeRun,
    options: ProbeWorkOptions,
    gathered: GatheredEvidence,
  ): Promise<GatheredEvidence> {
    if (
      !options.pendingOnly &&
      config.amazon.enabled &&
      run.now.getTime() >= this.amazon.pausedUntil() &&
      budgetAvailable(run.amazon) &&
      FORMATS.some((format) => ['expected', 'unlisted'].includes(gathered.decisions[format]?.status ?? ''))
    ) {
      const amazonStartedAt = Date.now();
      try {
        const evidence = await this.amazonEvidence(work, hardcover, gathered.decisions, config, run);
        if (evidence) {
          return {
            ...gathered,
            decisions: this.decideAll(work, hardcover, gathered.appleEvidence, evidence),
            amazonConsulted: true,
          };
        }
      } catch (error) {
        if (error instanceof ProviderThrottleError) {
          const { errorClass, message } = errorDetails(error);
          this.logger.warn(
            `[monitored.release_probe.amazon] [fail] workId="${sanitizeLogValue(work.id)}" userId=${work.ownerUserId} durationMs=${Date.now() - amazonStartedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - amazon tier paused`,
          );
        } else {
          throw error;
        }
      }
    }
    return gathered;
  }

  private assembleOutcome(
    work: ReleaseProbeWork,
    automatic: Record<MonitoredFormat, ProbeDecision | null>,
    sticky: StickyEvidenceResult,
    run: ProbeRun,
    appleDeferred: boolean,
    options: ProbeWorkOptions,
  ): AssembledOutcome {
    const outcome: ReleaseProbeOutcome = {};
    const suggestedFormats = new Set<MonitoredFormat>();
    for (const format of FORMATS) {
      const assembled = this.assembleFormatOutcome(work, format, automatic, sticky, run, appleDeferred, options);
      if (assembled === undefined) continue;
      outcome[format] = assembled.value;
      if (assembled.suggested) suggestedFormats.add(format);
    }
    return { outcome, suggestedFormats };
  }

  private assembleFormatOutcome(
    work: ReleaseProbeWork,
    format: MonitoredFormat,
    automatic: Record<MonitoredFormat, ProbeDecision | null>,
    sticky: StickyEvidenceResult,
    run: ProbeRun,
    appleDeferred: boolean,
    options: ProbeWorkOptions,
  ): { value: ReleaseProbeOutcome[MonitoredFormat]; suggested: boolean } | undefined {
    const stored = rowFor(work, format);
    if (options.pendingOnly && stored?.status !== 'pending') return undefined;
    const decision = sticky.decisions[format];
    if (!decision) return { value: null, suggested: false };
    // A row the owner dated is restated as it stands, so what it is watching - its cadence and its
    // suggestion - comes from the automatic decision the tiers just produced instead of the row.
    const watched = stored?.source === 'user' ? automatic : sticky.decisions;
    const cadence = watched[format] ?? decision;
    const siblingDates = FORMATS.filter((candidate) => candidate !== format)
      .map((candidate) => watched[candidate]?.releaseDate ?? null)
      .filter((date): date is string => date !== null);
    // An ebook that only missed Apple because the tier was spent or paused is asked again next
    // tick rather than waiting out the cadence for evidence that was never actually gathered.
    const retryDecision = stored?.source === 'user' ? automatic[format] : decision;
    const retrySoon = format === 'ebook' && appleDeferred && ['expected', 'unlisted'].includes(retryDecision?.status ?? '');
    const suggested = stored?.source === 'user' ? suggestionFrom(automatic[format]) : null;
    return {
      value: {
        decision,
        rescheduleOnly: sticky.rescheduleOnly.has(format),
        ...(suggested ? { suggested } : {}),
        nextCheckAt: retrySoon
          ? new Date(Math.max(run.now.getTime() + APPLE_RETRY_MS, this.apple.pausedUntil()))
          : nextProbeCheckAt(run.now, {
              status: cadence.status,
              releaseDate: cadence.releaseDate,
              precision: cadence.precision,
              source: cadence.source,
              siblingDates,
              failed: false,
              attempts: 0,
            }),
      },
      suggested: Boolean(suggested && suggested.releaseDate !== stored?.autoReleaseDate && suggested.releaseDate !== stored?.releaseDate),
    };
  }

  private async recordOutcome(work: ReleaseProbeWork, assembled: AssembledOutcome, run: ProbeRun): Promise<void> {
    const saveStartedAt = Date.now();
    const saveResult = await this.store.saveOutcome(work, assembled.outcome, run.now, snapshotFor(work));
    for (const format of saveResult.appliedFormats) {
      const value = assembled.outcome[format];
      const decision = value?.decision;
      if (decision?.status === 'dated') run.stats.dated++;
      if (decision?.status === 'expected') run.stats.expected++;
      if (decision?.status === 'unlisted') run.stats.unlisted++;
    }
    run.stats.suggested += saveResult.appliedFormats.filter((format) => assembled.suggestedFormats.has(format)).length;
    run.stats.ledgerResets += saveResult.ledgerResets;
    if (saveResult.ledgerResets > 0) {
      for (const format of FORMATS) {
        const decision = assembled.outcome[format]?.decision;
        if (decision?.status === 'dated' && decision.releaseDate) {
          this.logger.log(
            `[monitored.release_probe.ledger_reset] [end] workId="${sanitizeLogValue(work.id)}" userId=${work.ownerUserId} format=${format} deleted=${saveResult.ledgerResets} durationMs=${Date.now() - saveStartedAt} - stale release ledger rows removed`,
          );
          break;
        }
      }
    }
  }

  private decideAll(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    apple: { releaseDate: string } | null | undefined,
    amazon: AmazonEvidence | undefined,
  ): Record<MonitoredFormat, ProbeDecision | null> {
    const storedAudio = rowFor(work, 'audiobook');
    const storedAudible =
      storedAudio?.source === 'user' && storedAudio.autoSource === 'audible' && storedAudio.autoReleaseDate && work.sources.includes('audible')
        ? { date: storedAudio.autoReleaseDate, precision: storedAudio.autoDatePrecision }
        : null;
    const ownAudioOverlay =
      storedAudio?.status === 'dated' &&
      storedAudio.source !== null &&
      storedAudio.source !== 'audible' &&
      storedAudio.releaseDate === work.audioReleaseDate;
    // The catalog merger falls back to a cluster-consensus year for the audio column; only a day is
    // precise enough to have come from an Audible listing, and a date the row itself overlaid onto
    // that column - the owner's own, above all - must never come back as Audible evidence.
    const audible =
      storedAudible ??
      (work.audioReleaseDate && work.audioDatePrecision === 'day' && work.sources.includes('audible') && !ownAudioOverlay
        ? { date: work.audioReleaseDate, precision: work.audioDatePrecision }
        : null);
    const decisions: Record<MonitoredFormat, ProbeDecision | null> = {
      ebook: decideFormat({
        format: 'ebook',
        owned: work.ownedFormats.includes('ebook'),
        inherited: inheritedFor(work, 'ebook'),
        audible: null,
        hardcover,
        apple,
        amazon,
      }),
      audiobook: decideFormat({
        format: 'audiobook',
        owned: work.ownedFormats.includes('audiobook'),
        inherited: inheritedFor(work, 'audiobook'),
        audible,
        hardcover,
        apple: undefined,
        amazon,
      }),
    };
    return decisions;
  }

  private applyStickyEvidence(
    work: ReleaseProbeWork,
    decisions: Record<MonitoredFormat, ProbeDecision | null>,
    now: Date,
    consulted: { hardcover: boolean; apple: boolean; amazon: boolean },
  ): StickyEvidenceResult {
    const rescheduleOnly = new Set<MonitoredFormat>();
    const stickyDecisions = Object.fromEntries(
      FORMATS.map((format) => {
        const stored = rowFor(work, format);
        const decision = decisions[format];
        if (!decision) return [format, null];
        if (!stored?.source) return [format, decision];
        if (stored.source === 'user') {
          rescheduleOnly.add(format);
          return [format, decisionFromRow(stored)];
        }
        if (decision?.status === 'dated') return [format, decision];
        const sourceNotConsulted =
          (stored.source === 'hardcover_edition' && !consulted.hardcover) ||
          (stored.source === 'apple' && !consulted.apple) ||
          ((stored.source === 'amazon' || stored.source === 'amazon_search') && !consulted.amazon);
        const withinGrace =
          stored.status === 'dated' && stored.checkedAt !== null && now.getTime() - stored.checkedAt.getTime() <= CONFIRMED_DATE_GRACE_MS;
        if (!sourceNotConsulted && !withinGrace) return [format, decision];
        rescheduleOnly.add(format);
        return [format, decisionFromRow(stored)];
      }),
    ) as Record<MonitoredFormat, ProbeDecision | null>;
    return { decisions: stickyDecisions, rescheduleOnly };
  }

  private async ensureProbeEnabled(run: ProbeRun): Promise<boolean> {
    if (run.disabled) return false;
    const { releaseProbeEnabled } = await this.settings.getMonitoredSettings();
    if (releaseProbeEnabled) return true;
    run.disabled = true;
    await this.clearDisabledProbeRows(Date.now());
    return false;
  }

  private async clearDisabledProbeRows(startedAt: number): Promise<void> {
    const deleted = await this.store.clearAll();
    if (deleted > 0) {
      this.logger.log(
        `[monitored.release_probe.disabled] [end] durationMs=${Date.now() - startedAt} deleted=${deleted} - release probe rows removed`,
      );
    }
  }

  private async amazonEvidence(
    work: ReleaseProbeWork,
    hardcover: HardcoverEvidence | null,
    decisions: Record<MonitoredFormat, ProbeDecision | null>,
    config: ProviderConfigurations,
    run: ProbeRun,
  ): Promise<AmazonEvidence | undefined> {
    const wanted = FORMATS.filter((format) => ['expected', 'unlisted'].includes(decisions[format]?.status ?? ''));
    const others = FORMATS.filter((format) => !wanted.includes(format));
    const seeds = distinct([
      ...wanted.flatMap((format) => hardcover?.[format].seeds ?? []),
      ...others.flatMap((format) => hardcover?.[format].seeds ?? []),
      ...(hardcover?.physical.seeds ?? []),
      work.audibleAsin,
    ]);
    const budget = this.amazonBudget(run);
    const result = await findAmazonFamily(this.amazon, { title: work.title, authorName: work.authorName, seeds, amazon: config.amazon }, budget);
    if (result.outcome === 'missing') return { listing: 'none' };
    if (result.outcome !== 'found') return undefined;
    const family: AmazonProductPage = result.page;

    const formats: Extract<AmazonEvidence, { listing: 'found' }>['formats'] = {};
    for (const format of FORMATS) {
      const swatch = family.formats.find((entry) => entry.format === format);
      if (!swatch) continue;
      let date = swatch.selected ? family.releaseDate : null;
      if (!swatch.selected && wanted.includes(format) && swatch.asin) {
        if (!budget.available()) return undefined;
        const linked = await fetchAmazonPage(this.amazon, swatch.asin, config.amazon, budget);
        date = linked?.releaseDate ?? null;
      }
      formats[format] = { asin: swatch.asin, date };
    }
    return { listing: 'found', formats };
  }

  private amazonBudget(run: ProbeRun): AmazonPageBudget {
    let remaining = SWEEP_AMAZON_PAGES_PER_WORK;
    return {
      available: () => remaining > 0 && budgetAvailable(run.amazon),
      spend: () => {
        remaining--;
        spendBudget(run.amazon);
        run.stats.amazonPages++;
      },
    };
  }
}
