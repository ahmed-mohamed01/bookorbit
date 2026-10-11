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
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { type BookModality, EditionLinkRepository, type EditionLinkMemberProgressRow, type ReadingPercentageTarget } from './edition-link.repository';
import {
  READ_ALONG_OUTPUT_SOURCE,
  type ReadAlongAttachment,
  type ReadAlongBuildProposal,
  type ReadAlongOutputSource,
} from './read-along-output-source';
import type { BookEditionLink } from './schema/edition-link.schema';

export interface EditionLinkForBookResult {
  link: BookEditionLink | null;
  proposed: EditionLinkCandidate | null;
  counterpart: EditionLinkCounterpartSummary | null;
  role: EditionLinkRole | null;
  members: EditionLinkMembers | null;
  thisBookProgress: number | null;
  /** See `EditionLinkForBook.pickedProgress`. */
  pickedProgress?: number | null;
  /** See `EditionLinkForBook.readAlongOutput`. */
  readAlongOutput?: boolean;
}

type ForBookView = Omit<EditionLinkForBookResult, 'thisBookProgress' | 'pickedProgress'> & { pickedBookId?: number };

const UNFINISHED_BUILD_STATUSES = new Set(['queued', 'building', 'failed']);

const ATTACH_EVENT = 'edition_link.attach_read_along';
const RESTORE_EVENT = 'edition_link.restore_read_along';

function unlinked(proposed: EditionLinkCandidate | null = null): ForBookView {
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

  /**
   * `counterpartId` is the audiobook an unlinked ebook page has on screen, which may differ from the
   * proposal; the read-along it already carries is shown for it.
   */
  async getForBook(user: RequestUser, bookId: number, counterpartId?: number): Promise<EditionLinkForBookResult> {
    await this.bookService.verifyBookAccess(bookId, user);

    const link = await this.repo.findLinkForBook(bookId);
    // A proposal beside a link is always an ebook for its audiobook.
    if (link) return this.withProgress(user, { bookId, audio: link.audioBookId === bookId }, false, await this.linkedView(user, bookId, link));

    const modality = await this.repo.getBookModality(bookId);
    const page = { bookId, audio: modality === 'audio' };
    if (modality !== 'text' && modality !== 'audio') {
      return this.withProgress(user, page, false, unlinked());
    }
    if ((await this.readAlongOutputs.findReadAlongOutputs([bookId])).has(bookId)) {
      return this.withProgress(user, page, false, (await this.detachedReadAlong(user, bookId)) ?? { ...unlinked(), readAlongOutput: true });
    }
    if (modality === 'audio') {
      return this.withProgress(user, page, false, unlinked(await this.proposeEbook(user, bookId)));
    }
    return this.withProgress(user, page, true, await this.unlinkedTextView(user, bookId, counterpartId));
  }

  private async unlinkedTextView(user: RequestUser, bookId: number, counterpartId: number | undefined): Promise<ForBookView> {
    const [candidates, build] = await Promise.all([this.findCandidates(user, bookId, 'text'), this.readAlongOutputs.findNewestBuildForText(bookId)]);
    // A read-along built for this ebook names the audiobook the reader chose, so that pairing stays on
    // screen across reloads ahead of the similarity guess.
    const buildProposal = build && (await this.isProposable(build)) ? await this.buildProposal(user, build.audioBookId, candidates, 'audio') : null;
    const proposed = buildProposal ?? candidates[0] ?? null;
    const honoured = counterpartId !== undefined && (counterpartId === proposed?.bookId || (await this.canAccess(counterpartId, user)));
    const pickedId = honoured ? counterpartId : proposed?.bookId;
    const view = await this.pickedAudioView(user, bookId, proposed, pickedId);
    return honoured ? { ...view, pickedBookId: pickedId } : view;
  }

  private async pickedAudioView(
    user: RequestUser,
    bookId: number,
    proposed: EditionLinkCandidate | null,
    pickedId: number | undefined,
  ): Promise<ForBookView> {
    if (pickedId === undefined) return unlinked(proposed);

    // The audiobook may already carry a read-along on a link with no ebook: the ebook page shows that
    // pair as it is, so the switch for the read-along reads linked rather than empty.
    const audioLink = await this.repo.findLinkForBook(pickedId);
    if (!audioLink || audioLink.audioBookId !== pickedId || audioLink.textBookId !== null || audioLink.readAlongBookId === null) {
      return unlinked(proposed);
    }
    const readAlongBookId = await this.visibleReadAlongId(audioLink, bookId, user);
    if (readAlongBookId === null) return unlinked(proposed);
    const { members } = await this.resolveMembers(user, null, pickedId, readAlongBookId);
    return { ...unlinked(proposed), members };
  }

  private async proposeEbook(user: RequestUser, audioBookId: number): Promise<EditionLinkCandidate | null> {
    const [candidates, build] = await Promise.all([
      this.findCandidates(user, audioBookId, 'audio'),
      this.readAlongOutputs.findNewestBuildForAudio(audioBookId),
    ]);
    const buildProposal = build && (await this.isProposable(build)) ? await this.buildProposal(user, build.textBookId, candidates, 'text') : null;
    return buildProposal ?? candidates[0] ?? null;
  }

  /**
   * A build keeps its pair on screen while it is unfinished, and after it finished until its output
   * sits on a link, so the reader can still attach what it made.
   */
  private async isProposable(build: ReadAlongBuildProposal): Promise<boolean> {
    if (UNFINISHED_BUILD_STATUSES.has(build.status)) return true;
    return build.status === 'ready' && build.outputBookId !== null && !(await this.repo.findLinkForBook(build.outputBookId));
  }

  private async buildProposal(
    user: RequestUser,
    counterpartId: number,
    candidates: EditionLinkCandidate[],
    counterpartSide: 'text' | 'audio',
  ): Promise<EditionLinkCandidate | null> {
    if (!(await this.canAccess(counterpartId, user))) return null;
    const counterpartLink = await this.repo.findLinkForBook(counterpartId);
    if (
      counterpartSide === 'audio'
        ? counterpartLink && (counterpartLink.audioBookId !== counterpartId || counterpartLink.textBookId !== null)
        : counterpartLink
    ) {
      return null;
    }
    const candidate = candidates.find((entry) => entry.bookId === counterpartId);
    if (candidate) return { ...candidate, fromBuild: true };
    const summary = (await this.repo.findBookSummaries([counterpartId])).get(counterpartId);
    if (!summary) return null;
    if ((await this.readAlongOutputs.findReadAlongOutputs([counterpartId])).has(counterpartId)) return null;
    return {
      bookId: counterpartId,
      title: summary.title,
      authorName: summary.authorName,
      coverVersion: summary.coverVersion,
      score: 0,
      fromBuild: true,
    };
  }

  private async withProgress(
    user: RequestUser,
    page: ReadingPercentageTarget,
    proposedAudio: boolean,
    view: ForBookView,
  ): Promise<EditionLinkForBookResult> {
    const { proposed, pickedBookId, ...rest } = view;
    const targets: ReadingPercentageTarget[] = [page];
    if (proposed) targets.push({ bookId: proposed.bookId, audio: proposedAudio });
    if (pickedBookId !== undefined && pickedBookId !== proposed?.bookId) targets.push({ bookId: pickedBookId, audio: true });
    const percentages = await this.repo.findReadingPercentages(user.id, targets);
    return {
      ...rest,
      proposed: proposed && { ...proposed, progress: percentages.get(proposed.bookId) ?? null },
      thisBookProgress: percentages.get(page.bookId) ?? null,
      ...(pickedBookId === undefined ? {} : { pickedProgress: percentages.get(pickedBookId) ?? null }),
    };
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
      const textBookId = bookModality === 'text' ? bookId : counterpartId;
      const audioBookId = bookModality === 'audio' ? bookId : counterpartId;
      const textLink = textBookId === bookId ? bookLink : counterpartLink;
      const audioLink = audioBookId === bookId ? bookLink : counterpartLink;
      // An audiobook linked to a read-along alone takes the ebook onto that same row, which keeps the read-along.
      const fillable = !textLink && audioLink?.textBookId === null ? audioLink : null;
      if (!fillable && (bookLink || counterpartLink)) {
        throw new ConflictException('One or both books are already linked');
      }

      // A fill whose row a concurrent detach just removed finds the audiobook free again.
      const filled = fillable ? await this.repo.setTextBook(fillable.id, textBookId, null) : undefined;
      const inserted = filled ?? (await this.repo.insertLink(textBookId, audioBookId, user.id));
      if (!inserted) {
        throw new ConflictException('One or both books are already linked');
      }
      // A pair relinked after an unlink gets back the read-along it generated, in the same request. Not
      // after a lost fill: that row went away with a detach, and the new one must not undo it.
      const link = fillable && !filled ? inserted : await this.attachLostReadAlong(inserted, user.id);
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
      // pair IS the link, so both existing sides gate the unlink; the read-along is not consulted, because
      // dropping the row never touches that book and it normally lives in an admin-only library the
      // reader cannot open - demanding access to it would fail every unlink getForBook offers.
      await this.bookService.verifyBookAccess(bookId, user);
      const link = await this.repo.findLinkForBook(bookId);
      if (!link || (await this.isHiddenReadAlongOnly(link, bookId, user))) throw new NotFoundException('Edition link not found');
      const pairIds = [link.textBookId, link.audioBookId].filter((id): id is number => id !== null && id !== bookId);
      await Promise.all(pairIds.map((id) => this.bookService.verifyBookAccess(id, user)));

      const role = this.resolveRole(link, bookId);
      let updated: BookEditionLink | undefined;
      let outcome: 'read_along_detached' | 'text_left' | 'link_deleted';
      if (role === 'readAlong') {
        // From the read-along's own page, unlinking means "this generated book is no longer part of that
        // link" - the rest of the link stays. The detach is recorded on the build first: a recorded detach
        // on a link still carrying the book reads as attached, whereas an unrecorded one would be healed
        // back on the next read. The repository drops the row when no ebook is left on it.
        await this.readAlongOutputs.recordDetach(bookId, link.id);
        updated = await this.repo.setReadAlongBook(link.id, null, link.readAlongBookId);
        outcome = updated?.textBookId === null ? 'link_deleted' : 'read_along_detached';
      } else if (role === 'text') {
        // Never a delete by id, even when the read showed no read-along: one attached in between would
        // go with the row. The repository drops the row when no read-along is left on it.
        updated = await this.repo.setTextBook(link.id, null, bookId);
        outcome = updated?.readAlongBookId === null ? 'link_deleted' : 'text_left';
      } else {
        updated = await this.repo.deleteLink(link.id);
        outcome = 'link_deleted';
      }
      if (!updated) throw new NotFoundException('Edition link not found');

      this.logger.log(
        `[edition_link.unlink] [end] bookId=${bookId} userId=${user.id} linkId=${updated.id} textBookId=${link.textBookId ?? 'none'} durationMs=${Date.now() - startedAt} outcome=${outcome} - edition unlink completed`,
      );
      const readAlongBookId = await this.visibleReadAlongId(updated, bookId, user);
      return readAlongBookId === updated.readAlongBookId ? updated : { ...updated, readAlongBookId };
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
      // Before any answer about the link's read-along or the build, so an inaccessible book answers
      // the same whether it is the attached read-along, another one, or none at all.
      await this.bookService.verifyBookAccess(readAlongBookId, user);
      if (link && ((link.textBookId !== bookId && link.audioBookId !== bookId) || (await this.isHiddenReadAlongOnly(link, bookId, user)))) {
        throw new NotFoundException('Edition link not found');
      }
      const textBookId = link?.textBookId ?? null;

      const audioBookId = link ? link.audioBookId : bookId;
      if (!link && (await this.repo.getBookModality(bookId)) !== 'audio') {
        throw new NotFoundException('Edition link not found');
      }

      const otherBookId = link && link.textBookId === bookId ? link.audioBookId : link?.textBookId;
      if (otherBookId != null) await this.bookService.verifyBookAccess(otherBookId, user);

      if (link && link.readAlongBookId !== null && link.readAlongBookId !== readAlongBookId) {
        // A read-along the reader cannot open answers like any other conflict, so its existence stays hidden.
        const visible = (await this.visibleReadAlongId(link, bookId, user)) !== null;
        throw new ConflictException(
          visible ? 'A different read-along is already attached' : 'This read-along is already attached to another edition link',
        );
      }
      if (link && link.readAlongBookId === readAlongBookId) {
        this.logger.log(
          `[${ATTACH_EVENT}] [end] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} linkId=${link.id} textBookId=${textBookId ?? 'none'} durationMs=${Date.now() - startedAt} outcome=already_attached - explicit read-along attach completed`,
        );
        return link;
      }

      const build = await this.readAlongOutputs.findBuildByReadAlong(readAlongBookId);
      if (!build) {
        throw new NotFoundException('Generated read-along not found for this edition pair');
      }
      if (build.audioBookId !== audioBookId) {
        throw new BadRequestException('This read-along was not generated from this edition');
      }
      const attachedElsewhere = await this.repo.findLinkForBook(readAlongBookId);
      if (attachedElsewhere && attachedElsewhere.id !== link?.id) {
        throw new ConflictException('This read-along is already attached to another edition link');
      }

      const attachment = { buildId: build.buildId, outputBookId: build.outputBookId };
      let updated: BookEditionLink | undefined;
      if (link) {
        try {
          updated = await this.writeReadAlongAttachment(link, attachment);
        } catch (err) {
          if (isUniqueViolation(err)) throw new ConflictException('This read-along is already attached to another edition link');
          throw err;
        }
      } else {
        updated = await this.repo.insertLink(null, audioBookId, user.id, readAlongBookId);
        if (updated) await this.readAlongOutputs.recordAttachment(build.buildId, updated.id);
      }
      if (!updated) {
        throw new ConflictException('Read-along could not be attached');
      }

      this.logger.log(
        `[${ATTACH_EVENT}] [end] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} linkId=${updated.id} textBookId=${textBookId ?? 'none'} durationMs=${Date.now() - startedAt} outcome=${link ? 'attached' : 'created'} - explicit read-along attach completed`,
      );
      return updated;
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[${ATTACH_EVENT}] [fail] bookId=${bookId} readAlongBookId=${readAlongBookId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - explicit read-along attach failed`,
      );
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
    this.logger.log(`[${RESTORE_EVENT}] [start] ${ids} - read-along restore started`);
    try {
      const updated = await this.writeReadAlongAttachment(link, readAlong);
      this.logger.log(
        `[${RESTORE_EVENT}] [end] ${ids} durationMs=${Date.now() - startedAt} attached=${updated !== undefined} - read-along restore completed`,
      );
      return updated ?? link;
    } catch (err) {
      this.logAttachFailure(link.id, readAlong, userId, startedAt, err);
      return link;
    }
  }

  private async writeReadAlongAttachment(link: BookEditionLink, readAlong: ReadAlongAttachment): Promise<BookEditionLink | undefined> {
    const updated = await this.repo.setReadAlongBook(link.id, readAlong.outputBookId);
    if (updated) await this.readAlongOutputs.recordAttachment(readAlong.buildId, link.id);
    return updated;
  }

  private logAttachFailure(linkId: number, readAlong: ReadAlongAttachment | null, userId: number, startedAt: number, err: unknown): void {
    const errorClass = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const buildField = readAlong ? ` buildId=${readAlong.buildId} outputBookId=${readAlong.outputBookId}` : '';
    this.logger.warn(
      `[${RESTORE_EVENT}] [fail] linkId=${linkId}${buildField} userId=${userId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - read-along restore failed`,
    );
  }

  private async linkedView(user: RequestUser, bookId: number, found: BookEditionLink): Promise<ForBookView> {
    // The text/audio pair IS the link: if either side is inaccessible the whole link is hidden. The
    // read-along is an optional extra member, so losing access to it only masks that member - its id
    // is stripped from the returned row so an inaccessible book is never leaked through it.
    const pairIds = [found.textBookId, found.audioBookId].filter((id): id is number => id !== null && id !== bookId);
    const pairAccess = await Promise.all(pairIds.map((id) => this.canAccess(id, user)));
    if (pairAccess.some((allowed) => !allowed)) return unlinked();

    const link = await this.attachLostReadAlong(found, user.id);
    const readAlongBookId = await this.visibleReadAlongId(link, bookId, user);
    // A link holding only the audiobook and its read-along still wants an ebook, so the page gets the same proposal an unlinked audiobook would.
    const proposed = link.textBookId === null ? await this.proposeEbook(user, link.audioBookId) : null;
    // With its read-along masked, an ebook-less link would read as a linked audiobook on its own.
    if (link.textBookId === null && readAlongBookId === null) return unlinked(proposed);
    const role = this.resolveRole(link, bookId);
    const { members, summaries } = await this.resolveMembers(user, link.textBookId, link.audioBookId, readAlongBookId);
    const counterpartId = role === 'audio' ? link.textBookId : link.audioBookId;
    const counterpart = (counterpartId === null ? null : summaries.get(counterpartId)) ?? null;
    const visibleLink = readAlongBookId === link.readAlongBookId ? link : { ...link, readAlongBookId };
    return { link: visibleLink, proposed, counterpart, role, members };
  }

  /**
   * A read-along detached from its pair stays matched to the audiobook it was built from, so its page
   * can offer to take it back. While that audiobook is linked without a read-along, whatever ebook the
   * link holds now, the page shows that link so the read-along can be attached again. While both
   * sides of its pair are free, the page offers to link that pair; the pair is linked through its own
   * books, never through the read-along.
   */
  private async detachedReadAlong(user: RequestUser, bookId: number): Promise<ForBookView | null> {
    const pair = await this.readAlongOutputs.findSourcePair(bookId);
    if (!pair) return null;
    if (!(await this.canAccess(pair.audioBookId, user))) return null;
    const [textLink, audioLink] = await Promise.all([this.repo.findLinkForBook(pair.textBookId), this.repo.findLinkForBook(pair.audioBookId)]);
    if (audioLink) {
      if (audioLink.audioBookId !== pair.audioBookId) return null;
      if (audioLink.textBookId !== null && !(await this.canAccess(audioLink.textBookId, user))) return null;
      const healed = await this.attachLostReadAlong(audioLink, user.id);
      if (healed.readAlongBookId === bookId) return this.linkedView(user, bookId, healed);
      // A slot holding another read-along leaves this one nothing to rejoin.
      if (healed.readAlongBookId !== null) return null;
      const { members, summaries } = await this.resolveMembers(user, healed.textBookId, healed.audioBookId, null);
      return { link: healed, proposed: null, counterpart: summaries.get(healed.audioBookId) ?? null, role: 'readAlong', members };
    }
    // The page's own book is not a member here: it is the detached read-along the pair could take back.
    // An ebook linked elsewhere or out of reach is left off, and the audiobook still shows.
    const textFree = !textLink && (await this.canAccess(pair.textBookId, user));
    const { members } = await this.resolveMembers(user, textFree ? pair.textBookId : null, pair.audioBookId, null);
    return { link: null, proposed: null, counterpart: null, role: 'readAlong', members };
  }

  private async resolveMembers(
    user: RequestUser,
    textBookId: number | null,
    audioBookId: number,
    readAlongBookId: number | null,
  ): Promise<{ members: EditionLinkMembers; summaries: Map<number, EditionLinkCounterpartSummary> }> {
    const [summaries, progress] = await Promise.all([
      this.repo.findBookSummaries([textBookId, audioBookId, readAlongBookId].filter((id): id is number => id !== null)),
      this.repo.findMemberProgress(user.id, { textBookId, audioBookId, readAlongBookId }),
    ]);
    const members: EditionLinkMembers = {
      text: textBookId === null ? null : toMember(textBookId, summaries.get(textBookId) ?? null, progress.text, null),
      audio: toMember(audioBookId, summaries.get(audioBookId) ?? null, progress.audio, null),
      readAlong:
        readAlongBookId === null
          ? null
          : toMember(readAlongBookId, summaries.get(readAlongBookId) ?? null, progress.readAlong, progress.readAlongNarrationPercentage),
    };
    return { members, summaries };
  }

  /** A link holding no ebook whose read-along the reader cannot open reads as no link at all. */
  private async isHiddenReadAlongOnly(link: BookEditionLink, bookId: number, user: RequestUser): Promise<boolean> {
    return link.textBookId === null && link.readAlongBookId !== null && (await this.visibleReadAlongId(link, bookId, user)) === null;
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
