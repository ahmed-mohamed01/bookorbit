import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { BuildReadAlongDto, UpsertStorytellerSettingsDto } from './storyteller.dto';

// Mirrors the global ValidationPipe options so nested unknown keys are rejected here too.
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function settingsErrorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(UpsertStorytellerSettingsDto, payload), PIPE_OPTIONS);
}

async function buildErrorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(BuildReadAlongDto, payload), PIPE_OPTIONS);
}

function mappings(count: number) {
  return Array.from({ length: count }, (_, i) => ({ localPrefix: `/books/${i}`, remotePrefix: `/storyteller/${i}` }));
}

describe('UpsertStorytellerSettingsDto', () => {
  it('accepts an empty body', async () => {
    await expect(settingsErrorsFor({})).resolves.toHaveLength(0);
  });

  it('trims the server URL before validating and keeps the trimmed value', async () => {
    const dto = plainToInstance(UpsertStorytellerSettingsDto, { serverUrl: '  https://storyteller.example.com  ' });

    await expect(validate(dto, PIPE_OPTIONS)).resolves.toHaveLength(0);
    expect(dto.serverUrl).toBe('https://storyteller.example.com');
  });

  it('rejects an over-long server URL, username or password', async () => {
    await expect(settingsErrorsFor({ serverUrl: `https://a.com/${'x'.repeat(2048)}` })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ username: 'a'.repeat(256) })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ password: 'a'.repeat(1025) })).resolves.not.toHaveLength(0);
  });

  it('accepts a well-formed transport value and rejects an unknown one', async () => {
    await expect(settingsErrorsFor({ transport: 'shared-paths' })).resolves.toHaveLength(0);
    await expect(settingsErrorsFor({ transport: 'api-transfer' })).resolves.toHaveLength(0);
    await expect(settingsErrorsFor({ transport: 'ftp' })).resolves.not.toHaveLength(0);
  });

  it('accepts null targetLibraryId, targetFolderId and collectionName to clear them', async () => {
    await expect(settingsErrorsFor({ targetLibraryId: null, targetFolderId: null, collectionName: null })).resolves.toHaveLength(0);
  });

  it('rejects a targetLibraryId or targetFolderId below 1', async () => {
    await expect(settingsErrorsFor({ targetLibraryId: 0 })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ targetFolderId: 0 })).resolves.not.toHaveLength(0);
  });

  it('rejects an unknown top-level key', async () => {
    await expect(settingsErrorsFor({ serverUrl: 'https://storyteller.example.com', apiKey: 'nope' })).resolves.not.toHaveLength(0);
  });

  it('rejects null on the non-nullable fields (only omission is allowed)', async () => {
    await expect(settingsErrorsFor({ serverUrl: null })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ username: null })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ password: null })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ pathMappings: null })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ transport: null })).resolves.not.toHaveLength(0);
    await expect(settingsErrorsFor({ deleteRemoteAfterImport: null })).resolves.not.toHaveLength(0);
  });

  describe('pathMappings', () => {
    it('accepts an omitted list, an empty list and a well-formed list', async () => {
      await expect(settingsErrorsFor({})).resolves.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: [] })).resolves.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: '/books', remotePrefix: '/storyteller' }] })).resolves.toHaveLength(0);
    });

    it('trims prefixes before validating and keeps the trimmed value', async () => {
      const dto = plainToInstance(UpsertStorytellerSettingsDto, {
        pathMappings: [{ localPrefix: '  /books  ', remotePrefix: '  /storyteller  ' }],
      });

      await expect(validate(dto, PIPE_OPTIONS)).resolves.toHaveLength(0);
      expect(dto.pathMappings).toEqual([{ localPrefix: '/books', remotePrefix: '/storyteller' }]);
    });

    it('rejects an empty or whitespace-only prefix on either side', async () => {
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: '', remotePrefix: '/storyteller' }] })).resolves.not.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: '   ', remotePrefix: '/storyteller' }] })).resolves.not.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: '/books', remotePrefix: '' }] })).resolves.not.toHaveLength(0);
    });

    it('rejects a missing side, a non-string prefix, and an over-long prefix', async () => {
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: '/books' }] })).resolves.not.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: [{ localPrefix: 5, remotePrefix: '/storyteller' }] })).resolves.not.toHaveLength(0);
      await expect(
        settingsErrorsFor({ pathMappings: [{ localPrefix: `/${'a'.repeat(500)}`, remotePrefix: '/storyteller' }] }),
      ).resolves.not.toHaveLength(0);
    });

    it('rejects an unknown key inside a mapping row', async () => {
      await expect(
        settingsErrorsFor({ pathMappings: [{ localPrefix: '/books', remotePrefix: '/storyteller', mode: 'copy' }] }),
      ).resolves.not.toHaveLength(0);
    });

    it('accepts 100 rows and rejects 101', async () => {
      await expect(settingsErrorsFor({ pathMappings: mappings(100) })).resolves.toHaveLength(0);
      await expect(settingsErrorsFor({ pathMappings: mappings(101) })).resolves.not.toHaveLength(0);
    });

    it('rejects a non-array value', async () => {
      await expect(settingsErrorsFor({ pathMappings: { localPrefix: '/books', remotePrefix: '/storyteller' } })).resolves.not.toHaveLength(0);
    });
  });
});

describe('BuildReadAlongDto', () => {
  it('accepts an empty body', async () => {
    await expect(buildErrorsFor({})).resolves.toHaveLength(0);
  });

  it('accepts a fully populated body', async () => {
    await expect(buildErrorsFor({ force: true, targetLibraryId: 3, targetFolderId: 4, useExistingUuid: 'abc-123' })).resolves.toHaveLength(0);
  });

  it('rejects a non-boolean force', async () => {
    await expect(buildErrorsFor({ force: 'yes' })).resolves.not.toHaveLength(0);
  });

  it('rejects targetLibraryId or targetFolderId below 1', async () => {
    await expect(buildErrorsFor({ targetLibraryId: 0 })).resolves.not.toHaveLength(0);
    await expect(buildErrorsFor({ targetFolderId: 0 })).resolves.not.toHaveLength(0);
  });

  it('rejects an over-long useExistingUuid', async () => {
    await expect(buildErrorsFor({ useExistingUuid: 'a'.repeat(65) })).resolves.not.toHaveLength(0);
    await expect(buildErrorsFor({ useExistingUuid: 'a'.repeat(64) })).resolves.toHaveLength(0);
  });

  it('rejects an unknown key', async () => {
    await expect(buildErrorsFor({ force: true, mode: 'retry' })).resolves.not.toHaveLength(0);
  });

  it('rejects null on the non-nullable fields (only omission is allowed)', async () => {
    await expect(buildErrorsFor({ force: null })).resolves.not.toHaveLength(0);
    await expect(buildErrorsFor({ useExistingUuid: null })).resolves.not.toHaveLength(0);
    await expect(buildErrorsFor({ cleanUpRemote: null })).resolves.not.toHaveLength(0);
    // A null target would otherwise read as "the caller chose a library" and discard the configured one.
    await expect(buildErrorsFor({ targetLibraryId: null })).resolves.not.toHaveLength(0);
    await expect(buildErrorsFor({ targetFolderId: null })).resolves.not.toHaveLength(0);
  });

  it('still accepts an omitted target library and folder', async () => {
    await expect(buildErrorsFor({ force: true })).resolves.toHaveLength(0);
  });
});
