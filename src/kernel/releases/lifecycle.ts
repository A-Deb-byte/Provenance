import crypto from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { buildReleaseAuthorizationPayload, verifyReleaseSignature } from '../autonomy';
import type { ReleaseProposal } from '../types';
import type {
  ActiveReleaseManifest,
  ReleaseLifecycleOptions,
  StagedReleaseActivationResult,
  StagedReleaseFile,
  StagedReleasePackage,
  PreparedReleaseProcess,
} from './types';

const MAX_RELEASE_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RELEASE_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ACTIVE_MANIFEST = 'active-release.json';
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const sha256 = (value: string | Buffer): string => (
  crypto.createHash('sha256').update(value).digest('hex')
);

const isControlledRelativePath = (value: string): boolean => {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  const parts = value.split('/');
  return value.toLowerCase() !== 'release-manifest.json' && parts.every((part) => (
    part.length > 0 && part !== '.' && part !== '..' && !part.includes(':') &&
    !part.endsWith('.') && !part.endsWith(' ') && !WINDOWS_RESERVED_NAME.test(part)
  ));
};

const isTrimmedText = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
);

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isActiveReleaseManifest = (value: unknown): value is ActiveReleaseManifest => (
  isRecord(value) &&
  value.schemaVersion === 1 &&
  isTrimmedText(value.releaseId) &&
  isTrimmedText(value.artifactId) &&
  typeof value.targetVersion === 'string' && VERSION_PATTERN.test(value.targetVersion) &&
  typeof value.contentHash === 'string' && SHA256_PATTERN.test(value.contentHash) &&
  typeof value.releaseDirectory === 'string' && RELEASE_DIRECTORY_PATTERN.test(value.releaseDirectory) &&
  typeof value.entrypoint === 'string' && isControlledRelativePath(value.entrypoint) &&
  value.entrypoint.toLowerCase().endsWith('.cjs') &&
  isCanonicalTimestamp(value.activatedAt) &&
  (value.previousReleaseId === undefined || isTrimmedText(value.previousReleaseId))
);

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const decodeFile = (file: StagedReleaseFile): Buffer => {
  if (!BASE64_PATTERN.test(file.contentBase64)) throw new Error(`Release file ${file.path} has invalid base64 content.`);
  const decoded = Buffer.from(file.contentBase64, 'base64');
  if (decoded.byteLength > MAX_FILE_BYTES) throw new Error(`Release file ${file.path} exceeds the size limit.`);
  if (sha256(decoded) !== file.contentHash) throw new Error(`Release file ${file.path} failed its content hash.`);
  return decoded;
};

const parsePackage = (content: string, targetVersion: string): {
  releasePackage: StagedReleasePackage;
  decodedFiles: Array<{ file: StagedReleaseFile; content: Buffer }>;
} => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Staged release artifact is not valid JSON.');
  }
  if (
    !isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.targetVersion !== targetVersion ||
    !VERSION_PATTERN.test(targetVersion) || typeof parsed.entrypoint !== 'string' ||
    !isControlledRelativePath(parsed.entrypoint) || !parsed.entrypoint.toLowerCase().endsWith('.cjs') ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 || parsed.files.length > MAX_RELEASE_FILES
  ) {
    throw new Error('Staged release package metadata is invalid.');
  }

  const files: StagedReleaseFile[] = parsed.files.map((value) => {
    if (
      !isRecord(value) || typeof value.path !== 'string' || !isControlledRelativePath(value.path) ||
      typeof value.contentBase64 !== 'string' || typeof value.contentHash !== 'string' ||
      !SHA256_PATTERN.test(value.contentHash)
    ) {
      throw new Error('Staged release package contains an invalid file entry.');
    }
    return { path: value.path, contentBase64: value.contentBase64, contentHash: value.contentHash };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('Staged release package contains duplicate file paths.');
  }
  if (!files.some((file) => file.path === parsed.entrypoint)) {
    throw new Error('Staged release package does not contain its declared Node entrypoint.');
  }
  const decodedFiles = files.map((file) => ({ file, content: decodeFile(file) }));
  if (decodedFiles.reduce((total, file) => total + file.content.byteLength, 0) > MAX_PACKAGE_BYTES) {
    throw new Error('Staged release package exceeds the total size limit.');
  }
  return {
    releasePackage: { schemaVersion: 1, targetVersion, entrypoint: parsed.entrypoint, files },
    decodedFiles,
  };
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const readActive = async (manifestPath: string): Promise<{
  raw?: string;
  manifest?: ActiveReleaseManifest;
  invalid?: boolean;
}> => {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { raw, invalid: true };
    }
    return isActiveReleaseManifest(parsed)
      ? { raw, manifest: parsed }
      : { raw, invalid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
};

const atomicWrite = async (target: string, content: string): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
};

const blocked = (
  reasonCode: StagedReleaseActivationResult['reasonCode'],
  reason: string,
): StagedReleaseActivationResult => ({ status: 'blocked', reasonCode, reason });

/**
 * Creates a serialized staged-release activator. Packages are decoded from a
 * JSON artifact rather than extracted as archives, and every output path is
 * constructed beneath releasesDir. Source/project files are never targets.
 */
export const createReleaseLifecycle = (options: ReleaseLifecycleOptions) => {
  const releasesRoot = path.resolve(options.releasesDir);
  const installedRoot = path.join(releasesRoot, 'installed');
  const stagingRoot = path.join(releasesRoot, '.staging');
  const activeManifestPath = path.join(releasesRoot, ACTIVE_MANIFEST);
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const clearSupervisor = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.supervisor.shutdown();
      } catch {
        // A second shutdown attempt plus the observable status determines whether cleanup succeeded.
      }
      try {
        const status = options.supervisor.getStatus();
        if (!status.activeReleaseId && status.pendingReleaseIds.length === 0) return true;
      } catch {
        // A supervisor whose state cannot be inspected is not safe to restore through.
      }
    }
    return false;
  };

  const verifyInstalledPackage = async (
    releaseDir: string,
    decodedFiles: Array<{ file: StagedReleaseFile; content: Buffer }>,
  ): Promise<void> => {
    const installedMetadata = await lstat(installedRoot);
    const releaseMetadata = await lstat(releaseDir);
    if (
      installedMetadata.isSymbolicLink() || !installedMetadata.isDirectory() ||
      releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()
    ) {
      throw new Error('Installed release directory is not a regular controlled directory.');
    }
    const canonicalInstalledRoot = await realpath(installedRoot);
    const canonicalReleaseDir = await realpath(releaseDir);
    if (!isWithinRoot(canonicalInstalledRoot, canonicalReleaseDir)) {
      throw new Error('Installed release directory escaped the controlled releases root.');
    }

    const verifiedDirectories = new Set<string>();
    for (const entry of decodedFiles) {
      const segments = entry.file.path.split('/');
      let directory = releaseDir;
      for (const segment of segments.slice(0, -1)) {
        directory = path.join(directory, segment);
        if (verifiedDirectories.has(directory)) continue;
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Installed release directory is invalid for ${entry.file.path}.`);
        }
        verifiedDirectories.add(directory);
      }

      const installedPath = path.resolve(releaseDir, ...segments);
      if (!isWithinRoot(releaseDir, installedPath)) {
        throw new Error(`Installed release file escaped its package root: ${entry.file.path}.`);
      }
      const metadata = await lstat(installedPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Installed release file is not a regular file: ${entry.file.path}.`);
      }
      const canonicalFile = await realpath(installedPath);
      if (!isWithinRoot(canonicalReleaseDir, canonicalFile)) {
        throw new Error(`Installed release file escaped its package root: ${entry.file.path}.`);
      }
      if (sha256(await readFile(installedPath)) !== entry.file.contentHash) {
        throw new Error(`Installed release file failed its signed content hash: ${entry.file.path}.`);
      }
    }
  };

  const activateOnce = async (
    proposal: ReleaseProposal,
    artifactId: string,
  ): Promise<StagedReleaseActivationResult> => {
    if (proposal.activationState === 'activated' || proposal.activationState === 'rejected') {
      return blocked('proposal_state_invalid', 'Only proposed or previously blocked releases may be staged.');
    }
    if (!proposal.signature) return blocked('signature_missing', 'Release proposal has no Ed25519 signature.');
    if (!verifyReleaseSignature(options.publicKey.trim(), proposal, proposal.signature)) {
      return blocked('signature_invalid', 'Release authorization signature failed verification.');
    }
    const authorization = buildReleaseAuthorizationPayload(proposal);
    for (const eventId of authorization.evaluationEventIds) {
      if (!await options.verifyEvaluationReference(eventId)) {
        return blocked('evaluation_unverified', `Release evaluation reference is not verified: ${eventId}.`);
      }
    }

    const artifact = await options.resolveArtifact(artifactId);
    if (!artifact) return blocked('artifact_missing', 'Staged release artifact was not found.');
    if (
      artifact.contentHash !== proposal.contentHash ||
      sha256(Buffer.from(artifact.content, 'utf8')) !== proposal.contentHash
    ) {
      return blocked('artifact_hash_mismatch', 'Staged artifact does not match the signed release content hash.');
    }

    let releasePackage: StagedReleasePackage;
    let decodedFiles: Array<{ file: StagedReleaseFile; content: Buffer }>;
    try {
      ({ releasePackage, decodedFiles } = parsePackage(artifact.content, proposal.targetVersion));
    } catch (error) {
      return blocked('package_invalid', error instanceof Error ? error.message : 'Staged release package is invalid.');
    }

    const releaseDirectory = `${proposal.targetVersion}-${proposal.contentHash.slice(0, 12)}`;
    const finalDir = path.join(installedRoot, releaseDirectory);
    if (await exists(finalDir)) return blocked('release_already_installed', 'The signed release package is already installed.');

    const stagingDir = path.join(stagingRoot, `${releaseDirectory}-${crypto.randomUUID()}`);
    const previous = await readActive(activeManifestPath);
    if (previous.invalid) {
      return blocked('active_manifest_invalid', 'The persisted active release manifest is invalid.');
    }
    const now = options.now?.() ?? new Date().toISOString();
    const manifest: ActiveReleaseManifest = {
      schemaVersion: 1,
      releaseId: proposal.id,
      artifactId,
      targetVersion: proposal.targetVersion,
      contentHash: proposal.contentHash,
      releaseDirectory,
      entrypoint: releasePackage.entrypoint,
      activatedAt: now,
      previousReleaseId: previous.manifest?.releaseId,
    };
    let installed = false;
    let switched = false;
    let preparedProcess: PreparedReleaseProcess | undefined;
    let activationFailure = false;
    let commitAttempted = false;

    try {
      await mkdir(stagingDir, { recursive: true });
      for (const entry of decodedFiles) {
        const destination = path.join(stagingDir, ...entry.file.path.split('/'));
        const relative = path.relative(stagingDir, destination);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Release path escaped its staging directory.');
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, entry.content, { mode: 0o600 });
      }
      await writeFile(path.join(stagingDir, 'release-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        releaseId: proposal.id,
        artifactId,
        targetVersion: proposal.targetVersion,
        contentHash: proposal.contentHash,
        entrypoint: releasePackage.entrypoint,
        files: decodedFiles.map(({ file }) => ({ path: file.path, contentHash: file.contentHash })),
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await mkdir(installedRoot, { recursive: true });
      await rename(stagingDir, finalDir);
      installed = true;

      const health = await options.healthCheck({ proposal, manifest, releaseDir: finalDir });
      if (!health.ok) {
        activationFailure = true;
        throw new Error(health.reason || 'Release health check failed.');
      }
      try {
        preparedProcess = await options.supervisor.prepare({ manifest, releaseDir: finalDir });
      } catch (error) {
        activationFailure = true;
        throw new Error(`Release process readiness failed: ${error instanceof Error ? error.message : 'unknown readiness error'}`);
      }

      await atomicWrite(activeManifestPath, JSON.stringify(manifest, null, 2));
      switched = true;
      commitAttempted = true;
      await options.supervisor.commit(preparedProcess);
      preparedProcess = undefined;

      return {
        status: 'activated', reasonCode: 'activated', reason: 'Signed staged release installed and its supervised core process passed readiness.',
        manifest, previousManifest: previous.manifest,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Release installation failed.';
      let cleanupIssue: string | undefined;
      if (preparedProcess) {
        try {
          await options.supervisor.abort(preparedProcess);
        } catch (abortError) {
          cleanupIssue = `candidate abort failed: ${abortError instanceof Error ? abortError.message : 'unknown abort error'}`;
        }
      }
      if (commitAttempted) {
        cleanupIssue ??= 'release commit failed after manifest switch; prior process-tree ownership is uncertain';
      }
      try {
        const processStatus = options.supervisor.getStatus();
        if (processStatus.pendingReleaseIds.length > 0) {
          cleanupIssue ??= `supervisor still tracks pending releases: ${processStatus.pendingReleaseIds.join(', ')}`;
        }
      } catch (statusError) {
        cleanupIssue ??= `supervisor status could not be inspected: ${statusError instanceof Error ? statusError.message : 'unknown status error'}`;
      }
      const cleanupCleared = cleanupIssue ? await clearSupervisor() : true;
      let manifestRollbackError: unknown;
      if (switched) {
        try {
          if (previous.raw !== undefined) await atomicWrite(activeManifestPath, previous.raw);
          else await rm(activeManifestPath, { force: true });
        } catch (rollbackError) {
          manifestRollbackError = rollbackError;
        }
      }
      if (installed && cleanupCleared) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (manifestRollbackError) {
        const cleanupSuffix = cleanupIssue
          ? ` Process cleanup also failed (${cleanupIssue}); supervisor-wide cleanup ${cleanupCleared ? 'completed' : 'could not be confirmed'}.`
          : '';
        return {
          status: 'rollback_failed',
          reasonCode: 'rollback_failed',
          reason: `Release failed (${reason}) and the active manifest could not be restored: ${manifestRollbackError instanceof Error ? manifestRollbackError.message : 'unknown rollback error'}.${cleanupSuffix}`,
          manifest, previousManifest: previous.manifest,
        };
      }
      if (cleanupIssue) {
        return {
          status: 'rollback_failed',
          reasonCode: 'rollback_failed',
          reason: `Release failed (${reason}) and process-tree cleanup was not completed by the candidate operation (${cleanupIssue}); supervisor-wide cleanup ${cleanupCleared ? 'completed but stopped the prior active process' : 'could not be confirmed'}.`,
          manifest,
          previousManifest: previous.manifest,
        };
      }
      if (switched) {
        return {
          status: 'rolled_back', reasonCode: 'health_check_failed', reason,
          manifest, previousManifest: previous.manifest,
        };
      }
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (activationFailure) {
        return {
          status: 'rolled_back', reasonCode: 'health_check_failed', reason,
          manifest, previousManifest: previous.manifest,
        };
      }
      return blocked('install_failed', reason);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const restoreOnce = async (
    proposal: ReleaseProposal,
  ): Promise<StagedReleaseActivationResult> => {
    if (!await clearSupervisor()) {
      return blocked(
        'process_restore_failed',
        'Existing supervised release processes could not be cleared before restore.',
      );
    }

    let active: Awaited<ReturnType<typeof readActive>>;
    try {
      active = await readActive(activeManifestPath);
    } catch {
      return blocked('active_manifest_invalid', 'The persisted active release manifest could not be read.');
    }
    if (active.raw === undefined) {
      return blocked('active_manifest_missing', 'No persisted active release manifest exists to restore.');
    }
    if (active.invalid || !active.manifest) {
      return blocked('active_manifest_invalid', 'The persisted active release manifest is invalid.');
    }
    const manifest = active.manifest;

    if (proposal.activationState !== 'activated') {
      return blocked('proposal_state_invalid', 'Only an activated kernel release proposal may be restored.');
    }
    const expectedReleaseDirectory = `${proposal.targetVersion}-${proposal.contentHash.slice(0, 12)}`;
    if (
      manifest.releaseId !== proposal.id ||
      manifest.targetVersion !== proposal.targetVersion ||
      manifest.contentHash !== proposal.contentHash ||
      manifest.releaseDirectory !== expectedReleaseDirectory
    ) {
      return blocked(
        'active_manifest_mismatch',
        'The persisted active manifest does not match the activated kernel release proposal.',
      );
    }
    if (!proposal.signature) {
      return blocked('signature_missing', 'The activated release proposal has no Ed25519 signature.');
    }
    if (!verifyReleaseSignature(options.publicKey.trim(), proposal, proposal.signature)) {
      return blocked('signature_invalid', 'The activated release authorization signature failed verification.');
    }

    let authorization: ReturnType<typeof buildReleaseAuthorizationPayload>;
    try {
      authorization = buildReleaseAuthorizationPayload(proposal);
    } catch {
      return blocked('signature_invalid', 'The activated release authorization payload is invalid.');
    }
    for (const eventId of authorization.evaluationEventIds) {
      try {
        if (!await options.verifyEvaluationReference(eventId)) {
          return blocked('evaluation_unverified', `Release evaluation reference is not verified: ${eventId}.`);
        }
      } catch {
        return blocked('evaluation_unverified', `Release evaluation reference could not be verified: ${eventId}.`);
      }
    }

    let artifact: Awaited<ReturnType<ReleaseLifecycleOptions['resolveArtifact']>>;
    try {
      artifact = await options.resolveArtifact(manifest.artifactId);
    } catch {
      return blocked('artifact_missing', 'The persisted release artifact could not be resolved.');
    }
    if (!artifact) return blocked('artifact_missing', 'The persisted release artifact was not found.');
    if (
      artifact.contentHash !== proposal.contentHash ||
      sha256(Buffer.from(artifact.content, 'utf8')) !== proposal.contentHash
    ) {
      return blocked('artifact_hash_mismatch', 'The persisted artifact does not match the signed release content hash.');
    }

    let releasePackage: StagedReleasePackage;
    let decodedFiles: Array<{ file: StagedReleaseFile; content: Buffer }>;
    try {
      ({ releasePackage, decodedFiles } = parsePackage(artifact.content, proposal.targetVersion));
    } catch (error) {
      return blocked(
        'package_invalid',
        error instanceof Error ? error.message : 'The persisted staged release package is invalid.',
      );
    }
    if (releasePackage.entrypoint !== manifest.entrypoint) {
      return blocked(
        'active_manifest_mismatch',
        'The persisted active manifest entrypoint does not match the signed release package.',
      );
    }

    const releaseDir = path.join(installedRoot, manifest.releaseDirectory);
    try {
      await verifyInstalledPackage(releaseDir, decodedFiles);
    } catch (error) {
      return blocked(
        'installed_release_invalid',
        error instanceof Error ? error.message : 'The installed release failed integrity verification.',
      );
    }

    let health;
    try {
      health = await options.healthCheck({ proposal, manifest, releaseDir });
    } catch {
      return blocked('health_check_failed', 'The installed release health check could not be completed.');
    }
    if (!health.ok) {
      return blocked('health_check_failed', health.reason || 'The installed release health check failed.');
    }

    let preparedProcess: PreparedReleaseProcess | undefined;
    try {
      preparedProcess = await options.supervisor.prepare({ manifest, releaseDir });
      await options.supervisor.commit(preparedProcess);
      preparedProcess = undefined;
    } catch (error) {
      let abortFailure: string | undefined;
      if (preparedProcess) {
        try {
          await options.supervisor.abort(preparedProcess);
        } catch (abortError) {
          abortFailure = abortError instanceof Error ? abortError.message : 'unknown abort error';
        }
      }
      const cleared = await clearSupervisor();
      const failureReason = error instanceof Error ? error.message : 'unknown supervised process error';
      const reason = abortFailure
        ? `${failureReason}; candidate abort also failed: ${abortFailure}`
        : failureReason;
      return blocked(
        'process_restore_failed',
        cleared
          ? `The installed release process could not be restored: ${reason}`
          : `The installed release process failed and process cleanup could not be confirmed: ${reason}`,
      );
    }

    return {
      status: 'activated',
      reasonCode: 'activated',
      reason: 'Persisted signed release revalidated and its supervised core process was restored.',
      manifest,
    };
  };

  return {
    activate: (proposal: ReleaseProposal, artifactId: string): Promise<StagedReleaseActivationResult> => (
      enqueue(() => activateOnce(proposal, artifactId))
    ),
    restoreActive: (proposal: ReleaseProposal): Promise<StagedReleaseActivationResult> => (
      enqueue(() => restoreOnce(proposal))
    ),
    getActiveManifest: (): Promise<ActiveReleaseManifest | undefined> => enqueue(async () => {
      const active = await readActive(activeManifestPath);
      if (active.invalid) throw new Error('The persisted active release manifest is invalid.');
      return active.manifest;
    }),
    getProcessStatus: () => options.supervisor.getStatus(),
    shutdown: (): Promise<void> => enqueue(() => options.supervisor.shutdown()),
  };
};
