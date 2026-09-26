import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  EditionLinkCandidate,
  EditionLinkCounterpartSummary,
  EditionLinkMember,
  EditionLinkMemberProgress,
  EditionLinkMembers,
  EditionLinkRole,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { type BookModality, EditionLinkRepository, type EditionLinkMemberProgressRow } from './edition-link.repository';
import type { BookEditionLink } from './schema/edition-link.schema';

export interface EditionLinkForBookResult {
  link: BookEditionLink | null;
  proposed: EditionLinkCandidate | null;
  counterpart: EditionLinkCounterpartSummary | null;
  role: EditionLinkRole | null;
  members: EditionLinkMembers | null;
}

function unlinked(proposed: EditionLinkCandidate | null = null): EditionLinkForBookResult {
  return { link: null, proposed, counterpart: null, role: null, members: null };
}

function toMemberProgress(row: EditionLinkMemberProgressRow | null): EditionLinkMemberProgress | null {
  if (!row) return null;
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return { percentage: row.percentage, updatedAt };
}

function toMember(
  id: number,
  summary: EditionLinkCounterpartSummary | null,
  progress: EditionLinkMemberProgressRow | null,
  narrationPercentage: number | null,
): EditionLinkMember {
  return {
    id,
    title: summary?.title ?? null,
    authorName: summary?.authorName ?? null,
    coverVersion: summary?.coverVersion ?? null,
    progress: toMemberProgress(progress),
    narrationPercentage,
  };
}

@Injectable()
export class EditionLinkService {
  private readonly logger = new Logger(EditionLinkService.name);

  constructor(
    private readonly repo: EditionLinkRepository,
    private readonly bookService: BookService,
    private readonly libraryService: LibraryService,
  ) {}

  async getForBook(user: RequestUser, bookId: number): Promise<EditionLinkForBookResult> {
    await this.bookService.verifyBookAccess(bookId, user);

    const link = await this.repo.findLinkForBook(bookId);
    if (link) {
      // The text/audio pair IS the link: if either side is inaccessible the whole link is hidden. The
      // read-along is an optional extra member, so losing access to it only masks that member - its id
      // is stripped from the returned row so an inaccessible book is never leaked through it.
      const pairIds = [link.textBookId, link.audioBookId].filter((id) => id !== bookId);
      const pairAccess = await Promise.all(pairIds.map((id) => this.canAccess(id, user)));
      if (pairAccess.some((allowed) => !allowed)) return unlinked();

      const readAlongBookId = await this.visibleReadAlongId(link, bookId, user);
      const role = this.resolveRole(link, bookId);
      const [summaries, progress] = await Promise.all([
        this.repo.findBookSummaries(
          readAlongBookId === null ? [link.textBookId, link.audioBookId] : [link.textBookId, link.audioBookId, readAlongBookId],
        ),
        this.repo.findMemberProgress(user.id, { textBookId: link.textBookId, audioBookId: link.audioBookId, readAlongBookId }),
      ]);

      const textSummary = summaries.get(link.textBookId) ?? null;
      const audioSummary = summaries.get(link.audioBookId) ?? null;
      const members: EditionLinkMembers = {
        text: toMember(link.textBookId, textSummary, progress.text, null),
        audio: toMember(link.audioBookId, audioSummary, progress.audio, null),
        readAlong:
          readAlongBookId === null
            ? null
            : toMember(readAlongBookId, summaries.get(readAlongBookId) ?? null, progress.readAlong, progress.readAlongNarrationPercentage),
      };
      const counterpart = role === 'audio' ? textSummary : audioSummary;
      const visibleLink = readAlongBookId === link.readAlongBookId ? link : { ...link, readAlongBookId };
      return { link: visibleLink, proposed: null, counterpart, role, members };
    }

    const modality = await this.repo.getBookModality(bookId);
    if (modality !== 'text' && modality !== 'audio') {
      return unlinked();
    }

    const [proposed] = await this.findCandidates(user, bookId, modality);
    return unlinked(proposed ?? null);
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
      if (bookLink?.readAlongBookId === bookId || counterpartLink?.readAlongBookId === counterpartId) {
        throw new BadRequestException('A generated read-along book cannot start an edition link');
      }
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
      // same 403 whether or not it is linked (closes a 403-vs-404 link-existence probe). The text/audio
      // pair IS the link, so both sides gate the unlink; the read-along is not consulted, because
      // dropping the row never touches that book and it normally lives in an admin-only library the
      // reader cannot open - demanding access to it would fail every unlink getForBook offers.
      await this.bookService.verifyBookAccess(bookId, user);
      const link = await this.repo.findLinkForBook(bookId);
      if (!link) throw new NotFoundException('Edition link not found');
      const pairIds = [link.textBookId, link.audioBookId].filter((id) => id !== bookId);
      await Promise.all(pairIds.map((id) => this.bookService.verifyBookAccess(id, user)));

      // From the read-along's own page, unlinking means "this generated book is no longer part of that
      // link" - the text/audio pair it was built from stays linked.
      const detaching = link.readAlongBookId === bookId;
      const updated = detaching ? await this.repo.setReadAlongBook(link.id, null) : await this.repo.deleteLink(link.id);
      if (!updated) throw new NotFoundException('Edition link not found');

      this.logger.log(
        `[edition_link.unlink] [end] bookId=${bookId} userId=${user.id} linkId=${updated.id} durationMs=${Date.now() - startedAt} outcome=${detaching ? 'read_along_detached' : 'link_deleted'} - edition unlink completed`,
      );
      return updated;
    } catch (err) {
      this.logFailure('edition_link.unlink', user.id, bookId, null, startedAt, err, 'edition unlink failed');
      throw err;
    }
  }

  private async visibleReadAlongId(link: BookEditionLink, bookId: number, user: RequestUser): Promise<number | null> {
    if (link.readAlongBookId === null) return null;
    if (link.readAlongBookId === bookId) return link.readAlongBookId;
    return (await this.canAccess(link.readAlongBookId, user)) ? link.readAlongBookId : null;
  }

  private resolveRole(link: BookEditionLink, bookId: number): EditionLinkRole | null {
    if (link.textBookId === bookId) return 'text';
    if (link.audioBookId === bookId) return 'audio';
    if (link.readAlongBookId === bookId) return 'readAlong';
    return null;
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
