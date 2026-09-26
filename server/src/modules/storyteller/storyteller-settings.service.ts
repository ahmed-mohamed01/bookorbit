import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';

import type {
  StorytellerConnectionTestPayload,
  StorytellerConnectionTestResult,
  StorytellerEffectiveTransport,
  StorytellerPathMapping,
  StorytellerSetupProblem,
  StorytellerSettings,
  StorytellerTransport,
  UpsertStorytellerSettingsPayload,
} from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { StorytellerRepository } from './storyteller.repository';
import { StorytellerSecretService } from './storyteller-secret.service';
import { StorytellerClientError, StorytellerClientService } from './storyteller-client.service';
import { describeError } from './storyteller-log.utils';
import type { StorytellerConnection } from './storyteller-client.types';
import { assertMappablePathMappings, normalizePathMappings, toLocalPath, toRemotePath } from './storyteller-path.utils';
import { ensureSafeStorytellerUrl, parseAndNormalizeServerUrl } from './storyteller-url.utils';
import type { NewStorytellerSettingsRow } from './schema/storyteller.schema';

const UPDATE_EVENT = 'storyteller.settings.update';
const TEST_EVENT = 'storyteller.settings.test';
const ERROR_MESSAGE_MAX_LENGTH = 300;

interface StorytellerLibraryConstraints {
  organizationMode: string;
  allowedFormats: string[];
  folders: { id: number; path: string }[];
}

function normalizeFolderPath(path: string): string {
  return path.replace(/\/+$/, '');
}

function pathIsWithinFolder(candidate: string, folderPath: string): boolean {
  const normalizedFolder = normalizeFolderPath(folderPath);
  return candidate === normalizedFolder || candidate.startsWith(`${normalizedFolder}/`);
}

// Stricter than pathIsWithinFolder: the location IS the folder, not somewhere below it.
function pathIsFolderRoot(candidate: string, folderPath: string): boolean {
  return normalizeFolderPath(candidate) === normalizeFolderPath(folderPath);
}

/**
 * The single folder a build will use: the pinned one, or the first by id. Exported so the connection
 * test and the build judge the same folder - a check that accepted any folder of the library would
 * report a ready shared-paths setup that every build then rejects.
 */
export function resolveStorytellerTargetFolder<T extends { id: number }>(
  folders: readonly T[],
  targetFolderId: number | null | undefined,
): T | undefined {
  return targetFolderId == null ? folders[0] : folders.find((folder) => folder.id === targetFolderId);
}

@Injectable()
export class StorytellerSettingsService {
  private readonly logger = new Logger(StorytellerSettingsService.name);

  constructor(
    private readonly repo: StorytellerRepository,
    private readonly secretService: StorytellerSecretService,
    private readonly client: StorytellerClientService,
    private readonly libraryService: LibraryService,
  ) {}

  async getSettings(): Promise<StorytellerSettings> {
    const row = await this.repo.getSettings();
    return {
      serverUrl: row?.serverUrl ?? null,
      username: row?.username ?? null,
      passwordConfigured: Boolean(row?.passwordEnc),
      pathMappings: row?.pathMappings ?? [],
      targetLibraryId: row?.targetLibraryId ?? null,
      targetFolderId: row?.targetFolderId ?? null,
      transport: (row?.transport as StorytellerTransport | undefined) ?? 'auto',
      // Matches the column default, so the panel answers the same before and after a first save.
      deleteRemoteAfterImport: row?.deleteRemoteAfterImport ?? true,
      collectionName: row?.collectionName ?? null,
      lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
      lastCheck: row?.lastCheckResult ?? null,
    };
  }

  async upsertSettings(payload: UpsertStorytellerSettingsPayload, user: RequestUser): Promise<StorytellerSettings> {
    const startedAt = Date.now();
    this.logger.log(`[${UPDATE_EVENT}] [start] userId=${user.id} - settings update started`);

    const existing = await this.repo.getSettings();

    // An empty string clears the connection: running it through the URL parser would 400 the whole
    // payload over a field the caller was trying to erase.
    let normalizedUrl: string | null | undefined;
    if (payload.serverUrl !== undefined) {
      const trimmed = payload.serverUrl.trim();
      if (trimmed === '') {
        normalizedUrl = null;
      } else {
        normalizedUrl = parseAndNormalizeServerUrl(trimmed);
        if (!normalizedUrl) {
          throw new BadRequestException('Storyteller server URL must be a valid http or https URL');
        }
        await ensureSafeStorytellerUrl(normalizedUrl);
      }
    }

    const data: Partial<NewStorytellerSettingsRow> = {};
    if (normalizedUrl !== undefined) data.serverUrl = normalizedUrl;
    if (payload.username !== undefined) data.username = payload.username;

    // The stored password belongs to the stored server and to no other: keeping it across a host
    // change re-binds the secret to a server nobody proved it against, and the next build hands it
    // over without the test endpoint ever being involved.
    const hostChanged = normalizedUrl !== undefined && normalizedUrl !== (existing?.serverUrl ?? null);
    if (payload.password !== undefined) {
      data.passwordEnc = payload.password ? this.secretService.encrypt(payload.password) : null;
    } else if (hostChanged) {
      data.passwordEnc = null;
    }
    const passwordCleared = data.passwordEnc === null && Boolean(existing?.passwordEnc);

    // The recorded check describes the host it was run against: carried across a host change it
    // would block every build as `unreachable` on the old server's failure and describe the old
    // server's capabilities as the new one's.
    if (hostChanged) {
      data.lastCheckedAt = null;
      data.lastCheckResult = null;
    }

    if (payload.pathMappings !== undefined) {
      assertMappablePathMappings(payload.pathMappings);
      data.pathMappings = normalizePathMappings(payload.pathMappings);
    }
    if (payload.transport !== undefined) data.transport = payload.transport;
    if (payload.deleteRemoteAfterImport !== undefined) data.deleteRemoteAfterImport = payload.deleteRemoteAfterImport;
    if (payload.collectionName !== undefined) data.collectionName = payload.collectionName;
    if (payload.targetLibraryId !== undefined) data.targetLibraryId = payload.targetLibraryId;
    if (payload.targetFolderId !== undefined) {
      data.targetFolderId = payload.targetFolderId;
    } else if (payload.targetLibraryId !== undefined) {
      // A stored folder belongs to the old library: reset rather than validate a stale id.
      data.targetFolderId = null;
    }

    const effectiveLibraryId = payload.targetLibraryId !== undefined ? payload.targetLibraryId : (existing?.targetLibraryId ?? null);
    if (effectiveLibraryId === null) {
      // Nothing to validate against, so a folder id would be stored unchecked. Clearing stays allowed.
      if (payload.targetFolderId != null) {
        throw new BadRequestException('A target library is required before a target folder');
      }
    } else if (payload.targetLibraryId !== undefined || payload.targetFolderId !== undefined) {
      await this.assertUsableTargetLibrary(effectiveLibraryId, data.targetFolderId, user);
    }

    await this.repo.upsertSettings(data);
    this.logger.log(
      `[${UPDATE_EVENT}] [end] userId=${user.id} durationMs=${Date.now() - startedAt} transport=${data.transport ?? existing?.transport ?? 'auto'} passwordCleared=${passwordCleared} - settings saved`,
    );

    return this.getSettings();
  }

  /** Decrypted connection details for the build service. Null when the connection is not fully configured. */
  async getConnection(): Promise<StorytellerConnection | null> {
    const row = await this.repo.getSettings();
    if (!row?.serverUrl || !row.username || !row.passwordEnc) return null;
    return { serverUrl: row.serverUrl, username: row.username, password: this.secretService.decrypt(row.passwordEnc) };
  }

  /**
   * Tests a connection before it is saved: a sent field replaces the stored one and an omitted field
   * falls back to it, so the panel can verify typed credentials without the password ever being sent
   * back to the browser. The password does not fall back for an unsaved host - see below.
   */
  async testConnection(user: RequestUser, payload: StorytellerConnectionTestPayload = {}): Promise<StorytellerConnectionTestResult> {
    const startedAt = Date.now();

    // One snapshot for everything: a second read could race an in-flight settings update and report
    // on a mix of old and new configuration.
    const settingsRow = await this.repo.getSettings();

    const storedUrl = settingsRow?.serverUrl ?? null;
    const storedUsername = settingsRow?.username ?? null;

    let serverUrl = storedUrl;
    let urlFromPayload = false;
    if (payload.serverUrl !== undefined && payload.serverUrl.trim() !== storedUrl) {
      serverUrl = parseAndNormalizeServerUrl(payload.serverUrl.trim());
      urlFromPayload = true;
    }
    const username = payload.username !== undefined ? payload.username.trim() || null : storedUsername;
    const password = payload.password || null;

    // A payload pointing at a host nobody has saved must carry the password it wants tested:
    // falling back to the stored secret would post it to a server of the caller's choosing, which
    // the SSRF guard cannot tell from a legitimate move to a new public host.
    const unsavedHost = serverUrl !== storedUrl;
    const storedPasswordEnc = settingsRow?.passwordEnc ?? '';
    const storedPasswordUsable = storedPasswordEnc !== '' && !unsavedHost;

    // Typed-but-unsaved credentials must not overwrite `last_check_result`, which describes the
    // connection this server actually holds.
    const draft = unsavedHost || username !== storedUsername || password !== null;
    this.logger.log(`[${TEST_EVENT}] [start] userId=${user.id} draft=${draft} - connection test started`);

    if (!serverUrl || !username || (!password && !storedPasswordUsable)) {
      let message = 'Storyteller connection is not configured';
      if (urlFromPayload && !serverUrl) {
        message = 'Storyteller server URL must be a valid http or https URL';
      } else if (serverUrl && username && unsavedHost && storedPasswordEnc !== '') {
        message = 'Enter the password for this Storyteller server before testing it';
      }
      const result = this.buildFailureResult(message, []);
      if (!draft) await this.repo.recordCheck(result, serverUrl);
      this.logger.log(
        `[${TEST_EVENT}] [end] userId=${user.id} durationMs=${Date.now() - startedAt} draft=${draft} ok=false - connection test completed`,
      );
      return result;
    }

    try {
      // A payload URL has not been through the save path's guard.
      if (urlFromPayload) await ensureSafeStorytellerUrl(serverUrl);
      const connection: StorytellerConnection = {
        serverUrl,
        username,
        password: password ?? this.secretService.decrypt(storedPasswordEnc),
      };
      const session = this.client.createSession(connection);
      const [serverInfo, remoteSettings] = await Promise.all([session.getServerInfo(), session.getSettings()]);

      const pathMappings = settingsRow?.pathMappings ?? [];
      const transportSetting = (settingsRow?.transport as StorytellerTransport | undefined) ?? 'auto';
      const targetLibraryId = settingsRow?.targetLibraryId ?? null;
      const targetFolderId = settingsRow?.targetFolderId ?? null;
      const constraints = targetLibraryId !== null ? await this.resolveLibraryConstraints(targetLibraryId) : undefined;

      const problems: StorytellerSetupProblem[] = [];
      if ((transportSetting === 'auto' || transportSetting === 'shared-paths') && pathMappings.length === 0) {
        problems.push('no_path_mappings');
      }
      if (targetLibraryId === null || !constraints) {
        problems.push('target_library_missing');
      } else if (constraints.allowedFormats.length > 0 && !constraints.allowedFormats.includes('epub')) {
        problems.push('target_library_disallows_epub');
      }
      // Only shared-paths cares where Storyteller writes: an uploaded book's read-aloud stays
      // internal whatever this is set to.
      if ((transportSetting === 'auto' || transportSetting === 'shared-paths') && remoteSettings.readaloudLocationType !== 'CUSTOM_FOLDER') {
        problems.push('readaloud_location_not_custom_folder');
      }

      const sharedPaths = this.evaluateSharedPaths(
        remoteSettings.readaloudLocationType,
        remoteSettings.readaloudLocation,
        pathMappings,
        constraints,
        targetFolderId,
      );
      const sharedPathsConsidered = transportSetting === 'auto' || transportSetting === 'shared-paths';
      // Only a real "we can see where this lands, and it's wrong"; the missing-mapping and
      // missing-library cases have their own, more specific problems above.
      if (
        sharedPathsConsidered &&
        remoteSettings.readaloudLocationType === 'CUSTOM_FOLDER' &&
        pathMappings.length > 0 &&
        constraints !== undefined &&
        !sharedPaths.mappedIntoTargetFolder
      ) {
        problems.push('readaloud_folder_not_mapped');
      }
      // The mapping is fine here and the organization mode is not, so this stays the explanation of
      // why shared paths are unusable even though nothing resolves to shared-paths below.
      if (sharedPathsConsidered && sharedPaths.mappedIntoTargetFolder && !sharedPaths.fullyViable) {
        problems.push('target_library_not_book_per_file');
      }

      const effectiveTransport = this.resolveEffectiveTransport(transportSetting, sharedPaths.fullyViable);

      const result: StorytellerConnectionTestResult = {
        ok: true,
        checkedAt: new Date().toISOString(),
        serverVersion: serverInfo.version,
        capabilities: serverInfo.capabilities,
        readaloudLocationType: remoteSettings.readaloudLocationType,
        readaloudLocation: remoteSettings.readaloudLocation,
        importMode: remoteSettings.importMode,
        aligner: remoteSettings.aligner,
        sharedPathsReady: sharedPaths.fullyViable,
        effectiveTransport,
        problems,
        error: null,
      };
      if (!draft) await this.repo.recordCheck(result, serverUrl);
      this.logger.log(
        `[${TEST_EVENT}] [end] userId=${user.id} durationMs=${Date.now() - startedAt} draft=${draft} ok=${result.ok} problems=${problems.length} - connection test completed`,
      );
      return result;
    } catch (err) {
      const isDecryptFailure = err instanceof InternalServerErrorException;
      const { errorClass, message } = describeError(err);
      const errorMessage = (isDecryptFailure ? 'Stored password could not be decrypted' : message).slice(0, ERROR_MESSAGE_MAX_LENGTH);
      const problems: StorytellerSetupProblem[] = [
        isDecryptFailure || (err instanceof StorytellerClientError && err.status === 401) ? 'auth_failed' : 'server_unreachable',
      ];
      const result = this.buildFailureResult(errorMessage, problems);
      if (!draft) await this.repo.recordCheck(result, serverUrl);
      this.logger.error(
        `[${TEST_EVENT}] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} draft=${draft} errorClass=${errorClass} error="${sanitizeLogValue(errorMessage)}" - connection test failed`,
      );
      return result;
    }
  }

  private async assertUsableTargetLibrary(libraryId: number, targetFolderId: number | null | undefined, user: RequestUser): Promise<void> {
    await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    const constraints = await this.resolveLibraryConstraints(libraryId);
    if (!constraints) throw new NotFoundException('Target library not found');
    if (constraints.allowedFormats.length > 0 && !constraints.allowedFormats.includes('epub')) {
      throw new BadRequestException('Target library does not allow epub files');
    }
    if (targetFolderId != null && !constraints.folders.some((folder) => folder.id === targetFolderId)) {
      throw new BadRequestException('Target folder does not belong to the target library');
    }
  }

  // organizationMode/allowedFormats come from LibraryService so the normalization matches every
  // other library read; the folder list is this module's own query.
  private async resolveLibraryConstraints(libraryId: number): Promise<StorytellerLibraryConstraints | undefined> {
    let library: { organizationMode: string; allowedFormats: string[] };
    try {
      library = await this.libraryService.findOne(libraryId);
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
    const folders = await this.repo.findLibraryFolders(libraryId);
    return { organizationMode: library.organizationMode, allowedFormats: library.allowedFormats, folders };
  }

  /**
   * Where Storyteller's read-aloud folder lands locally, relative to the one folder a build targets.
   * `mappedIntoTargetFolder` is "inside the folder BookOrbit scans"; `fullyViable` adds the last rule
   * shared paths need, that the read-along becomes its own book - a root-level file does in either
   * organization mode, but one folder deeper a book_per_folder scan folds the whole subfolder into
   * one book.
   *
   * Every condition below is one the build applies too: an answer this check gives that the next
   * build would not is worse than no answer, because nothing contradicts it in the panel.
   */
  private evaluateSharedPaths(
    readaloudLocationType: string | null,
    readaloudLocation: string | null,
    pathMappings: StorytellerPathMapping[],
    constraints: StorytellerLibraryConstraints | undefined,
    targetFolderId: number | null,
  ): { mappedIntoTargetFolder: boolean; fullyViable: boolean } {
    const unusable = { mappedIntoTargetFolder: false, fullyViable: false };
    if (readaloudLocationType !== 'CUSTOM_FOLDER' || !readaloudLocation || !constraints || pathMappings.length === 0) return unusable;
    // Resolved exactly as the build resolves it, or this passes a setup whose builds all land elsewhere.
    const folder = resolveStorytellerTargetFolder(constraints.folders, targetFolderId);
    if (!folder) return unusable;
    // The build falls back to api-transfer when no mapping covers the target folder. A mapping
    // rooted below the folder translates the read-aloud location and nothing else.
    if (!toRemotePath(folder.path, pathMappings)) return unusable;
    const mappedLocal = toLocalPath(readaloudLocation, pathMappings);
    if (!mappedLocal) return unusable;
    const mappedIntoTargetFolder = pathIsWithinFolder(mappedLocal, folder.path);
    const becomesItsOwnBook = constraints.organizationMode === 'book_per_file' || pathIsFolderRoot(mappedLocal, folder.path);
    return { mappedIntoTargetFolder, fullyViable: mappedIntoTargetFolder && becomesItsOwnBook };
  }

  private resolveEffectiveTransport(transportSetting: StorytellerTransport, fullyViable: boolean): StorytellerEffectiveTransport | null {
    if (transportSetting === 'api-transfer') return 'api-transfer';
    if (transportSetting === 'shared-paths') return fullyViable ? 'shared-paths' : null;
    return fullyViable ? 'shared-paths' : 'api-transfer';
  }

  private buildFailureResult(error: string, problems: StorytellerSetupProblem[]): StorytellerConnectionTestResult {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      serverVersion: null,
      capabilities: [],
      readaloudLocationType: null,
      readaloudLocation: null,
      importMode: null,
      aligner: null,
      sharedPathsReady: false,
      effectiveTransport: null,
      problems,
      error,
    };
  }
}
