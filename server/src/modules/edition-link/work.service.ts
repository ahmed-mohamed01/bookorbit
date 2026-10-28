import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { EditionLinkSettings, WorkForBook, WorkVariant, WorkVariantRole } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { BookService } from '../book/book.service';
import { EditionLinkRepository } from './edition-link.repository';
import { EditionLinkSettingsService, sharesReadingState } from './edition-link-settings.service';
import { READ_ALONG_OUTPUT_SOURCE, type ReadAlongOutputSource } from './read-along-output-source';
import type { BookEditionLink } from './schema/edition-link.schema';
import { WorkEventsService } from './work-events.service';
import { type DetachContext, WorkStateService } from './work-state.service';
import { type VariantDetailRow, type VariantProgressRow, type WorkMemberRankRow, type WorkPrimaries, WorkRepository } from './work.repository';
import { WorkScopeService } from './work-scope.service';
import { type PrimaryCandidate, pickPrimaries } from './work.utils';

const IN_SYNC_TOLERANCE = 1;
const SESSION_SOURCES: Record<string, WorkVariant['progressSource']> = {
  web: 'web_reader',
  ios: 'web_reader',
  android: 'web_reader',
  watchos: 'web_reader',
  kobo: 'kobo',
  koreader: 'koreader',
  audiobookshelf: 'audiobookshelf',
};

function toCandidate(row: WorkMemberRankRow): PrimaryCandidate {
  return {
    bookId: row.bookId,
    role: row.role,
    createdAt: row.createdAt,
    primaryFormat: row.primaryFormat,
    primaryReadAlong: row.primaryReadAlong,
    formatPriority: row.formatPriority,
  };
}

function variantProgress(
  role: WorkVariantRole,
  row: VariantProgressRow | undefined,
): Pick<WorkVariant, 'progress' | 'progressUpdatedAt' | 'progressSource'> {
  if (!row) return { progress: null, progressUpdatedAt: null, progressSource: null };
  const sessionSource = row.sessionSource ? (SESSION_SOURCES[row.sessionSource] ?? null) : null;
  if (role === 'audio') {
    return {
      progress: row.audioPercentage,
      progressUpdatedAt: row.audioUpdatedAt?.toISOString() ?? null,
      progressSource: row.audioPercentage === null ? null : sessionSource,
    };
  }
  const mirrored = row.fileProjectedAt !== null && row.fileLastReadAt !== null && row.fileProjectedAt >= row.fileLastReadAt;
  return {
    progress: row.filePercentage,
    progressUpdatedAt: (mirrored ? row.fileProjectedAt : row.fileLastReadAt)?.toISOString() ?? null,
    progressSource: row.filePercentage === null ? null : mirrored ? 'mirror' : sessionSource,
  };
}

function toVariant(
  member: { bookId: number; role: WorkVariantRole; isPrimary: boolean },
  thisBookId: number,
  detail: VariantDetailRow | undefined,
  progress: VariantProgressRow | undefined,
): WorkVariant {
  const audio = member.role === 'audio';
  return {
    bookId: member.bookId,
    role: member.role,
    isPrimary: member.isPrimary,
    isThisBook: member.bookId === thisBookId,
    title: detail?.title ?? null,
    authorName: detail?.authorName ?? null,
    coverVersion: detail?.coverUpdatedAt?.toISOString() ?? null,
    libraryId: detail?.libraryId ?? 0,
    libraryName: detail?.libraryName ?? '',
    formats: detail?.formats ?? [],
    sizeBytes: detail?.sizeBytes == null ? null : Number(detail.sizeBytes),
    durationSeconds: audio ? (detail?.metadataDurationSeconds ?? detail?.audioDurationSeconds ?? null) : null,
    ...variantProgress(member.role, progress),
  };
}

/**
 * Works over edition links: what a book's work looks like to a reader, and the same-role duplicate
 * copies a work may hold. Every write re-picks the primaries and folds the history together.
 */
@Injectable()
export class WorkService {
  private readonly logger = new Logger(WorkService.name);

  constructor(
    private readonly repo: WorkRepository,
    private readonly links: EditionLinkRepository,
    private readonly scope: WorkScopeService,
    private readonly settings: EditionLinkSettingsService,
    private readonly state: WorkStateService,
    private readonly events: WorkEventsService,
    private readonly bookService: BookService,
    @Inject(READ_ALONG_OUTPUT_SOURCE) private readonly readAlongOutputs: ReadAlongOutputSource,
  ) {}

  resolve(userId: number, bookId: number) {
    return this.scope.resolve(userId, bookId);
  }

  resolveMany(userId: number, bookIds: readonly number[]) {
    return this.scope.resolveMany(userId, bookIds);
  }

  canonicalBookId(userId: number, bookId: number): Promise<number> {
    return this.scope.canonicalBookId(userId, bookId);
  }

  getSettings(userId: number): Promise<EditionLinkSettings> {
    return this.settings.get(userId);
  }

  /** Turning shared state on folds every work's history together in the background. */
  async updateSettings(userId: number, patch: Partial<EditionLinkSettings>): Promise<EditionLinkSettings> {
    const before = await this.settings.get(userId);
    const after = await this.settings.update(userId, patch);
    this.scope.invalidate();
    if (!sharesReadingState(before) && sharesReadingState(after)) void this.state.mergeAllForUser(userId);
    return after;
  }

  findMembers(bookId: number): Promise<WorkMemberRankRow[]> {
    return this.repo.findWorkMembersByBook(bookId);
  }

  async getWorkForBook(user: RequestUser, bookId: number): Promise<WorkForBook> {
    await this.bookService.verifyBookAccess(bookId, user);
    const [settings, work] = await Promise.all([this.settings.get(user.id), this.scope.resolve(user.id, bookId)]);
    const sharedState = sharesReadingState(settings);

    const candidates = work ? work.members : [{ bookId, role: await this.roleOfLoneBook(bookId), isPrimary: true, createdAt: new Date(0) }];
    const visible = (await Promise.all(candidates.map(async (member) => ((await this.canAccess(member.bookId, user)) ? member : null)))).filter(
      (member): member is NonNullable<typeof member> => member !== null,
    );
    const ids = visible.map((member) => member.bookId);
    const [details, progress] = await Promise.all([this.repo.findVariantDetails(ids), this.repo.findVariantProgress(user.id, ids)]);
    const detailById = new Map(details.map((row) => [row.bookId, row]));
    const progressById = new Map(progress.map((row) => [row.bookId, row]));
    const variants = visible.map((member) => toVariant(member, bookId, detailById.get(member.bookId), progressById.get(member.bookId)));

    const canonicalBookId = work && visible.length > 1 ? work.canonicalBookId : bookId;
    const canonicalProgress = variants.find((variant) => variant.bookId === canonicalBookId)?.progress ?? 0;
    const inSync = variants.every((variant) => Math.abs((variant.progress ?? 0) - canonicalProgress) <= IN_SYNC_TOLERANCE);
    const hasPrimary = (role: WorkVariantRole) => variants.some((variant) => variant.role === role && variant.isPrimary);
    const canGenerateReadAlong =
      variants.length > 1 && hasPrimary('text') && hasPrimary('audio') && !variants.some((variant) => variant.role === 'readAlong')
        ? await this.readAlongOutputs.isConfigured()
        : false;

    return {
      linkId: work && visible.length > 1 ? work.linkId : null,
      canonicalBookId,
      variants,
      sharedState,
      inSync,
      canGenerateReadAlong,
    };
  }

  /** Adds a same-role copy (a second ebook or audiobook) to the anchor's work, or starts one with it. */
  async addMember(user: RequestUser, anchorBookId: number, bookId: number): Promise<WorkForBook> {
    const startedAt = Date.now();
    const ids = `anchorBookId=${anchorBookId} bookId=${bookId} userId=${user.id}`;
    this.logger.log(`[work.add_member] [start] ${ids} - adding duplicate copy`);
    try {
      if (anchorBookId === bookId) throw new BadRequestException('A book cannot join its own work');
      if (!(await this.settings.get(user.id)).sameTypeAsOneWork) {
        throw new BadRequestException('Copies of the same type join one work only when that setting is on');
      }
      await Promise.all([this.bookService.verifyBookAccess(anchorBookId, user), this.bookService.verifyBookAccess(bookId, user)]);
      if ((await this.readAlongOutputs.findReadAlongOutputs([anchorBookId, bookId])).size > 0) {
        throw new BadRequestException('A generated read-along has no duplicate copies');
      }
      if ((await this.repo.findWorkMembersByBook(bookId)).length > 0) throw new ConflictException('This book already belongs to a work');

      const anchorMembers = await this.repo.findWorkMembersByBook(anchorBookId);
      const anchorRole = anchorMembers.find((member) => member.bookId === anchorBookId)?.role ?? (await this.roleOfLoneBook(anchorBookId));
      const role = await this.roleOfLoneBook(bookId);
      if (anchorRole === 'readAlong' || role !== anchorRole) throw new BadRequestException('Duplicate copies must be the same type of book');

      let linkId: number;
      if (anchorMembers.length > 0) {
        linkId = anchorMembers[0]!.linkId;
        await this.repo.addDuplicate(linkId, bookId, role);
        await this.repickPrimaries(linkId);
      } else {
        const ranks = await this.repo.findBookRanks([anchorBookId, bookId]);
        const now = Date.now();
        const candidates = [anchorBookId, bookId].map((id, index) => ({
          bookId: id,
          role,
          createdAt: new Date(now + index),
          primaryFormat: ranks.get(id)?.primaryFormat ?? null,
          primaryReadAlong: ranks.get(id)?.primaryReadAlong ?? false,
          formatPriority: ranks.get(id)?.formatPriority ?? null,
        }));
        const primaries = pickPrimaries(candidates);
        const duplicate = primaries[role] === anchorBookId ? bookId : anchorBookId;
        linkId = await this.repo.createWork(user.id, primaries, [{ bookId: duplicate, role }]);
      }
      this.scope.invalidate();
      await this.afterWrite(user.id, linkId);
      this.logger.log(`[work.add_member] [end] ${ids} linkId=${linkId} durationMs=${Date.now() - startedAt} role=${role} - duplicate copy added`);
      return this.getWorkForBook(user, anchorBookId);
    } catch (err) {
      this.logFail('work.add_member', ids, startedAt, err, 'adding duplicate copy failed');
      throw err;
    }
  }

  async setPrimary(user: RequestUser, bookId: number): Promise<WorkForBook> {
    const startedAt = Date.now();
    const ids = `bookId=${bookId} userId=${user.id}`;
    this.logger.log(`[work.set_primary] [start] ${ids} - setting primary copy`);
    try {
      await this.bookService.verifyBookAccess(bookId, user);
      const members = await this.repo.findWorkMembersByBook(bookId);
      const member = members.find((entry) => entry.bookId === bookId);
      if (!member) throw new NotFoundException('This book does not belong to a work');
      const primaries = this.currentPrimaries(members);
      primaries[member.role] = bookId;
      await this.repo.applyPrimaries(member.linkId, primaries);
      this.scope.invalidate();
      await this.afterWrite(user.id, member.linkId);
      this.logger.log(
        `[work.set_primary] [end] ${ids} linkId=${member.linkId} durationMs=${Date.now() - startedAt} role=${member.role} - primary copy set`,
      );
      return this.getWorkForBook(user, bookId);
    } catch (err) {
      this.logFail('work.set_primary', ids, startedAt, err, 'setting primary copy failed');
      throw err;
    }
  }

  /**
   * Takes a book out of a work that holds duplicate copies, where the slot-based unlink would drop
   * copies with the slot. The history copy around it is the caller's (see EditionLinkService.unlink).
   */
  async removeMember(bookId: number, members: readonly WorkMemberRankRow[]): Promise<BookEditionLink | undefined> {
    const member = members.find((entry) => entry.bookId === bookId);
    if (!member) throw new NotFoundException('Edition link not found');
    const before = await this.links.findLinkForBook(bookId);
    if (member.role === 'readAlong') await this.readAlongOutputs.recordDetach(bookId, member.linkId);
    const remaining = members.filter((entry) => entry.bookId !== bookId);
    const remainingCount = await this.repo.removeMember(
      member.linkId,
      bookId,
      pickPrimaries(remaining.map(toCandidate), this.currentPrimaries(remaining)),
    );
    this.scope.invalidate();
    if (remainingCount < 2 || remaining.length === 0) return before;
    return (await this.links.findLinkForBook(remaining[0]!.bookId)) ?? before;
  }

  /**
   * Joins an ebook and an audiobook when at least one already sits in a work: extends that work, or
   * merges the two. A role both sides already fill becomes a duplicate, which the setting must allow.
   */
  async joinWorks(user: RequestUser, textBookId: number, audioBookId: number): Promise<number> {
    const [textMembers, audioMembers] = await Promise.all([
      this.repo.findWorkMembersByBook(textBookId),
      this.repo.findWorkMembersByBook(audioBookId),
    ]);
    const textLinkId = textMembers[0]?.linkId ?? null;
    const audioLinkId = audioMembers[0]?.linkId ?? null;
    if (textLinkId !== null && textLinkId === audioLinkId) throw new ConflictException('One or both books are already linked');

    const settings = await this.settings.get(user.id);
    const incoming: WorkMemberRankRow[] = [];
    if (textLinkId === null) incoming.push(...(await this.loneMember(textBookId, 'text')));
    if (audioLinkId === null) incoming.push(...(await this.loneMember(audioBookId, 'audio')));
    const union = [...audioMembers, ...textMembers, ...incoming];
    const roles = union.map((member) => member.role);
    if (!settings.sameTypeAsOneWork && new Set(roles).size !== roles.length) {
      throw new ConflictException('One or both books are already linked');
    }
    const primaries = pickPrimaries(union.map(toCandidate));

    if (textLinkId !== null && audioLinkId !== null) {
      await this.repo.mergeWorks(audioLinkId, textLinkId, primaries);
      this.scope.invalidate();
      return audioLinkId;
    }
    const linkId = (textLinkId ?? audioLinkId)!;
    for (const member of incoming) await this.repo.addDuplicate(linkId, member.bookId, member.role);
    await this.repo.applyPrimaries(linkId, primaries);
    this.scope.invalidate();
    return linkId;
  }

  prepareDetach(bookId: number): Promise<DetachContext> {
    return this.state.prepareDetach(bookId);
  }

  finishDetach(context: DetachContext): Promise<void> {
    return this.state.finishDetach(context);
  }

  notifyChanged(userId: number, bookIds: readonly number[], audioBookIds: readonly number[] = []): Promise<void> {
    return this.events.notifyBooksChanged(userId, bookIds, audioBookIds);
  }

  /** Folds the history together for the work a book now sits in, and refreshes the reader's pages. */
  async mergeStateForBook(bookId: number, notifyUserId?: number): Promise<void> {
    const members = await this.repo.findWorkMembersByBook(bookId);
    if (members.length > 0) await this.afterWrite(notifyUserId, members[0]!.linkId, members);
  }

  private async afterWrite(userId: number | undefined, linkId: number, known?: WorkMemberRankRow[]): Promise<void> {
    const members = known ?? (await this.repo.findWorkMembersByLink(linkId));
    const ids = members.map((member) => member.bookId);
    await this.state.mergeWorkState(ids);
    if (userId === undefined) return;
    await this.events.notifyBooksChanged(
      userId,
      ids,
      members.filter((member) => member.role === 'audio').map((member) => member.bookId),
    );
  }

  private async repickPrimaries(linkId: number): Promise<void> {
    const members = await this.repo.findWorkMembersByLink(linkId);
    await this.repo.applyPrimaries(linkId, pickPrimaries(members.map(toCandidate)));
  }

  private currentPrimaries(members: readonly WorkMemberRankRow[]): WorkPrimaries {
    const of = (role: WorkVariantRole) => members.find((member) => member.role === role && member.isPrimary)?.bookId ?? null;
    return { text: of('text'), audio: of('audio'), readAlong: of('readAlong') };
  }

  private async loneMember(bookId: number, role: WorkVariantRole): Promise<WorkMemberRankRow[]> {
    const rank = (await this.repo.findBookRanks([bookId])).get(bookId);
    return [
      {
        linkId: 0,
        bookId,
        role,
        isPrimary: false,
        createdAt: new Date(),
        primaryFormat: rank?.primaryFormat ?? null,
        primaryReadAlong: rank?.primaryReadAlong ?? false,
        formatPriority: rank?.formatPriority ?? null,
      },
    ];
  }

  private async roleOfLoneBook(bookId: number): Promise<WorkVariantRole> {
    if ((await this.readAlongOutputs.findReadAlongOutputs([bookId])).has(bookId)) return 'readAlong';
    return (await this.links.getBookModality(bookId)) === 'audio' ? 'audio' : 'text';
  }

  private async canAccess(bookId: number, user: RequestUser): Promise<boolean> {
    try {
      await this.bookService.verifyBookAccess(bookId, user);
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) return false;
      throw err;
    }
  }

  private logFail(event: string, ids: string, startedAt: number, err: unknown, message: string): void {
    const errorClass = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[${event}] [fail] ${ids} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - ${message}`,
    );
  }
}
