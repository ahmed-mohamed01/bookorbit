import { Injectable, NotFoundException } from '@nestjs/common';
import type { BookKnowledgeTerm, BookKnowledgeTerms, BookKnowledgeTermDetail, BookKnowledgeScope } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookKnowledgeService } from './book-knowledge.service';
import { BookKnowledgeKindsService } from './book-knowledge-kinds.service';
import { rankTerms } from './core/term-ranking';
import { visibleTerm, histogram, oftenWith } from './core/artifact';
import { selectEvidence } from './core/evidence';
import { KnowledgeTermsDto } from './dto/book-knowledge.dto';
export function termResponse(term: BookKnowledgeTerm): BookKnowledgeTerm {
  return {
    key: term.key,
    displayName: term.displayName,
    aliases: term.aliases,
    type: term.type,
    kind: term.kind ?? null,
    kindSubtype: term.kindSubtype ?? null,
    junk: term.junk ?? false,
    count: term.count,
    first: term.first,
    latest: term.latest,
    score: term.score,
  };
}
@Injectable()
export class BookKnowledgeTermsService {
  constructor(
    private readonly knowledge: BookKnowledgeService,
    private readonly kinds: BookKnowledgeKindsService,
  ) {}
  async list(bookId: number, user: RequestUser, query: KnowledgeTermsDto): Promise<BookKnowledgeTerms> {
    const { artifact, info, fingerprint } = await this.knowledge.context(bookId, user, query.scope);
    const ranked = rankTerms(artifact, info.cutoffOrdinal);
    const kinds = await this.kinds.resolve(bookId, fingerprint, artifact, ranked, info.cutoffOrdinal);
    const terms = ranked
      .map((term) => ({ ...term, ...kinds.get(term.key) }))
      .filter(
        (term) =>
          (!query.type || term.type === query.type) &&
          (!query.q || [term.key, term.displayName, ...term.aliases].some((alias) => alias.toLowerCase().includes(query.q!.toLowerCase()))),
      );
    return {
      ...info,
      items: terms.slice(query.offset, query.offset + query.limit).map(termResponse),
      total: terms.length,
      offset: query.offset,
      limit: query.limit,
    };
  }
  async detail(bookId: number, user: RequestUser, key: string, scope: BookKnowledgeScope): Promise<BookKnowledgeTermDetail> {
    const { artifact, info, fingerprint } = await this.knowledge.context(bookId, user, scope);
    const term = visibleTerm(artifact, key, info.cutoffOrdinal);
    if (!term) throw new NotFoundException('Knowledge term not found');
    const all = rankTerms(artifact, info.cutoffOrdinal);
    const ranked = all.find((value) => value.key === term.key);
    const kind = (await this.kinds.resolve(bookId, fingerprint, artifact, all, info.cutoffOrdinal)).get(term.key);
    return {
      ...info,
      cutoffSpineIndex: artifact.sentences[Math.min(info.cutoffOrdinal, artifact.sentences.length) - 1]?.spineIndex ?? null,
      spineHrefs: [
        ...new Map(
          artifact.sentences
            .filter((s) => s.ordinal <= info.cutoffOrdinal && s.structure === 'body')
            .map((s) => [s.spineIndex, { spineIndex: s.spineIndex, href: s.href }]),
        ).values(),
      ],
      term: termResponse({ ...term, ...kind, score: ranked?.score ?? 0 }),
      histogram: histogram(artifact, key, info.cutoffOrdinal),
      related: oftenWith(artifact, key, info.cutoffOrdinal).map((value) => ({ ...value, label: 'often with' as const })),
      passages: selectEvidence(artifact, key, info.cutoffOrdinal),
    };
  }
}
