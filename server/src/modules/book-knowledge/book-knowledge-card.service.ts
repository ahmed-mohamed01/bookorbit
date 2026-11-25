import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { knowledgeOperation } from './book-knowledge-logging';
import { createHash } from 'node:crypto';
import type { BookKnowledgeCardResponse, BookKnowledgeScope } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeModelService, READER_MODEL_TIMEOUT_MS } from './book-knowledge-model.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { visibleTerm } from './core/artifact';
import { cardCutoff } from './core/cutoff';
import { selectEvidence } from './core/evidence';
import { CARD_PROMPT_VERSION } from './core/versions';
import { checkCard, evidenceFloor } from './book-knowledge-checks';
import { CARD_SCHEMA, evidencePrompt, evidenceCharacterBudget } from './book-knowledge-prompts';
@Injectable()
export class BookKnowledgeCardService {
  private readonly logger = new Logger(BookKnowledgeCardService.name);
  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly model: BookKnowledgeModelService,
    private readonly repo: BookKnowledgeRepository,
  ) {}
  async card(bookId: number, user: RequestUser, key: string, scope: BookKnowledgeScope, hangUp: AbortSignal): Promise<BookKnowledgeCardResponse> {
    return knowledgeOperation(this.logger, 'book_knowledge.card', `bookId=${bookId} userId=${user.id}`, async () => {
      const { artifact, info, fingerprint } = await this.knowledge.context(bookId, user, scope);
      const term = visibleTerm(artifact, key, info.cutoffOrdinal);
      if (!term) throw new NotFoundException('Knowledge term not found');
      const cutoff = cardCutoff(artifact.sentences, info.cutoffOrdinal, term.first);
      const visible = visibleTerm(artifact, key, cutoff);
      const aliases = [...new Set(visible?.mentions.map((mention) => mention.alias) ?? [])];
      const task = `Explain the meaning of ${JSON.stringify(visible?.displayName ?? term.key)} (visible aliases: ${JSON.stringify(aliases)}) in this book in one or two sentences.`;
      const passages = selectEvidence(artifact, key, cutoff, { maxCharacters: evidenceCharacterBudget(task) });
      const definition = visibleTerm(artifact, key, cutoff)?.mentions.some((m) => m.definition) ?? false;
      if (evidenceFloor(passages, definition))
        return {
          ...info,
          cutoffOrdinal: cutoff,
          passages,
          card: { meaning: 'Insufficient evidence in the passages read.', meaningQuote: '', meaningPassage: 0, points: [], insufficient: true },
          checks: { meaningVerified: false, droppedPoints: 0, unknownPassage: false },
        };
      const config = await this.model.choiceWithSnapshot();
      if (!config) throw new ServiceUnavailableException('Book Knowledge model is not configured');
      const { choice, snapshot } = config;
      const evidenceHash = createHash('sha256')
        .update(JSON.stringify({ task, passages, effort: choice.effort ?? 'low' }))
        .digest('hex');
      const identity = {
        bookId,
        fingerprint,
        termKey: term.key,
        cutoffOrdinal: cutoff,
        model: choice.model,
        promptVersion: CARD_PROMPT_VERSION,
        evidenceHash,
      };
      const cached = await this.repo.cached(identity);
      if (cached) return { ...info, cutoffOrdinal: cutoff, passages, card: cached.card, checks: cached.checks };
      await this.model.checkReaderCap(user, snapshot, choice);
      const signal = AbortSignal.any([AbortSignal.timeout(READER_MODEL_TIMEOUT_MS), hangUp]);
      const raw = await this.model.generate(evidencePrompt(task, passages), CARD_SCHEMA, choice, { signal, userId: user.id });
      const checked = checkCard(raw, passages, aliases);
      await this.repo.cache({ ...identity, ...checked });
      return { ...info, cutoffOrdinal: cutoff, passages, ...checked };
    });
  }
}
