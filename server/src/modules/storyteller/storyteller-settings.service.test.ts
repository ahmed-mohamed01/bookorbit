import { BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSafeUrl } from '../../common/utils/ssrf.utils';
import type { RequestUser } from '../../common/types/request-user';
import { StorytellerClientError } from './storyteller-client.service';
import { StorytellerSettingsService } from './storyteller-settings.service';

vi.mock('../../common/utils/ssrf.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/utils/ssrf.utils')>()),
  ensureSafeUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedEnsureSafeUrl = vi.mocked(ensureSafeUrl);

const mockRepo = {
  getSettings: vi.fn(),
  upsertSettings: vi.fn(),
  recordCheck: vi.fn(),
  findLibraryFolders: vi.fn(),
};

const mockSecretService = {
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
};

const mockSession = {
  getServerInfo: vi.fn(),
  getSettings: vi.fn(),
};

const mockClient = {
  createSession: vi.fn().mockReturnValue(mockSession),
};

const mockLibraryService = {
  verifyUserAccess: vi.fn(),
  findOne: vi.fn(),
};

const user = { id: 1, isSuperuser: false } as unknown as RequestUser;

function makeService() {
  return new StorytellerSettingsService(mockRepo as never, mockSecretService as never, mockClient as never, mockLibraryService as never);
}

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    serverUrl: 'https://storyteller.example.com',
    username: 'bookorbit',
    passwordEnc: 'enc:secret',
    pathMappings: [{ localPrefix: '/books', remotePrefix: '/mnt/books' }],
    targetLibraryId: 7,
    targetFolderId: null,
    transport: 'auto',
    deleteRemoteAfterImport: false,
    collectionName: null,
    lastCheckedAt: null,
    lastCheckResult: null,
    ...overrides,
  };
}

function libraryRow(overrides: Record<string, unknown> = {}) {
  return { organizationMode: 'book_per_file', allowedFormats: [] as string[], ...overrides };
}

const DEFAULT_FOLDERS = [{ id: 1, path: '/books/read-along' }];

describe('StorytellerSettingsService.getSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns defaults and never leaks the password when no row exists', async () => {
    mockRepo.getSettings.mockResolvedValue(undefined);

    await expect(makeService().getSettings()).resolves.toEqual({
      serverUrl: null,
      username: null,
      passwordConfigured: false,
      pathMappings: [],
      targetLibraryId: null,
      targetFolderId: null,
      transport: 'auto',
      deleteRemoteAfterImport: true,
      collectionName: null,
      lastCheckedAt: null,
      lastCheck: null,
    });
  });

  it('defaults deleteRemoteAfterImport to the column default so a first save does not flip it', async () => {
    mockRepo.getSettings.mockResolvedValue(undefined);

    await expect(makeService().getSettings()).resolves.toMatchObject({ deleteRemoteAfterImport: true });
  });

  it('reports passwordConfigured without exposing the encrypted value', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    const result = await makeService().getSettings();

    expect(result.passwordConfigured).toBe(true);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('passwordEnc');
  });
});

describe('StorytellerSettingsService.upsertSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnsureSafeUrl.mockResolvedValue(undefined as never);
    mockRepo.getSettings.mockResolvedValue(undefined);
    mockRepo.upsertSettings.mockResolvedValue(settingsRow());
  });

  it('normalizes and saves the server URL', async () => {
    await makeService().upsertSettings({ serverUrl: 'https://storyteller.example.com/api/' }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://storyteller.example.com/api' }));
  });

  it('rejects an invalid server URL', async () => {
    await expect(makeService().upsertSettings({ serverUrl: 'not a url' }, user)).rejects.toThrow(BadRequestException);
    expect(mockRepo.upsertSettings).not.toHaveBeenCalled();
  });

  it('treats an empty server URL as an explicit clear instead of failing the whole payload', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await makeService().upsertSettings({ serverUrl: '   ', collectionName: 'Read-alongs' }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: null, collectionName: 'Read-alongs' }));
    expect(mockedEnsureSafeUrl).not.toHaveBeenCalled();
  });

  it('encrypts a provided password and clears it on an empty string', async () => {
    await makeService().upsertSettings({ password: 'super-secret' }, user);
    expect(mockSecretService.encrypt).toHaveBeenCalledWith('super-secret');
    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ passwordEnc: 'enc:super-secret' }));

    vi.clearAllMocks();
    mockRepo.getSettings.mockResolvedValue(undefined);
    mockRepo.upsertSettings.mockResolvedValue(settingsRow());
    await makeService().upsertSettings({ password: '' }, user);
    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ passwordEnc: null }));
  });

  it('omits passwordEnc entirely when the password field is not sent', async () => {
    await makeService().upsertSettings({ username: 'bookorbit' }, user);

    const saved = mockRepo.upsertSettings.mock.calls[0]![0];
    expect(saved).not.toHaveProperty('passwordEnc');
  });

  // The stored secret belongs to the stored host. Leaving it in place while the URL moves would
  // re-bind it to a server nobody proved it against, and the next build would post it there without
  // the test endpoint - which enforces this on its own path - ever being involved.
  it('clears the stored password when the saved server URL changes without a new password', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await makeService().upsertSettings({ serverUrl: 'https://attacker.example.com' }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://attacker.example.com', passwordEnc: null }));
  });

  it('clears the stored password when the server URL is erased', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await makeService().upsertSettings({ serverUrl: '   ' }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: null, passwordEnc: null }));
  });

  it('keeps the stored password when the saved server URL only renormalizes to the same host', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await makeService().upsertSettings({ serverUrl: 'https://storyteller.example.com/' }, user);

    const saved = mockRepo.upsertSettings.mock.calls[0]![0];
    expect(saved).not.toHaveProperty('passwordEnc');
  });

  it('accepts a new host when the same payload carries the password for it', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await makeService().upsertSettings({ serverUrl: 'https://new-host.example.com', password: 'new-secret' }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://new-host.example.com', passwordEnc: 'enc:new-secret' }),
    );
  });

  it('normalizes path mappings and rejects an unmappable prefix', async () => {
    await makeService().upsertSettings({ pathMappings: [{ localPrefix: '/books/', remotePrefix: '/mnt/books/' }] }, user);
    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pathMappings: [{ localPrefix: '/books', remotePrefix: '/mnt/books' }] }),
    );

    await expect(makeService().upsertSettings({ pathMappings: [{ localPrefix: '/', remotePrefix: '/mnt/books' }] }, user)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('validates the target library exists, allows epub, and checks access', async () => {
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockResolvedValue(libraryRow());
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    await makeService().upsertSettings({ targetLibraryId: 7 }, user);

    expect(mockLibraryService.verifyUserAccess).toHaveBeenCalledWith(user.id, 7, user.isSuperuser);
    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ targetLibraryId: 7 }));
  });

  it('rejects a target library that no longer exists', async () => {
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockRejectedValue(new NotFoundException('Library not found'));

    await expect(makeService().upsertSettings({ targetLibraryId: 99 }, user)).rejects.toThrow(NotFoundException);
  });

  it('rejects a target library that disallows epub', async () => {
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['pdf'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    await expect(makeService().upsertSettings({ targetLibraryId: 7 }, user)).rejects.toThrow(BadRequestException);
  });

  it('rejects a target folder that does not belong to the target library', async () => {
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockResolvedValue(libraryRow());
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    await expect(makeService().upsertSettings({ targetLibraryId: 7, targetFolderId: 999 }, user)).rejects.toThrow(BadRequestException);
  });

  it('propagates a library access failure', async () => {
    mockLibraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access to this library'));

    await expect(makeService().upsertSettings({ targetLibraryId: 7 }, user)).rejects.toThrow(ForbiddenException);
  });

  it('skips library validation when targetLibraryId is explicitly cleared to null', async () => {
    await makeService().upsertSettings({ targetLibraryId: null }, user);

    expect(mockLibraryService.verifyUserAccess).not.toHaveBeenCalled();
    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ targetLibraryId: null }));
  });

  it('resets the stored folder to null when the library changes without a new folder, instead of validating the stale one', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ targetLibraryId: 3, targetFolderId: 42 }));
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockResolvedValue(libraryRow());
    // Folder 42 (the stale one) does not exist in the new library - this must not be checked at all.
    mockRepo.findLibraryFolders.mockResolvedValue([{ id: 1, path: '/books/read-along' }]);

    await makeService().upsertSettings({ targetLibraryId: 7 }, user);

    expect(mockRepo.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ targetLibraryId: 7, targetFolderId: null }));
  });

  it('validates a folder supplied alongside a library change against the new library', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ targetLibraryId: 3, targetFolderId: 42 }));
    mockLibraryService.verifyUserAccess.mockResolvedValue(undefined);
    mockLibraryService.findOne.mockResolvedValue(libraryRow());
    mockRepo.findLibraryFolders.mockResolvedValue([{ id: 1, path: '/books/read-along' }]);

    await expect(makeService().upsertSettings({ targetLibraryId: 7, targetFolderId: 999 }, user)).rejects.toThrow(BadRequestException);

    await makeService().upsertSettings({ targetLibraryId: 7, targetFolderId: 1 }, user);
    expect(mockRepo.upsertSettings).toHaveBeenLastCalledWith(expect.objectContaining({ targetLibraryId: 7, targetFolderId: 1 }));
  });
});

describe('StorytellerSettingsService.getConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when the connection is not fully configured', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ passwordEnc: null }));

    await expect(makeService().getConnection()).resolves.toBeNull();
  });

  it('decrypts the password when fully configured', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    await expect(makeService().getConnection()).resolves.toEqual({
      serverUrl: 'https://storyteller.example.com',
      username: 'bookorbit',
      password: 'secret',
    });
  });
});

describe('StorytellerSettingsService.testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.recordCheck.mockResolvedValue(undefined);
  });

  it('reports not configured without calling the client', async () => {
    mockRepo.getSettings.mockResolvedValue(undefined);

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/);
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, null);
  });

  it('tests the credentials in the payload rather than the stored ones, and does not record the check', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user, {
      serverUrl: 'https://draft.example.com/',
      username: ' draft-user ',
      password: 'typed-password',
    });

    expect(result.ok).toBe(true);
    expect(mockClient.createSession).toHaveBeenCalledWith({
      serverUrl: 'https://draft.example.com',
      username: 'draft-user',
      password: 'typed-password',
    });
    expect(mockSecretService.decrypt).not.toHaveBeenCalled();
    expect(mockRepo.recordCheck).not.toHaveBeenCalled();
  });

  it('falls back to the stored password when the payload repeats the saved server and user', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user, {
      serverUrl: 'https://storyteller.example.com',
      username: 'bookorbit',
    });

    expect(mockClient.createSession).toHaveBeenCalledWith({
      serverUrl: 'https://storyteller.example.com',
      username: 'bookorbit',
      password: 'secret',
    });
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('never sends the stored password to a host that is not the saved one', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    const result = await makeService().testConnection(user, { serverUrl: 'https://attacker.example', username: 'bookorbit' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Enter the password/);
    expect(mockSecretService.decrypt).not.toHaveBeenCalled();
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockSession.getServerInfo).not.toHaveBeenCalled();
    // The SSRF guard would have passed this host, so it is not what stops the request.
    expect(mockedEnsureSafeUrl).not.toHaveBeenCalled();
  });

  it('tests an unsaved host once the caller supplies its own password', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user, {
      serverUrl: 'https://other.example',
      username: 'bookorbit',
      password: 'typed-password',
    });

    expect(result.ok).toBe(true);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://other.example', password: 'typed-password' }),
    );
    expect(mockSecretService.decrypt).not.toHaveBeenCalled();
  });

  it('still uses the stored password when the payload URL differs only in normalization', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user, { serverUrl: '  https://storyteller.example.com/  ' });

    expect(result.ok).toBe(true);
    expect(mockClient.createSession).toHaveBeenCalledWith({
      serverUrl: 'https://storyteller.example.com',
      username: 'bookorbit',
      password: 'secret',
    });
    // The host resolves to the saved one, so this is not a draft and the check is recorded.
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('reports not configured, rather than a password prompt, when nothing is stored at all', async () => {
    mockRepo.getSettings.mockResolvedValue(undefined);

    const result = await makeService().testConnection(user, { serverUrl: 'https://new.example', username: 'bookorbit' });

    expect(result.error).toMatch(/not configured/);
    expect(mockRepo.recordCheck).not.toHaveBeenCalled();
  });

  it('rejects a payload server URL that is not http or https without calling the client', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());

    const result = await makeService().testConnection(user, { serverUrl: 'ftp://storyteller.example.com', username: 'bookorbit' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid http or https URL/);
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockRepo.recordCheck).not.toHaveBeenCalled();
  });

  it('guards a payload server URL through the SSRF check before fetching it', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockedEnsureSafeUrl.mockRejectedValueOnce(new Error('Blocked host'));

    const result = await makeService().testConnection(user, { serverUrl: 'http://169.254.169.254', username: 'bookorbit' });

    expect(result.ok).toBe(false);
    expect(mockSession.getServerInfo).not.toHaveBeenCalled();
  });

  it('reads the settings row only once, deriving the connection and the target from one snapshot', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'api-transfer' }));
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'INTERNAL',
      readaloudLocation: null,
      importMode: null,
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    await makeService().testConnection(user);

    expect(mockRepo.getSettings).toHaveBeenCalledTimes(1);
  });

  it('reports ok with no problems when everything is ready', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.sharedPathsReady).toBe(true);
    expect(result.effectiveTransport).toBe('shared-paths');
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('flags no path mappings, no target library, and a non-custom-folder location', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ targetLibraryId: null, pathMappings: [] }));
    mockSession.getServerInfo.mockResolvedValue({ version: '1.0.0', capabilities: ['metadata'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'SUFFIX',
      readaloudLocation: null,
      importMode: 'copy',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).toEqual(expect.arrayContaining(['no_path_mappings', 'target_library_missing', 'readaloud_location_not_custom_folder']));
    expect(result.sharedPathsReady).toBe(false);
    expect(result.effectiveTransport).toBe('api-transfer');
  });

  // The names a live Storyteller reports: the client merges `/server/details` capabilities with the
  // `/server/capabilities` feature map, and no build of it answers a bare 'books'. A check for that
  // literal raised a setup problem against every working server.
  it('raises no capability problem for the capabilities a live Storyteller reports', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '3.1.0', capabilities: ['book-upload', 'ctcDevices', 'readaloud-process'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('does not flag readaloud_folder_not_mapped when no_path_mappings already covers the cause', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths', pathMappings: [] }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).toContain('no_path_mappings');
    expect(result.problems).not.toContain('readaloud_folder_not_mapped');
  });

  it('does not flag the read-aloud location or path mappings when api-transfer is pinned', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'api-transfer', pathMappings: [] }));
    mockSession.getServerInfo.mockResolvedValue({ version: null, capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'SUFFIX',
      readaloudLocation: '(readaloud)',
      importMode: 'reference',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.effectiveTransport).toBe('api-transfer');
  });

  it('does not flag readaloud_folder_not_mapped when target_library_missing already covers the cause', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths', targetLibraryId: null }));
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).toContain('target_library_missing');
    expect(result.problems).not.toContain('readaloud_folder_not_mapped');
  });

  it('requires the mapped path to land specifically inside a configured target folder, not just any library folder', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths', targetLibraryId: 7, targetFolderId: 2 }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue([
      { id: 1, path: '/books/other-folder' },
      { id: 2, path: '/books/read-along' },
    ]);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    // Maps (via the /books <-> /mnt/books mapping) to /books/other-folder - a real library folder,
    // but not the one configured as the target.
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/other-folder',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.sharedPathsReady).toBe(false);
    expect(result.problems).toContain('readaloud_folder_not_mapped');
  });

  it('is ready when the mapped path lands inside the configured target folder specifically', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths', targetLibraryId: 7, targetFolderId: 2 }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue([
      { id: 1, path: '/books/other-folder' },
      { id: 2, path: '/books/read-along' },
    ]);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.sharedPathsReady).toBe(true);
    expect(result.problems).not.toContain('readaloud_folder_not_mapped');
  });

  // Shared-paths is usable when the read-along location resolves to the target library folder
  // itself, or the library is book_per_file. The scanner gives a root-level file its own book in
  // either organization mode, so only a nested location is a problem - and the build service applies
  // this same rule, which is why the two must agree.
  it('flags target_library_not_book_per_file when the read-along lands below the library folder', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_folder', allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along/storyteller',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    // Pinned shared-paths that the build would refuse resolves to no transport at all: reporting
    // 'shared-paths' here promised a transfer-free build that the build service never performs.
    expect(result.effectiveTransport).toBeNull();
    expect(result.problems).toContain('target_library_not_book_per_file');
  });

  // The user's live setup: a book_per_folder library whose folder root is where Storyteller writes.
  // It works, and two read-alongs were built through it, so the test must not call it a problem.
  it('does not flag target_library_not_book_per_file when the read-along lands in the library folder itself', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_folder', allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.sharedPathsReady).toBe(true);
    expect(result.problems).not.toContain('target_library_not_book_per_file');
  });

  // Folder paths come from the database as they were saved, so a stored trailing slash must not turn
  // the library folder itself into "somewhere below the library folder".
  it('treats a folder path with a trailing slash as the same folder', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_folder', allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue([{ id: 1, path: '/books/read-along/' }]);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).not.toContain('target_library_not_book_per_file');
  });

  it('does not flag target_library_not_book_per_file for a nested location in a book_per_file library', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'shared-paths' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_file', allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along/storyteller',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).not.toContain('target_library_not_book_per_file');
  });

  it('does not flag target_library_not_book_per_file when the resolved transport is api-transfer', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'api-transfer' }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_folder', allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: ['books'] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/mnt/books/read-along/storyteller',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });

    const result = await makeService().testConnection(user);

    expect(result.problems).not.toContain('target_library_not_book_per_file');
  });

  it('reports auth_failed for a 401 from the client', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockRejectedValue(new StorytellerClientError('unauthorized', 401));

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['auth_failed']);
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('reports server_unreachable for a network failure', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockRejectedValue(new Error('fetch failed'));

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['server_unreachable']);
  });

  it('reports a stored-password decrypt failure as auth_failed instead of throwing a 500', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSecretService.decrypt.mockImplementationOnce(() => {
      throw new InternalServerErrorException('Storyteller secret could not be decrypted');
    });

    const result = await makeService().testConnection(user);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['auth_failed']);
    expect(result.error).toBe('Stored password could not be decrypted');
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('caps a stored error message at 300 characters', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow());
    mockSession.getServerInfo.mockRejectedValue(new Error('x'.repeat(500)));

    const result = await makeService().testConnection(user);

    expect(result.error).toHaveLength(300);
  });

  // The round trip takes seconds, and a save during it re-points the single settings row at another
  // host. The result describes the host it ran against, so the write names that host and the
  // repository drops it if the row has moved on.
  it('records the check against the host that was tested', async () => {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'api-transfer' }));
    mockSession.getServerInfo.mockResolvedValue({ version: '1.2.3', capabilities: [] });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'INTERNAL',
      readaloudLocation: null,
      importMode: 'copy',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    const result = await makeService().testConnection(user);

    expect(mockRepo.recordCheck).toHaveBeenCalledWith(result, 'https://storyteller.example.com');
  });

  it('does not land a finished check on a row a concurrent save has re-pointed at another host', async () => {
    const row: { serverUrl: string | null; lastCheckResult: unknown } = { serverUrl: 'https://storyteller.example.com', lastCheckResult: null };
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport: 'api-transfer' }));
    // Stands in for the repository's conditional write.
    mockRepo.recordCheck.mockImplementation((result: unknown, testedServerUrl: string | null) => {
      if (testedServerUrl === row.serverUrl) row.lastCheckResult = result;
      return Promise.resolve();
    });
    mockSession.getServerInfo.mockImplementation(() => {
      row.serverUrl = 'https://other-host.example.com';
      return Promise.resolve({ version: '1.2.3', capabilities: [] });
    });
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'INTERNAL',
      readaloudLocation: null,
      importMode: 'copy',
      aligner: null,
      transcriptionEngine: null,
      alignmentGranularity: null,
    });
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ allowedFormats: ['epub'] }));
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);

    await makeService().testConnection(user);

    expect(mockRepo.recordCheck).toHaveBeenCalledWith(expect.anything(), 'https://storyteller.example.com');
    expect(row.lastCheckResult).toBeNull();
  });
});

/**
 * The pinned transport contract. `effectiveTransport` is what the build service's own transport
 * selection will answer for the same configuration, so the panel never promises a transfer-free
 * build that the build then performs by upload - or the reverse.
 *
 * "Fully viable" is all of: path mappings present, the target folder maps to a remote path, the
 * read-aloud location is a CUSTOM_FOLDER that maps back inside the target folder, and the read-along
 * becomes its own book (book_per_file, or the read-along lands at the target folder root).
 */
describe('StorytellerSettingsService.testConnection transport contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.recordCheck.mockResolvedValue(undefined);
    mockRepo.findLibraryFolders.mockResolvedValue(DEFAULT_FOLDERS);
    mockSession.getServerInfo.mockResolvedValue({ version: '3.1.0', capabilities: ['book-upload', 'readaloud-process'] });
  });

  // Only the last rule separates the two: a book_per_folder library whose read-along lands one
  // folder below the library folder is mapped end to end and still not viable.
  function arrangeSharedPaths(transport: string, fullyViable: boolean) {
    mockRepo.getSettings.mockResolvedValue(settingsRow({ transport }));
    mockLibraryService.findOne.mockResolvedValue(libraryRow({ organizationMode: 'book_per_folder', allowedFormats: ['epub'] }));
    mockSession.getSettings.mockResolvedValue({
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: fullyViable ? '/mnt/books/read-along' : '/mnt/books/read-along/storyteller',
      importMode: 'reference',
      aligner: 'whisper',
      transcriptionEngine: 'whisper',
      alignmentGranularity: 'word',
    });
  }

  it('answers api-transfer for a pinned api-transfer whatever shared paths could do', async () => {
    arrangeSharedPaths('api-transfer', true);

    await expect(makeService().testConnection(user)).resolves.toMatchObject({ effectiveTransport: 'api-transfer' });

    arrangeSharedPaths('api-transfer', false);

    await expect(makeService().testConnection(user)).resolves.toMatchObject({ effectiveTransport: 'api-transfer' });
  });

  it('resolves auto to shared-paths when they are fully viable', async () => {
    arrangeSharedPaths('auto', true);

    const result = await makeService().testConnection(user);

    expect(result.effectiveTransport).toBe('shared-paths');
    expect(result.sharedPathsReady).toBe(true);
  });

  it('resolves auto to api-transfer when the read-along would not become its own book', async () => {
    arrangeSharedPaths('auto', false);

    const result = await makeService().testConnection(user);

    expect(result.effectiveTransport).toBe('api-transfer');
    expect(result.sharedPathsReady).toBe(false);
    expect(result.problems).toContain('target_library_not_book_per_file');
  });

  it('resolves a pinned shared-paths to shared-paths when they are fully viable', async () => {
    arrangeSharedPaths('shared-paths', true);

    const result = await makeService().testConnection(user);

    expect(result.effectiveTransport).toBe('shared-paths');
    expect(result.sharedPathsReady).toBe(true);
  });

  it('leaves a pinned shared-paths without a transport when they are not fully viable', async () => {
    arrangeSharedPaths('shared-paths', false);

    const result = await makeService().testConnection(user);

    expect(result.effectiveTransport).toBeNull();
    expect(result.sharedPathsReady).toBe(false);
    expect(result.problems).toContain('target_library_not_book_per_file');
  });

  // The folder is mapped, so the specific problem is the organization mode, not the mapping.
  it('does not blame the path mapping for a read-along that is mapped but not its own book', async () => {
    arrangeSharedPaths('shared-paths', false);

    const result = await makeService().testConnection(user);

    expect(result.problems).not.toContain('readaloud_folder_not_mapped');
  });
});
