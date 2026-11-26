import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INTERACTIVE_ONLY_KEY } from '../../common/decorators/api-key-policy.decorator';
import { makeUser } from '../../common/test-utils/make-user';
import { BookService } from '../book/book.service';
import { BookKnowledgeService } from '../book-knowledge/book-knowledge.service';
import { StoryGuidesService } from '../story-guides/story-guides.service';
import { BkXrayReaderController } from './bk-xray-reader.controller';

describe('BkXrayReaderController', () => {
  const bookId = 7;
  const fileId = 42;
  const user = makeUser();
  const sourceFileId = vi.fn<BookKnowledgeService['sourceFileId']>();
  const content = vi.fn<StoryGuidesService['content']>();
  const verifyBookAccess = vi.fn<BookService['verifyBookAccess']>();
  let controller: BkXrayReaderController;

  beforeEach(async () => {
    sourceFileId.mockReset().mockResolvedValue(fileId);
    content.mockReset();
    verifyBookAccess.mockReset().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      controllers: [BkXrayReaderController],
      providers: [
        { provide: BookKnowledgeService, useValue: { sourceFileId } },
        { provide: StoryGuidesService, useValue: { content } },
        { provide: BookService, useValue: { verifyBookAccess } },
      ],
    }).compile();
    controller = module.get(BkXrayReaderController);
  });

  it('refuses API keys like the fork content route', () => {
    expect(new Reflector().get(INTERACTIVE_ONLY_KEY, BkXrayReaderController)).toBe(true);
  });

  it("returns the stored row's body for the book's BK file", async () => {
    const body = { format: 1, entities: [], links: [], chronicle: { version: 1, entities: {} } };
    content.mockResolvedValue({ kind: 'found', body, etag: '"guide.f1"' });

    await expect(controller.payload(bookId, user)).resolves.toEqual(body);
    expect(sourceFileId).toHaveBeenCalledWith(bookId);
    expect(content).toHaveBeenCalledWith(fileId, [1], user);
  });

  it('404s when no guide is stored', async () => {
    content.mockResolvedValue({ kind: 'missing', reason: 'none' });

    await expect(controller.payload(bookId, user)).rejects.toThrow(new NotFoundException('No X-Ray is stored for this book'));
  });

  it('404s when the book has no BK source file', async () => {
    sourceFileId.mockResolvedValue(null);

    await expect(controller.payload(bookId, user)).rejects.toThrow(new NotFoundException('No X-Ray is stored for this book'));
    expect(content).not.toHaveBeenCalled();
  });

  it('propagates access errors from the story guide service', async () => {
    const error = new ForbiddenException();
    content.mockRejectedValue(error);

    await expect(controller.payload(bookId, user)).rejects.toBe(error);
  });

  it('404s for an upstream-shaped guide with no BK links', async () => {
    content.mockResolvedValue({ kind: 'found', body: { format: 1, entities: [] }, etag: '"guide.f1"' });

    await expect(controller.payload(bookId, user)).rejects.toThrow(new NotFoundException('No X-Ray is stored for this book'));
  });

  it('checks book access first, so a hidden book answers like a missing one', async () => {
    const denied = new NotFoundException(`Book ${bookId} not found`);
    verifyBookAccess.mockRejectedValue(denied);

    await expect(controller.payload(bookId, user)).rejects.toBe(denied);
    expect(sourceFileId).not.toHaveBeenCalled();
    expect(verifyBookAccess).toHaveBeenCalledWith(bookId, user);
  });
});
