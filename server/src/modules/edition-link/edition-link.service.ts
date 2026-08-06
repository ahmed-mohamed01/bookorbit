import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { EditionLinkCandidate } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { type BookModality, EditionLinkRepository } from './edition-link.repository';
import type { BookEditionLink } from './schema/edition-link.schema';

@Injectable()
export class EditionLinkService {
  private readonly logger = new Logger(EditionLinkService.name);

  constructor(
    private readonly repo: EditionLinkRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
  ) {}

  async getForBook(user: RequestUser, bookId: number): Promise<{ link: BookEditionLink | null; proposed: EditionLinkCandidate | null }> {
    await this.bookService.verifyBookAccess(bookId, user);

    const link = await this.repo.findLinkForBook(bookId);
    if (link) {
      // Don't leak a counterpart the user can no longer access (its id, creator, timestamp): verify the
      // other side with the same content-filter-aware check, and hide the link when it is inaccessible.
      const counterpartId = link.textBookId === bookId ? link.audioBookId : link.textBookId;
      if (!(await this.canAccess(counterpartId, user))) return { link: null, proposed: null };
      return { link, proposed: null };
    }

    const modality = await this.repo.getBookModality(bookId);
    if (modality !== 'text' && modality !== 'audio') {
      return { link: null, proposed: null };
    }

    const [proposed] = await this.findCandidates(user, bookId, modality);
    return { link: null, proposed: proposed ?? null };
  }

  async searchCandidates(user: RequestUser, bookId: number, query?: string): Promise<EditionLinkCandidate[]> {
    await this.bookService.verifyBookAccess(bookId, user);

    const modality = await this.repo.getBookModality(bookId);
    if (modality !== 'text' && modality !== 'audio') return [];

    return this.findCandidates(user, bookId, modality, query);
  }

  async link(user: RequestUser, bookId: number, counterpartId: number): Promise<BookEditionLink> {
    const startedAt = Date.now();
    this.logger.log(`[edition_link.link] [start] bookId=${bookId} counterpartId=${counterpartId} userId=${user.id} - edition link started`);

    try {
      if (bookId === counterpartId) {
        throw new BadRequestException('A book cannot be linked to itself');
      }

      await Promise.all([this.bookService.verifyBookAccess(bookId, user), this.bookService.verifyBookAccess(counterpartId, user)]);

      const [bookModality, counterpartModality] = await Promise.all([this.repo.getBookModality(bookId), this.repo.getBookModality(counterpartId)]);
      if (!this.areOppositeModalities(bookModality, counterpartModality)) {
        throw new BadRequestException('Edition links require one text book and one audiobook');
      }

      const [bookLink, counterpartLink] = await Promise.all([this.repo.findLinkForBook(bookId), this.repo.findLinkForBook(counterpartId)]);
      if (bookLink || counterpartLink) {
        throw new ConflictException('One or both books are already linked');
      }

      const textBookId = bookModality === 'text' ? bookId : counterpartId;
      const audioBookId = bookModality === 'audio' ? bookId : counterpartId;
      const link = await this.repo.insertLink(textBookId, audioBookId, user.id);
      if (!link) {
        throw new ConflictException('One or both books are already linked');
      }

      this.logger.log(
        `[edition_link.link] [end] bookId=${bookId} counterpartId=${counterpartId} userId=${user.id} linkId=${link.id} durationMs=${Date.now() - startedAt} - edition link completed`,
      );
      return link;
    } catch (err) {
      this.logFailure('edition_link.link', user.id, bookId, counterpartId, startedAt, err, 'edition link failed');
      throw err;
    }
  }

  async unlink(user: RequestUser, bookId: number): Promise<BookEditionLink> {
    const startedAt = Date.now();
    this.logger.log(`[edition_link.unlink] [start] bookId=${bookId} userId=${user.id} - edition unlink started`);

    try {
      // Verify access to the requested book BEFORE probing the link, so an inaccessible book returns the
      // same 403 whether or not it is linked (closes a 403-vs-404 link-existence probe). Unlinking severs
      // a global association affecting both records, so still require access to both sides.
      await this.bookService.verifyBookAccess(bookId, user);
      const link = await this.repo.findLinkForBook(bookId);
      if (!link) throw new NotFoundException('Edition link not found');
      const counterpartId = link.textBookId === bookId ? link.audioBookId : link.textBookId;
      await this.bookService.verifyBookAccess(counterpartId, user);

      const deleted = await this.repo.deleteLinkForBook(bookId);
      if (!deleted) throw new NotFoundException('Edition link not found');

      this.logger.log(
        `[edition_link.unlink] [end] bookId=${bookId} userId=${user.id} linkId=${deleted.id} durationMs=${Date.now() - startedAt} - edition unlink completed`,
      );
      return deleted;
    } catch (err) {
      this.logFailure('edition_link.unlink', user.id, bookId, null, startedAt, err, 'edition unlink failed');
      throw err;
    }
  }

  // Content-filter-aware access probe: true when the user may see the book, false when access is denied
  // or the book is filtered/missing. A transient error (e.g. DB blip) propagates rather than being read
  // as "no access".
  private async canAccess(bookId: number, user: RequestUser): Promise<boolean> {
    try {
      await this.bookService.verifyBookAccess(bookId, user);
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) return false;
      throw err;
    }
  }

  private async findCandidates(user: RequestUser, bookId: number, modality: 'text' | 'audio', query?: string): Promise<EditionLinkCandidate[]> {
    const accessibleLibraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    return this.repo.findCounterpartCandidates({
      bookId,
      modality,
      accessibleLibraryIds,
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
      query,
    });
  }

  private areOppositeModalities(left: BookModality, right: BookModality): boolean {
    return (left === 'text' && right === 'audio') || (left === 'audio' && right === 'text');
  }

  private logFailure(
    event: string,
    userId: number,
    bookId: number,
    counterpartId: number | null,
    startedAt: number,
    err: unknown,
    message: string,
  ): void {
    const errorClass = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const counterpartField = counterpartId === null ? '' : ` counterpartId=${counterpartId}`;
    this.logger.error(
      `[${event}] [fail] bookId=${bookId}${counterpartField} userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - ${message}`,
    );
  }
}
