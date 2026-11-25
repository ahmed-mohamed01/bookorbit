import { ConflictException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { knowledgeOperation } from './book-knowledge-logging';
it.each([new NotFoundException(), new ConflictException(), new InternalServerErrorException(), new Error('invented failure')])(
  'selects failure severity for %s',
  async (error) => {
    const logger = new Logger('fixture');
    vi.spyOn(logger, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const failure = vi.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(knowledgeOperation(logger, 'book_knowledge.fixture', 'bookId=3', () => Promise.reject(error))).rejects.toBe(error);
    const expected = error instanceof NotFoundException || error instanceof ConflictException ? debug : failure;
    expect(expected).toHaveBeenCalledWith(expect.stringContaining('[book_knowledge.fixture] [fail] bookId=3 durationMs='));
    expect(expected === debug ? failure : debug).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  },
);
