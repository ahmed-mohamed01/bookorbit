import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type BookKnowledgeXrayEstimate,
  type BookKnowledgeXrayMode,
  type BookKnowledgeXrayPayload,
  type BookKnowledgeXrayRun,
  type BookKnowledgeXrayStep,
  type BookKnowledgeXrayStepId,
  type StoryGuideSectionInfo,
} from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { AiError, isAiError, type AiEffort, type AiResult, type AiSlotChoice as AiModelChoice } from '../ai/ai-client.types';
import { AiJobFailure, AiJobPause } from '../ai-jobs/ai-feature';
import { BookReadService } from '../book/book-read.service';
import { readBookText } from '../story-guides/text/book-text-reader';
import { BookKnowledgeModelService, CLASSIFY_TEMPERATURE } from './book-knowledge-model.service';
import { BookKnowledgeService } from './book-knowledge.service';
import { fractionToOrdinal } from './core/cutoff';
import { readEpubMetadata } from './core/epub-metadata';
import {
  KIND_REVIEW_MAX_TOKENS,
  KIND_REVIEW_SYSTEM,
  parseReviewAnswers,
  planKindReview,
  reviewCheckpoint,
  type KindAnswer,
  type KindReviewBatch,
} from './core/kind-review';
import type { Artifact } from './core/model';
import { XrayAnchors } from './xray/xray-anchors';
import { densePlannedCalls } from './xray/dense/dense-estimate';
import { headingPairs, windowLinks } from './xray/dense/dense-links';
import { DENSE_PROMPT_VERSION } from './xray/dense/dense-prompt';
import { runDense } from './xray/dense/dense-run';
import type { PassSlot } from './xray/pass/pass-cast';
import { passPayload, unitEnd } from './xray/pass/pass-payload';
import type { Ask } from './xray/pass/pass-run';
import { spoilerSweep, stateCounts } from './xray/pass/pass-state';
import { passUnits } from './xray/pass/pass-units';
import { bodySections, sectionCharacters } from './xray/xray-evidence';
import { xrayEntities } from './xray/xray-entities';
import { namesAt } from './xray/xray-lines';
import { linkCheckpoints } from './xray/xray-links';
import { modeFromSubjects } from './xray/xray-mode';
import { xrayPayload } from './xray/xray-payload';
import { estimate } from './xray/xray-plan';
import { capped, inOrder, limiter, retryable, XrayPrivacy, XrayRunCalls, XrayStepRun } from './xray/xray-runner';
import { replayable, XrayUnitStore } from './xray/xray-unit-store';
import { XraySlot } from './xray/xray-slot';

const KEPT_RUNS = 4;
const RUN_PREFIX = 'bk-xray-';
const XRAY_EFFORT: AiEffort = 'low';
const CANCELLED = 'cancelled';

interface StoredRun {
  run: BookKnowledgeXrayRun;
  payload: BookKnowledgeXrayPayload | null;
  /** Stops the run's model calls: on a failure, so the asks already launched stop spending, and on cancel. */
  abort: AbortController;
}

interface BuildInput {
  stored: StoredRun;
  run: BookKnowledgeXrayRun;
  artifact: Artifact;
  fingerprint: string;
  bookPath: string;
  fast: AiModelChoice;
  complete: XrayCompleter;
  dryRun: boolean;
  /** Ignore the stored answers of earlier builds, so a bench run measures every call. */
  fresh: boolean;
  /** Part of every stored answer's key, so a new scope (a rebuilt job's generation) asks the model again. */
  replayScope?: string;
  onProgress?: XrayBuildProgress;
}

export type XrayBuildStage = 'kinds' | 'alias' | 'dense' | 'finish';
/** What a build is doing; synchronous and must not throw. */
export type XrayBuildProgress = (stage: XrayBuildStage, done: number, total: number) => void;

/** With no signal on this request, in-flight job calls settle after a pause and their answers are dropped. */
export type XrayCompleter = (request: {
  use: AiModelChoice;
  system: string;
  user: string;
  maxOutputTokens: number;
  effort?: AiEffort;
  temperature?: number;
}) => Promise<AiResult>;

type XrayRunOptions = { through?: number; dryRun?: boolean; mode?: BookKnowledgeXrayMode; fresh?: boolean };

type AskWith = (
  use: AiModelChoice,
  system: string,
  user: string,
  maxOutputTokens: number,
  effort?: AiEffort,
  temperature?: number,
) => () => Promise<AiResult>;

/** Hosted calls in flight at once in a dense run. */
const DENSE_CONCURRENCY = 8;

/** The steps whose skipped units lower a story guide build's coverage; an empty alias, now or about result is normal. */
export const BK_COVERAGE_STEPS: readonly BookKnowledgeXrayStepId[] = ['kinds', 'notes', 'facts', 'describe', 'ties'];
/** A step with fewer units is left out of coverage: one refused batch of a handful would fail an otherwise sound build. */
export const BK_COVERAGE_MIN_UNITS = 10;

/** The lowest share of units that returned a valid answer over the counted steps; 1 when none is counted. */
export function storyGuideCoverage(steps: readonly BookKnowledgeXrayStep[]): number {
  let coverage = 1;
  for (const step of steps) {
    if (!BK_COVERAGE_STEPS.includes(step.step) || step.units < BK_COVERAGE_MIN_UNITS) continue;
    coverage = Math.min(coverage, (step.units - step.skipped) / step.units);
  }
  return coverage;
}

/**
 * The X-Ray build: Book Knowledge's entities without a model, then the dense pass in chunks through upstream's
 * AI client on the fast slot. One build at a time; runs are kept in memory for the admin and bench routes.
 */
@Injectable()
export class BookKnowledgeXrayService {
  private readonly logger = new Logger(BookKnowledgeXrayService.name);
  private readonly runs = new Map<string, StoredRun>();
  private readonly slot = new XraySlot();

  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly read: BookReadService,
    private readonly model: BookKnowledgeModelService,
  ) {}

  async start(bookId: number, user: RequestUser, options: XrayRunOptions = {}): Promise<BookKnowledgeXrayRun> {
    if (this.slot.busy()) throw new ConflictException('An X-Ray build is already running');
    const release = await this.slot.acquire();
    try {
      const jobId = randomUUID();
      const abort = new AbortController();
      const fast = await this.model.choice('fast');
      if (!fast) throw new ServiceUnavailableException('Book Knowledge model is not configured');
      const { stored, input } = await this.prepare(bookId, user, {
        ...options,
        runId: `${RUN_PREFIX}${jobId}`,
        abort,
        fast,
        // The usage ledger joins AI jobs on a UUID, so it gets the ID without the bench prefix.
        complete: (request) => this.model.complete({ ...request, jobId, signal: abort.signal }),
      });
      this.keep(stored);
      void this.build(input)
        .catch(() => undefined)
        .finally(release);
      return stored.run;
    } catch (error) {
      release();
      throw error;
    }
  }

  async planEstimate(bookId: number, user: RequestUser): Promise<BookKnowledgeXrayEstimate> {
    const fast = await this.model.choice('fast');
    if (!fast) throw new ServiceUnavailableException('Book Knowledge model is not configured');
    const { input } = await this.prepare(bookId, user, {
      runId: `${RUN_PREFIX}${randomUUID()}`,
      abort: new AbortController(),
      fast,
      complete: () => Promise.reject(new AiJobFailure('error', 'A dry run makes no model calls')),
      dryRun: true,
    });
    await this.build(input);
    if (!input.run.estimate) throw new AiJobFailure('error', 'X-Ray plan returned no estimate');
    return input.run.estimate;
  }

  /** The payload's coverage is the lower of the book share read and the counted steps' answered share. */
  async buildForStoryGuide({
    bookId,
    fileId,
    user,
    complete,
    signal,
    use,
    replayScope,
    onProgress,
  }: {
    bookId: number;
    /** The file the job was started for; a build that would read another one fails as unreadable. */
    fileId: number;
    user: RequestUser;
    complete: XrayCompleter;
    signal: AbortSignal;
    use: AiModelChoice;
    replayScope?: string;
    onProgress?: XrayBuildProgress;
  }): Promise<BookKnowledgeXrayPayload> {
    const release = await this.slot.acquire(signal);
    const abort = new AbortController();
    let run: BookKnowledgeXrayRun | undefined;
    const cancel = () => {
      // The engine aborts a paused, cancelled or lost job alike; none of them is a failed build.
      if (run?.status === 'running') run.error = CANCELLED;
      abort.abort(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const { input } = await this.prepare(bookId, user, {
        runId: `${RUN_PREFIX}${randomUUID()}`,
        abort,
        fast: use,
        // The job engine replaces use with its recorded model, so the cap rides on request.maxOutputTokens.
        complete,
        fileId,
        replayScope,
        onProgress,
      });
      run = input.run;
      const payload = await this.build(input);
      abort.signal.throwIfAborted();
      if (!payload) throw new AiJobFailure('error', 'X-Ray build returned no payload');
      return { ...payload, coverage: Math.min(payload.coverage, storyGuideCoverage(input.run.steps)) };
    } catch (error) {
      const failure: unknown = abort.signal.aborted ? abort.signal.reason : error;
      if (
        (signal.aborted && Object.is(failure, signal.reason)) ||
        failure instanceof AiJobPause ||
        failure instanceof AiJobFailure ||
        (failure instanceof Error && failure.name === 'AbortError') ||
        isAiError(failure)
      ) {
        throw failure;
      }
      const message = failure instanceof Error ? failure.message.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      throw new AiJobFailure('error', message || 'X-Ray build failed');
    } finally {
      signal.removeEventListener('abort', cancel);
      release();
    }
  }

  private async prepare(
    bookId: number,
    user: RequestUser,
    options: XrayRunOptions &
      Pick<BuildInput, 'fast' | 'complete' | 'onProgress' | 'replayScope'> & { runId: string; abort: AbortController; fileId?: number },
  ): Promise<{ stored: StoredRun; input: BuildInput }> {
    const { runId, abort, fast, complete, through, dryRun = false } = options;
    // A job reads the file without a ready index too, so a switch to an unindexed file reports the switch.
    const { artifact, fingerprint, file } = await this.knowledge.context(bookId, user, 'full', options.fileId === undefined).catch((error) => {
      if (options.fileId !== undefined && error instanceof BadRequestException) throw new AiJobFailure('unreadable', error.message);
      throw error;
    });
    abort.signal.throwIfAborted();
    if (options.fileId !== undefined && file.id !== options.fileId) {
      throw new AiJobFailure('unreadable', "The book's main ebook file changed after this build was started");
    }
    if (!artifact) throw new ConflictException('Book Knowledge is not ready');
    const subjects =
      file.format === 'epub' || file.format === 'kepub'
        ? (await readEpubMetadata(file.absolutePath).catch(() => undefined))?.subjects
        : (await this.read.findById(bookId))?.genreRows.map(({ name }) => name);
    const full = fractionToOrdinal(artifact.sentences, 1);
    const run: BookKnowledgeXrayRun = {
      runId,
      bookId,
      status: 'running',
      error: null,
      through: through ? Math.min(through, full) : full,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: [],
      privacy: { bookCharacters: 0, bookSentences: 0, sentCharacters: 0, distinctSentences: 0, distinctCharacters: 0 },
      counts: null,
      dryRun,
      estimate: null,
      mode: options.mode ?? modeFromSubjects(subjects ?? []),
      tieVote: null,
      passRepeats: null,
    };
    abort.signal.throwIfAborted();
    const stored: StoredRun = { run, payload: null, abort };
    return {
      stored,
      input: {
        stored,
        run,
        artifact,
        fingerprint,
        bookPath: file.absolutePath,
        fast,
        complete,
        dryRun,
        fresh: options.fresh ?? false,
        replayScope: options.replayScope,
        onProgress: options.onProgress,
      },
    };
  }

  /** Stops a running build: its model calls are aborted and nothing more is stored. A finished run is returned as it is. */
  cancel(runId: string): BookKnowledgeXrayRun {
    const stored = this.runs.get(runId);
    if (!stored) throw new NotFoundException('X-Ray run not found');
    if (stored.run.status !== 'running') return stored.run;
    stored.run.status = 'failed';
    stored.run.error = CANCELLED;
    stored.abort.abort(new AiError('cancelled', CANCELLED));
    this.logger.log(`[book_knowledge.xray_cancel] [end] runId=${runId} bookId=${stored.run.bookId} - X-Ray build cancelled`);
    return stored.run;
  }

  get(runId: string): BookKnowledgeXrayRun {
    const stored = this.runs.get(runId);
    if (!stored) throw new NotFoundException('X-Ray run not found');
    return stored.run;
  }

  payload(runId: string): BookKnowledgeXrayPayload {
    const stored = this.runs.get(runId);
    if (!stored?.payload) throw new NotFoundException('X-Ray payload not found');
    return stored.payload;
  }

  private keep(stored: StoredRun): void {
    this.runs.set(stored.run.runId, stored);
    while (this.runs.size > KEPT_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private async build(input: BuildInput): Promise<BookKnowledgeXrayPayload | null> {
    const { run, stored } = input;
    const ids = `runId=${run.runId} bookId=${run.bookId}`;
    const started = Date.now();
    this.logger.log(
      `[book_knowledge.xray] [start] ${ids} through=${run.through} dryRun=${run.dryRun} fast=${sanitizeLogValue(input.fast.model)} fresh=${input.fresh} - X-Ray build started`,
    );
    const calls = new XrayRunCalls(stored.abort);
    const opened: { store: XrayUnitStore | null } = { store: null };
    const closeStore = () => opened.store?.close();
    calls.signal.addEventListener('abort', closeStore, { once: true });
    try {
      calls.signal.throwIfAborted();
      const payload = await this.steps(input, ids, calls, opened);
      calls.signal.throwIfAborted();
      stored.payload = payload;
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      this.logger.log(
        `[book_knowledge.xray] [end] ${ids} durationMs=${Date.now() - started} entities=${payload?.entities.length ?? 0} ties=${payload?.ties.length ?? 0} links=${payload?.links.length ?? 0} summaries=${payload?.summaries?.length ?? 0} sentCharacters=${run.privacy.sentCharacters} bookCharacters=${run.privacy.bookCharacters} estimatedMinutes=${run.estimate?.minutes ?? 0} - X-Ray build completed`,
      );
      return payload;
    } catch (error) {
      const cancelled = run.error === CANCELLED;
      stored.abort.abort(error === undefined ? new Error('X-Ray build failed') : error);
      const failure: unknown = calls.signal.reason;
      closeStore();
      await calls.settled();
      await opened.store?.flush();
      run.status = 'failed';
      run.error = cancelled ? CANCELLED : failure instanceof Error ? failure.message : 'X-Ray build failed';
      run.finishedAt = new Date().toISOString();
      for (const step of run.steps) step.end ??= run.finishedAt;
      const stopped = failure instanceof AiJobPause ? 'paused' : cancelled ? CANCELLED : null;
      if (stopped) {
        this.logger.log(`[book_knowledge.xray] [end] ${ids} durationMs=${Date.now() - started} outcome=${stopped} - X-Ray build stopped`);
      } else {
        this.logger.error(
          `[book_knowledge.xray] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${failure instanceof Error ? failure.name : 'UnknownError'} error="${sanitizeLogValue(run.error.slice(0, 200))}" - X-Ray build failed`,
        );
      }
      throw failure;
    } finally {
      calls.signal.removeEventListener('abort', closeStore);
    }
  }

  private async steps(
    input: BuildInput,
    ids: string,
    calls: XrayRunCalls,
    opened: { store: XrayUnitStore | null },
  ): Promise<BookKnowledgeXrayPayload | null> {
    const { run, artifact, fingerprint, bookPath, fast, complete, dryRun, onProgress } = input;
    const through = run.through;
    const sentences = artifact.sentences;
    const text = await readBookText(bookPath);
    calls.signal.throwIfAborted();
    const anchors = new XrayAnchors(
      sentences.filter((sentence) => sentence.ordinal <= through),
      text.sections,
    );
    const store = dryRun ? null : await this.unitStore(input, ids);
    opened.store = store;
    calls.signal.throwIfAborted();
    const privacy = new XrayPrivacy(sentences);
    const syncPrivacy = () => {
      run.privacy.sentCharacters = privacy.sentCharacters;
      run.privacy.distinctSentences = privacy.sent.size;
      run.privacy.distinctCharacters = privacy.distinctCharacters();
    };
    const step = (id: BookKnowledgeXrayRun['steps'][number]['step']) => {
      const current = new XrayStepRun(id, 'fast', privacy, this.logger, ids, store ?? undefined);
      run.steps.push(current.record);
      this.logger.log(`[book_knowledge.xray_step] [start] ${ids} step=${id} slot=fast - step started`);
      return current;
    };
    const finish = (current: XrayStepRun) => {
      const record = current.finish();
      syncPrivacy();
      this.logger.log(
        `[book_knowledge.xray_step] [end] ${ids} step=${record.step} durationMs=${Date.parse(record.end!) - Date.parse(record.start)} units=${record.units} calls=${record.calls} invalid=${record.invalid} skipped=${record.skipped} replayed=${record.counts?.replayed ?? 0} sentences=${record.privacy.sentences} characters=${record.privacy.characters} - step completed`,
      );
    };
    const gate = limiter(DENSE_CONCURRENCY);
    const ask: AskWith = (use, system, user, maxOutputTokens, effort = XRAY_EFFORT, temperature) => {
      const request = { system, user, maxOutputTokens, effort, ...(temperature === undefined ? {} : { temperature }) };
      const signal = calls.signal;
      return replayable(
        () =>
          calls.track(
            gate(async () => {
              signal.throwIfAborted();
              try {
                const result = await complete({ ...request, use });
                signal.throwIfAborted();
                return result;
              } catch (error) {
                // Stop queued asks before the limiter hands this call's place to the next one.
                if (!retryable(error)) input.stored.abort.abort(error === undefined ? new Error('X-Ray build failed') : error);
                throw error;
              }
            }),
          ),
        {
          ...request,
          model: use.model,
          ...(input.replayScope === undefined ? {} : { replayScope: input.replayScope }),
        },
      );
    };

    const mode = run.mode ?? 'fiction';
    const reviews = planKindReview(artifact, reviewCheckpoint(sentences, through), mode, true);
    const answers = dryRun ? new Map<string, KindAnswer>() : await this.reviewKinds(reviews, step('kinds'), fast, ask, finish, onProgress);

    const dropped = { generic: 0, fragment: 0 };
    const entities = xrayEntities(artifact, through, answers, mode, undefined, dropped);
    const sections = bodySections(sentences, through);
    run.privacy.bookCharacters = sectionCharacters(sentences, sections);
    run.privacy.bookSentences = sections.reduce((sum, section) => sum + section.ordinals.length, 0);
    const units = passUnits(sentences, sections);
    const lastRead = sections.at(-1)?.s ?? -1;
    const full = fractionToOrdinal(sentences, 1);
    const counts: Record<string, number> = {
      entities: entities.length,
      kindBatches: reviews.length,
      units: units.length,
      linkCheckpoints: linkCheckpoints(sections).length,
      genericDropped: dropped.generic,
      fragmentDropped: dropped.fragment,
    };
    if (dryRun) {
      run.estimate = estimate(densePlannedCalls(reviews, units, entities, sentences, mode));
      run.counts = counts;
      return null;
    }

    const steps = {
      notes: step('notes'),
      facts: step('facts'),
      ties: step('ties'),
      alias: step('alias'),
      describe: step('describe'),
      now: step('now'),
      about: step('about'),
    };
    // A capped ask lowers the slot's own output limit, so upstream's client has no room to double into, and asks for no more than that.
    const dense: Ask = (request) => {
      const limit = request.capped ? Math.min(fast.maxOutputTokens ?? Infinity, request.maxOutputTokens) : request.maxOutputTokens;
      const send = ask(
        request.capped ? { ...fast, maxOutputTokens: limit } : fast,
        request.system,
        request.user,
        limit,
        request.effort,
        request.temperature,
      );
      return request.capped ? capped(send) : send;
    };
    onProgress?.('alias', 0, 0);
    const result = await runDense({
      entities,
      sentences,
      units,
      mode,
      ...steps,
      writesAbout: (slot: PassSlot) => slot.member === null && slot.head.importance <= 2,
      ask: dense,
      askAbout: dense,
      readDescription: async () => (await this.read.findById(run.bookId))?.book.book_metadata?.description ?? null,
      onUnit: onProgress && ((done, total) => onProgress('dense', done, total)),
    });
    onProgress?.('finish', 0, 0);
    for (const current of Object.values(steps)) finish(current);
    const links = windowLinks(result.cast, units, [...result.linkPairs, ...headingPairs(result.cast, sentences, units, mode)]);
    await store?.flush();
    if (store?.failedWrites)
      this.logger.warn(
        `[book_knowledge.xray_units] [fail] ${ids} durationMs=0 failedWrites=${store.failedWrites} errorClass=WriteError error="stored answers incomplete" - some answers were not stored`,
      );

    const parts = passPayload(result, mode, (ordinal) => anchors.at(ordinal), sentences);
    const spoilers = spoilerSweep(result.state, (unit) => namesAt(entities, unit.ordinals.at(-1)!));
    for (const spoiler of spoilers)
      this.logger.warn(
        `[book_knowledge.xray_spoiler] [fail] ${ids} field=${spoiler.field} id=${sanitizeLogValue(spoiler.id)} durationMs=0 errorClass=Spoiler error="${sanitizeLogValue(spoiler.names.join(', '))}" - text names a later entity`,
      );
    run.merges = result.cast.merges.map((merge) => ({
      rule: merge.rule,
      member: merge.member.name,
      head: merge.head.name,
      ordinal: merge.ordinal,
      mentions: merge.member.count,
      ...(merge.reason ? { reason: merge.reason } : {}),
    }));
    for (const merge of result.cast.merges)
      this.logger.log(
        `[book_knowledge.xray_merge] [end] ${ids} rule=${merge.rule} ordinal=${merge.ordinal} head="${sanitizeLogValue(merge.head.name)}" member="${sanitizeLogValue(merge.member.name)}"${merge.reason ? ` reason="${sanitizeLogValue(merge.reason)}"` : ''} - merged`,
      );
    const payload = xrayPayload(
      {
        fingerprint,
        builtAt: new Date().toISOString(),
        language: 'en',
        models: { fast: fast.model },
        coverage: Math.min(1, through / Math.max(1, full)),
        // A partial build names no section past the last one it read: a chapter title can give the story away.
        sections: text.sections.map((section): StoryGuideSectionInfo => ({
          s: section.index,
          title: through < full && section.index > lastRead ? null : (section.titles[0] ?? null),
          chars: section.text.length,
          h: section.hash,
        })),
        entities: parts.entities,
        ties: parts.ties,
        lines: parts.lines,
        facts: parts.facts,
        summaries: parts.summaries,
        links,
        chronicle: parts.chronicle,
        // A build that stops before the book's end says where; a skipped unit does not shorten it.
        ...(through < full && units.length ? { covers: unitEnd(units.at(-1)!, (ordinal) => anchors.at(ordinal)) } : {}),
      },
      (ordinal) => anchors.at(ordinal),
    );
    run.counts = {
      ...counts,
      ...stateCounts(result.state),
      heads: parts.entities.length,
      importance1: parts.entities.filter((entity) => entity.importance === 1).length,
      importance2: parts.entities.filter((entity) => entity.importance === 2).length,
      patternMerges: result.merged.pattern,
      modelMerges: result.merged.model,
      rewrites: result.rewrites,
      requiredKeys: result.required.keys,
      requiredFirst: result.required.first,
      requiredAfterRetry: result.required.retry,
      unitsWithSummary: new Set(result.state.summaries.map((summary) => summary.unit.id.split('c')[0])).size,
      spoilers: spoilers.length,
      payloadTies: payload.ties.length,
      links: payload.links.length,
      chronicleEntities: Object.keys(payload.chronicle?.entities ?? {}).length,
      chroniclePairs: Object.keys(payload.chronicle?.pairs ?? {}).length,
      anchorMisses: anchors.missed,
    };
    return payload;
  }

  /** The book's stored answers for this model and prompt version; a fresh build starts the file over. */
  private async unitStore(input: BuildInput, ids: string): Promise<XrayUnitStore> {
    const started = Date.now();
    const path = this.knowledge.xrayUnitsPath(input.run.bookId, input.fingerprint);
    const store = new XrayUnitStore(path, { fingerprint: input.fingerprint, promptVersion: DENSE_PROMPT_VERSION, model: input.fast.model });
    if (input.fresh) await store.reset();
    const loaded = input.fresh ? 0 : await store.load();
    if (store.damaged)
      this.logger.warn(
        `[book_knowledge.xray_units] [fail] ${ids} durationMs=${Date.now() - started} errorClass=CorruptFile error="stored answers cut short" - stored answers damaged, the first write rewrites them`,
      );
    this.logger.log(
      `[book_knowledge.xray_units] [end] ${ids} durationMs=${Date.now() - started} fresh=${input.fresh} loaded=${loaded} stale=${store.stale} damaged=${store.damaged} - stored answers ready`,
    );
    return store;
  }

  /** The LLM kind review, before the cast is built; answers apply to the entries it was asked about. */
  private async reviewKinds(
    batches: readonly KindReviewBatch[],
    current: XrayStepRun,
    use: AiModelChoice,
    ask: AskWith,
    finish: (current: XrayStepRun) => void,
    onProgress?: XrayBuildProgress,
  ): Promise<Map<string, KindAnswer>> {
    const answers = new Map<string, KindAnswer>();
    let done = 0;
    onProgress?.('kinds', 0, batches.length);
    const found = await inOrder([...batches.entries()], DENSE_CONCURRENCY, async ([index, batch]) => {
      const answer = await current.unit({
        id: `k${index + 1}`,
        ordinals: batch.ordinals,
        send: ask(use, KIND_REVIEW_SYSTEM, batch.user, KIND_REVIEW_MAX_TOKENS, XRAY_EFFORT, CLASSIFY_TEMPERATURE),
        read: (value) => {
          const parsed = parseReviewAnswers(JSON.stringify(value), batch.keys);
          return parsed?.size ? { items: parsed, rejected: {} } : null;
        },
      });
      onProgress?.('kinds', ++done, batches.length);
      return answer;
    });
    for (const batch of found) for (const [key, answer] of batch ?? []) answers.set(key, answer);
    finish(current);
    return answers;
  }
}
