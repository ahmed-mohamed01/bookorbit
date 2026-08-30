import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CleanupAudiobookshelfStaleDto, UpsertAudiobookshelfSettingsDto } from './audiobookshelf.dto';

// Mirrors the global ValidationPipe options so nested unknown keys are rejected here too.
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(UpsertAudiobookshelfSettingsDto, payload), PIPE_OPTIONS);
}

async function cleanupErrorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CleanupAudiobookshelfStaleDto, payload), PIPE_OPTIONS);
}

function mappings(count: number) {
  return Array.from({ length: count }, (_, i) => ({ absPrefix: `/audiobooks/${i}`, localPrefix: `/books/${i}` }));
}

describe('UpsertAudiobookshelfSettingsDto pathMappings', () => {
  it('accepts an omitted list and a well-formed list', async () => {
    await expect(errorsFor({ enabled: true })).resolves.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] })).resolves.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [] })).resolves.toHaveLength(0);
  });

  it('trims prefixes before validating and keeps the trimmed value', async () => {
    const dto = plainToInstance(UpsertAudiobookshelfSettingsDto, {
      pathMappings: [{ absPrefix: '  /audiobooks  ', localPrefix: '  /books  ' }],
    });

    await expect(validate(dto, PIPE_OPTIONS)).resolves.toHaveLength(0);
    expect(dto.pathMappings).toEqual([{ absPrefix: '/audiobooks', localPrefix: '/books' }]);
  });

  it('rejects an empty or whitespace-only prefix on either side', async () => {
    await expect(errorsFor({ pathMappings: [{ absPrefix: '', localPrefix: '/books' }] })).resolves.not.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [{ absPrefix: '   ', localPrefix: '/books' }] })).resolves.not.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '' }] })).resolves.not.toHaveLength(0);
  });

  it('rejects a missing side, a non-string prefix, and an over-long prefix', async () => {
    await expect(errorsFor({ pathMappings: [{ absPrefix: '/audiobooks' }] })).resolves.not.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [{ absPrefix: 5, localPrefix: '/books' }] })).resolves.not.toHaveLength(0);
    await expect(errorsFor({ pathMappings: [{ absPrefix: `/${'a'.repeat(500)}`, localPrefix: '/books' }] })).resolves.not.toHaveLength(0);
  });

  it('rejects an unknown key inside a mapping row', async () => {
    await expect(errorsFor({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books', mode: 'copy' }] })).resolves.not.toHaveLength(0);
  });

  it('accepts 20 rows and rejects 21', async () => {
    await expect(errorsFor({ pathMappings: mappings(20) })).resolves.toHaveLength(0);
    await expect(errorsFor({ pathMappings: mappings(21) })).resolves.not.toHaveLength(0);
  });

  it('rejects a non-array value', async () => {
    await expect(errorsFor({ pathMappings: { absPrefix: '/audiobooks', localPrefix: '/books' } })).resolves.not.toHaveLength(0);
  });
});

describe('CleanupAudiobookshelfStaleDto', () => {
  it('accepts an empty body', async () => {
    await expect(cleanupErrorsFor({})).resolves.toHaveLength(0);
  });

  it('accepts includeManuallyUnlinked true', async () => {
    await expect(cleanupErrorsFor({ includeManuallyUnlinked: true })).resolves.toHaveLength(0);
  });

  it('rejects an unknown key', async () => {
    await expect(cleanupErrorsFor({ includeManuallyUnlinked: true, mode: 'all' })).resolves.not.toHaveLength(0);
  });
});
