import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BookKnowledgeKind, BookKnowledgeKindSubtype, BookKnowledgeTermType } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookKnowledgeModelService, CLASSIFY_TEMPERATURE } from './book-knowledge-model.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import {
  KIND_REVIEW_MAX_TOKENS,
  KIND_REVIEW_SYSTEM,
  isReviewCandidate,
  parseReviewAnswers,
  reviewBatches,
  reviewCheckpoint,
  selectForReview,
  type KindAnswer,
  type KindReviewBatch,
} from './core/kind-review';
import { termKinds, type KindDecision } from './core/kinds';
import { rankTerms } from './core/term-ranking';
import type { Artifact, VisibleTerm } from './core/model';

export interface ServedKind {
  type: BookKnowledgeTermType;
  kind: BookKnowledgeKind | null;
  kindSubtype: BookKnowledgeKindSubtype | null;
  junk: boolean;
}
export interface PlannedBatch extends KindReviewBatch {
  hash: string;
}
interface ReviewJob {
  bookId: number;
  fingerprint: string;
  cutoff: number;
  batches: PlannedBatch[];
}
const MAX_QUEUED_JOBS = 4;
export const REVIEW_EFFORT = 'low';

export function servedKind(fallback: BookKnowledgeTermType, decision?: KindDecision, answer?: KindAnswer): ServedKind {
  const kind = answer ?? decision?.kind ?? null;
  const subtype = answer ? null : (decision?.subtype ?? null);
  if (kind === null || kind === 'junk') return { type: fallback, kind: null, kindSubtype: null, junk: kind === 'junk' };
  const type: BookKnowledgeTermType = kind === 'person' || kind === 'animal' ? 'person' : kind === 'place' ? 'place' : 'concept';
  return { type, kind, kindSubtype: subtype, junk: false };
}

@Injectable()
export class BookKnowledgeKindsService {
  private readonly logger = new Logger(BookKnowledgeKindsService.name);
  private readonly queue: ReviewJob[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  constructor(
    private readonly model: BookKnowledgeModelService,
    private readonly repo: BookKnowledgeRepository,
  ) {}

  async resolve(
    bookId: number,
    fingerprint: string,
    artifact: Artifact,
    ranked: readonly VisibleTerm[],
    cutoff: number,
  ): Promise<Map<string, ServedKind>> {
    const decisions = termKinds(artifact, ranked, cutoff);
    const answers = new Map<string, KindAnswer>();
    const config = await this.model.choice();
    if (config) {
      const checkpoint = reviewCheckpoint(artifact.sentences, cutoff);
      const batches = this.plan(artifact, checkpoint, config.model);
      const cached = await this.repo.kindReviews(
        bookId,
        fingerprint,
        batches.map((batch) => batch.hash),
      );
      const found = new Map(cached.map((row) => [row.requestHash, row.answers]));
      for (const batch of batches)
        for (const [key, answer] of Object.entries(found.get(batch.hash) ?? {})) {
          const current = decisions.get(key);
          if (current && isReviewCandidate(current)) answers.set(key, answer as KindAnswer);
        }
      const missing = batches.filter((batch) => !found.has(batch.hash));
      if (missing.length) this.enqueue({ bookId, fingerprint, cutoff: checkpoint, batches: missing });
    }
    return new Map(ranked.map((term) => [term.key, servedKind(term.type, decisions.get(term.key), answers.get(term.key))]));
  }

  // Awaitable review of the same batches the background job would send; cached batches are not sent again.
  async review(bookId: number, fingerprint: string, artifact: Artifact, cutoff: number): Promise<number> {
    const config = await this.model.choice();
    if (!config) return 0;
    const checkpoint = reviewCheckpoint(artifact.sentences, cutoff);
    const batches = this.plan(artifact, checkpoint, config.model);
    const cached = new Set(
      (
        await this.repo.kindReviews(
          bookId,
          fingerprint,
          batches.map((batch) => batch.hash),
        )
      ).map((row) => row.requestHash),
    );
    return this.run({ bookId, fingerprint, cutoff: checkpoint, batches: batches.filter((batch) => !cached.has(batch.hash)) });
  }

  // The whole review is computed at the checkpoint, never at the reader's own position.
  plan(artifact: Artifact, cutoff: number, model: string): PlannedBatch[] {
    if (cutoff < 1) return [];
    const ranked = rankTerms(artifact, cutoff);
    const decisions = termKinds(artifact, ranked, cutoff);
    const entries = selectForReview(ranked, decisions);
    if (!entries.length) return [];
    const terms = new Map(ranked.map((term) => [term.key, term]));
    return reviewBatches(artifact, entries, terms, decisions, cutoff).map((batch) => ({
      ...batch,
      hash: createHash('sha256')
        .update(JSON.stringify([model, REVIEW_EFFORT, CLASSIFY_TEMPERATURE, KIND_REVIEW_SYSTEM, batch.user]))
        .digest('hex'),
    }));
  }

  private enqueue(job: ReviewJob) {
    const id = `${job.bookId}:${job.fingerprint}:${job.batches.map((batch) => batch.hash).join(',')}`;
    if (this.queued.has(id) || this.queue.length >= MAX_QUEUED_JOBS) return;
    this.queued.add(id);
    this.queue.push(job);
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) await this.run(next).catch(() => undefined);
      } finally {
        this.queued.clear();
        this.running = false;
      }
    })();
  }

  private async run(job: ReviewJob): Promise<number> {
    const config = await this.model.choice();
    if (!job.batches.length || !config) return 0;
    const started = Date.now();
    const ids = `bookId=${job.bookId} cutoff=${job.cutoff}`;
    this.logger.log(`[book_knowledge.kind_review] [start] ${ids} batches=${job.batches.length} - kind review started`);
    let calls = 0;
    let answered = 0;
    try {
      for (const batch of job.batches) {
        let answers: Map<string, KindAnswer> | undefined;
        for (let attempt = 0; attempt < 2 && !answers; attempt++) {
          calls++;
          const raw = await this.model.chat(KIND_REVIEW_SYSTEM, batch.user, KIND_REVIEW_MAX_TOKENS, config, { temperature: CLASSIFY_TEMPERATURE });
          answers = parseReviewAnswers(raw, batch.keys);
        }
        if (!answers) continue;
        answered += answers.size;
        await this.repo.saveKindReview({
          bookId: job.bookId,
          fingerprint: job.fingerprint,
          requestHash: batch.hash,
          answers: Object.fromEntries(answers),
        });
      }
      this.logger.log(
        `[book_knowledge.kind_review] [end] ${ids} durationMs=${Date.now() - started} calls=${calls} answered=${answered} - kind review completed`,
      );
      return calls;
    } catch (error) {
      this.logger.warn(
        `[book_knowledge.kind_review] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - kind review failed`,
      );
      throw error;
    }
  }
}
