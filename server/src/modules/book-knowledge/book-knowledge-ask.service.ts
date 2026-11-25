import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { knowledgeOperation } from './book-knowledge-logging';
import type { BookKnowledgeAskResponse, BookKnowledgeScope } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { termQuestion } from './book-knowledge-question';
import { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeModelService, READER_MODEL_TIMEOUT_MS } from './book-knowledge-model.service';
import { checkAnswer } from './book-knowledge-checks';
import { ANSWER_SCHEMA, answerPrompt } from './book-knowledge-prompts';
import { retrieve } from './book-knowledge-retrieval';
import { activeAliases } from './core/artifact';
@Injectable()
export class BookKnowledgeAskService {
  private readonly logger = new Logger(BookKnowledgeAskService.name);
  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly model: BookKnowledgeModelService,
  ) {}
  async ask(bookId: number, user: RequestUser, question: string, scope: BookKnowledgeScope, hangUp: AbortSignal): Promise<BookKnowledgeAskResponse> {
    return knowledgeOperation(this.logger, 'book_knowledge.ask', `bookId=${bookId} userId=${user.id}`, async () => {
      const { artifact, info } = await this.knowledge.context(bookId, user, scope);
      const key = termQuestion(artifact, info.cutoffOrdinal, question);
      const route = key ? 'term' : 'search';
      const passages = retrieve(artifact, info.cutoffOrdinal, question, key ?? undefined);
      if (passages.length === 0)
        return {
          ...info,
          passages,
          route,
          answer: { answer: 'Insufficient evidence in the passages read.', points: [], notInBook: true },
          checks: { meaningVerified: false, droppedPoints: 0, unknownPassage: false },
        };
      const config = await this.model.choiceWithSnapshot();
      if (!config) throw new ServiceUnavailableException('Book Knowledge model is not configured');
      const { choice, snapshot } = config;
      await this.model.checkReaderCap(user, snapshot, choice);
      const signal = AbortSignal.any([AbortSignal.timeout(READER_MODEL_TIMEOUT_MS), hangUp]);
      const raw = await this.model.generate(answerPrompt(question, passages, Boolean(key)), ANSWER_SCHEMA, choice, { signal, userId: user.id });
      const aliases = key ? activeAliases(artifact, key, info.cutoffOrdinal) : [];
      return {
        ...info,
        passages,
        route,
        ...checkAnswer(raw, passages, aliases),
      };
    });
  }
}
