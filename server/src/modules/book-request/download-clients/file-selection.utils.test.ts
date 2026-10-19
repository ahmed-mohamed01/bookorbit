import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { applyFileSelection, matchWantedFiles } from './file-selection.utils';

describe('matchWantedFiles', () => {
  it('matches release-relative paths against client paths that include the root folder', () => {
    expect(matchWantedFiles(['Root/A/1.epub', 'Root/A/2.epub', 'Root/B/x.zip'], ['A/2.epub'])).toEqual({
      wantedIndexes: [1],
      skippedIndexes: [0, 2],
      missing: [],
    });
  });

  it('matches a single-file torrent with no root folder', () => {
    expect(matchWantedFiles(['Book.epub'], ['Book.epub'])).toEqual({
      wantedIndexes: [0],
      skippedIndexes: [],
      missing: [],
    });
  });

  it('matches when the client root name differs from the torrent name', () => {
    expect(matchWantedFiles(['Renamed/A/1.epub'], ['A/1.epub'])).toEqual({
      wantedIndexes: [0],
      skippedIndexes: [],
      missing: [],
    });
  });

  it('normalises separators and unicode', () => {
    expect(matchWantedFiles(['Root\\Cafe\u0301/1.epub'], ['Café/1.epub'])).toEqual({
      wantedIndexes: [0],
      skippedIndexes: [],
      missing: [],
    });
  });

  it('reports wanted paths the client does not have', () => {
    expect(matchWantedFiles(['Root/A/1.epub'], ['A/9.epub'])).toEqual({
      wantedIndexes: [],
      skippedIndexes: [0],
      missing: ['A/9.epub'],
    });
  });

  it('removes leading dot and slash prefixes from both sides', () => {
    expect(matchWantedFiles(['/./Root/A/1.epub', './Book.epub'], ['./A/1.epub', '/Book.epub'])).toEqual({
      wantedIndexes: [0, 1],
      skippedIndexes: [],
      missing: [],
    });
  });

  it('drops at most one client segment and preserves original missing paths', () => {
    expect(matchWantedFiles(['Root/A/1.epub'], ['1.epub', './Missing\\Book.epub'])).toEqual({
      wantedIndexes: [],
      skippedIndexes: [0],
      missing: ['1.epub', './Missing\\Book.epub'],
    });
  });

  it('handles empty lists', () => {
    expect(matchWantedFiles([], [])).toEqual({
      wantedIndexes: [],
      skippedIndexes: [],
      missing: [],
    });
  });
});

describe('applyFileSelection', () => {
  function options() {
    return {
      clientId: 1,
      clientKey: 'hash',
      wantedPaths: ['Book.epub'],
      logger: { log: vi.fn(), warn: vi.fn() },
      listFiles: vi.fn().mockResolvedValue(['Book.epub', 'Other.epub']),
      skip: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
  }
  it('logs exactly one end after applying selection', async () => {
    const input = options();
    await applyFileSelection(input);
    expect(input.skip).toHaveBeenCalledWith([1]);
    expect(input.start).toHaveBeenCalledOnce();
    expect(input.logger.log.mock.calls.filter(([message]) => message.includes('[end]'))).toHaveLength(1);
    expect(input.logger.warn).not.toHaveBeenCalled();
    expect(input.remove).not.toHaveBeenCalled();
  });
  it('removes and wraps the original failure even when cleanup fails', async () => {
    const input = options();
    input.start.mockRejectedValue(new BadRequestException('start failed'));
    input.remove.mockRejectedValue(new BadRequestException('cleanup failed'));
    await expect(applyFileSelection(input)).rejects.toThrow(
      new BadRequestException('The download client did not accept the file selection: start failed'),
    );
    expect(input.remove).toHaveBeenCalledOnce();
    expect(input.logger.warn).toHaveBeenCalledOnce();
    expect(input.logger.log.mock.calls.some(([message]) => message.includes('[end]'))).toBe(false);
  });
});
