import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

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
import { READ_ALONG_OUTPUT_SOURCE, type ReadAlongAttachment, type ReadAlongOutputSource } from './read-along-output-source';
import type { BookEditionLink } from './schema/edition-link.schema';

export interface EditionLinkForBookResult {
  link: BookEditionLink | null;
  proposed: EditionLinkCandidate | null;
  counterpart: EditionLinkCounterpartSummary | null;
  role: EditionLinkRole | null;
  members: EditionLinkMembers | null;
  /** See `EditionLinkForBook.readAlongOutput`. */
  readAlongOutput?: boolean;
}

const ATTACH_EVENT = 'edition_link.attach_read_along';

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
    @Inject(READ_ALONG_OUTPUT_SOURCE) private readonly readAlongOutputs: ReadAlongOutputSource,
  ) {}

  async getForBook(user: RequestUser, bookId: number): Promise<EditionLinkForBookResult> {
    await this.bookService.verifyBookAccess(bookId, user);

    const link = await this.repo.findLinkForBook(bookId);
    if (link) return this.linkedView(user, bookId, link);

    const modality = await this.repo.getBookModality(bookId);
    if (modality !== 'text' && modality !== 'audio') {
      return unlinked();
    }
    if ((await this.readAlongOutputs.findReadAlongOutputs([bookId])).has(bookId)) {
      return (await this.detachedReadAlong(user, bookId)) ?? { ...unlinked(), readAlongOutput: true };
    }

    const [proposed] = await this.findCandidates(user, bookId, modality);
    return unlinked(proposed ?? null);
  }

  async searchCandidates(user: RequestUser, bookId: number, query?: string): Promise<EditionLinkCandidate[]> {
    await this.bookService.verifyBookAccess(bookId, user);

    const modality = await this.repo.getBookModality(bookId);
    if (modality !== 'text' && modality !== 'audio') return [];
    if ((await this.readAlongOutputs.findReadAlongOutputs([bookId])).has(bookId)) return [];

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
      // Checked on the build records, not the link: a read-along detached from its pair is still one.
      const outputs = await this.readAlongOutputs.findReadAlongOutputs([bookId, counterpartId]);
      if (outputs.size > 0 || bookLink?.readAlongBookId === bookId || counterpartLink?.readAlongBookId === counterpartId) {
        throw new BadRequestException('A generated read-along book cannot start an edition link');
      }
      if (bookLink || counterpartLink) {
        throw new ConflictException('One or both books are already linked');
      }

      const textBookId = bookModality === 'text' ? bookId : counterpartId;
      const audioBookId = bookModality === 'audio' ? bookId : counterpartId;
      const inserted = await this.repo.insertLink(textBookId, audioBookId, user.id);
      if (!inserted) {
        throw new ConflictException('One or both books are already linked');
      }
      // A pair relinked after an unlink gets back the read-along it generated, in the same request.
      const link = await this.attachLostReadAlong(inserted, user.id);
      const readAlongBookId = await this.visibleReadAlongId(link, bookId, user);

      this.logger.log(
        `[edition_link.link] [end] bookId=${bookId} counterpartId=${counterpartId} userId=${user.id} linkId=${link.id} durationMs=${Date.now() - startedAt} readAlongAttached=${link.readAlongBookId !== null} - edition link completed`,
      );
      return readAlongBookId === link.readAlongBookId ? link : { ...link, readAlongBookId };
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
      // link" - the text/audio pair it was built from stays linked. The detach is recorded on the build
      // first: a recorded detach on a link still carrying the book reads as attached, whereas an
      // unrecorded one would be healed back on the next read.
      const detaching = link.readAlongBookId === bookId;
      if (detaching) await this.readAlongOutputs.recordDetach(bookId, link.id);
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

  async attachReadAlongByUser(user: RequestUser, bookId: number, readAlongBookId: number): Promise<BookEditionLink> {
    const startedAt = Date.now();
    this.logger.log(
      `[${ATTACH_EVENT}] [start] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} - explicit read-along attach started`,
    );

    try {
      await this.bookService.verifyBookAccess(bookId, user);
      const link = await this.repo.findLinkForBook(bookId);
      if (!link || (link.textBookId !== bookId && link.audioBookId !== bookId)) {
        throw new NotFoundException('Edition link not found');
      }

      const otherBookId = link.textBookId === bookId ? link.audioBookId : link.textBookId;
      await this.bookService.verifyBookAccess(otherBookId, user);

      if (link.readAlongBookId !== null && link.readAlongBookId !== readAlongBookId) {
        throw new ConflictException('A different read-along is already attached');
      }
      if (link.readAlongBookId === readAlongBookId) {
        this.logger.log(
          `[${ATTACH_EVENT}] [end] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} linkId=${link.id} durationMs=${Date.now() - startedAt} outcome=already_attached - explicit read-along attach completed`,
        );
        return link;
      }

      const readAlong = await this.readAlongOutputs.findReadAlongForPair(link);
      if (!readAlong || readAlong.outputBookId !== readAlongBookId) {
        throw new NotFoundException('Generated read-along not found for this edition pair');
      }

      const updated = await this.attachReadAlong(link, readAlong, user.id);
      if (updated.readAlongBookId !== readAlongBookId) {
        throw new ConflictException('Read-along could not be attached');
      }

      this.logger.log(
        `[${ATTACH_EVENT}] [end] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} linkId=${updated.id} durationMs=${Date.now() - startedAt} outcome=attached - explicit read-along attach completed`,
      );
      return updated;
    } catch (err) {
      this.logFailure(ATTACH_EVENT, user.id, bookId, readAlongBookId, startedAt, err, 'explicit read-along attach failed');
      throw err;
    }
  }

  /**
   * Gives a link the read-along its pair generated when the link lost it, as an unlink and relink
   * leaves it. Idempotent, and never fails the caller: a link that cannot take its read-along is still
   * a link, so a failure is logged and the link returned as it was.
   */
  async attachLostReadAlong(link: BookEditionLink, userId: number): Promise<BookEditionLink> {
    if (link.readAlongBookId !== null) return link;
    const startedAt = Date.now();
    let lost: ReadAlongAttachment | null;
    try {
      lost = await this.readAlongOutputs.findLostReadAlong(link);
    } catch (err) {
      this.logAttachFailure(link.id, null, userId, startedAt, err);
      return link;
    }
    return lost ? this.attachReadAlong(link, lost, userId) : link;
  }

  /**
   * Puts a generated read-along on a link and records it on the build that made it. The link is
   * written first and only an empty slot or the same book is taken, so a stale caller never undoes a
   * detach; a stamp that then fails leaves an attached, unrecorded read-along, which is harmless
   * because a detach records itself. Never fails the caller; a failure is logged and the link
   * returned as it was.
   */
  async attachReadAlong(link: BookEditionLink, readAlong: ReadAlongAttachment, userId: number): Promise<BookEditionLink> {
    const startedAt = Date.now();
    const ids = `linkId=${link.id} buildId=${readAlong.buildId} outputBookId=${readAlong.outputBookId} userId=${userId}`;
    this.logger.log(`[${ATTACH_EVENT}] [start] ${ids} - read-along attach started`);
    try {
      const updated = await this.repo.setReadAlongBook(link.id, readAlong.outputBookId);
      if (updated) await this.readAlongOutputs.recordAttachment(readAlong.buildId, link.id);
      this.logger.log(
        `[${ATTACH_EVENT}] [end] ${ids} durationMs=${Date.now() - startedAt} attached=${updated !== undefined} - read-along attach completed`,
      );
      return updated ?? link;
    } catch (err) {
      this.logAttachFailure(link.id, readAlong, userId, startedAt, err);
      return link;
    }
  }

  private logAttachFailure(linkId: number, readAlong: ReadAlongAttachment | null, userId: number, startedAt: number, err: unknown): void {
    const errorClass = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const buildField = readAlong ? ` buildId=${readAlong.buildId} outputBookId=${readAlong.outputBookId}` : '';
    this.logger.warn(
      `[${ATTACH_EVENT}] [fail] linkId=${linkId}${buildField} userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - read-along attach failed`,
    );
  }

  private async linkedView(user: RequestUser, bookId: number, found: BookEditionLink): Promise<EditionLinkForBookResult> {
    // The text/audio pair IS the link: if either side is inaccessible the whole link is hidden. The
    // read-along is an optional extra member, so losing access to it only masks that member - its id
    // is stripped from the returned row so an inaccessible book is never leaked through it.
    const pairIds = [found.textBookId, found.audioBookId].filter((id) => id !== bookId);
    const pairAccess = await Promise.all(pairIds.map((id) => this.canAccess(id, user)));
    if (pairAccess.some((allowed) => !allowed)) return unlinked();

    const link = await this.attachLostReadAlong(found, user.id);
    const readAlongBookId = await this.visibleReadAlongId(link, bookId, user);
    const role = this.resolveRole(link, bookId);
    const { members, summaries } = await this.resolveMembers(user, link.textBookId, link.audioBookId, readAlongBookId);
    const counterpart = (role === 'audio' ? summaries.get(link.textBookId) : summaries.get(link.audioBookId)) ?? null;
    const visibleLink = readAlongBookId === link.readAlongBookId ? link : { ...link, readAlongBookId };
    return { link: visibleLink, proposed: null, counterpart, role, members };
  }

  /**
   * A read-along detached from its pair stays matched to the pair it was built from, so its page can
   * offer to link that pair again. Offered only while both sides are visible to the user and neither
   * is linked elsewhere; the pair is linked through its own books, never through the read-along.
   */
  private async detachedReadAlong(user: RequestUser, bookId: number): Promise<EditionLinkForBookResult | null> {
    const pair = await this.readAlongOutputs.findSourcePair(bookId);
    if (!pair) return null;
    const access = await Promise.all([this.canAccess(pair.textBookId, user), this.canAccess(pair.audioBookId, user)]);
    if (access.some((allowed) => !allowed)) return null;
    const [textLink, audioLink] = await Promise.all([this.repo.findLinkForBook(pair.textBookId), this.repo.findLinkForBook(pair.audioBookId)]);
    if (textLink || audioLink) {
      // Linked as it was built but without this read-along: it rejoins, unless it was detached on purpose.
      const pairLink = textLink && textLink.textBookId === pair.textBookId && textLink.audioBookId === pair.audioBookId ? textLink : null;
      if (!pairLink) return null;
      const healed = await this.attachLostReadAlong(pairLink, user.id);
      return healed.readAlongBookId === bookId ? this.linkedView(user, bookId, healed) : null;
    }

    const { members } = await this.resolveMembers(user, pair.textBookId, pair.audioBookId, bookId);
    return { link: null, proposed: null, counterpart: null, role: 'readAlong', members };
  }

  private async resolveMembers(
    user: RequestUser,
    textBookId: number,
    audioBookId: number,
    readAlongBookId: number | null,
  ): Promise<{ members: EditionLinkMembers; summaries: Map<number, EditionLinkCounterpartSummary> }> {
    const [summaries, progress] = await Promise.all([
      this.repo.findBookSummaries(readAlongBookId === null ? [textBookId, audioBookId] : [textBookId, audioBookId, readAlongBookId]),
      this.repo.findMemberProgress(user.id, { textBookId, audioBookId, readAlongBookId }),
    ]);
    const members: EditionLinkMembers = {
      text: toMember(textBookId, summaries.get(textBookId) ?? null, progress.text, null),
      audio: toMember(audioBookId, summaries.get(audioBookId) ?? null, progress.audio, null),
      readAlong:
        readAlongBookId === null
          ? null
          : toMember(readAlongBookId, summaries.get(readAlongBookId) ?? null, progress.readAlong, progress.readAlongNarrationPercentage),
    };
    return { members, summaries };
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
    const candidates = await this.repo.findCounterpartCandidates({
      bookId,
      modality,
      accessibleLibraryIds,
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
      query,
    });
    // A read-along is text with the same title and author as its audiobook, so it would otherwise be
    // the audiobook's best match.
    const outputs = await this.readAlongOutputs.findReadAlongOutputs(candidates.map((candidate) => candidate.bookId));
    return outputs.size === 0 ? candidates : candidates.filter((candidate) => !outputs.has(candidate.bookId));
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
