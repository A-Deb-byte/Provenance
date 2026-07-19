import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeReleaseAuthorizationPayload } from '../autonomy';
import type { ReleaseProposal } from '../types';
import { createReleaseLifecycle } from './lifecycle';
import type {
  ActiveReleaseManifest,
  PreparedReleaseProcess,
  ReleaseProcessSupervisor,
  StagedReleasePackage,
} from './types';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'release-lifecycle-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

const packageArtifact = (files: Array<{ path: string; content: string }> = [{
  path: 'core/index.cjs', content: 'setInterval(() => undefined, 1000);\n',
}]) => {
  const releasePackage: StagedReleasePackage = {
    schemaVersion: 1,
    targetVersion: '1.2.3',
    entrypoint: 'core/index.cjs',
    files: files.map((file) => {
      const content = Buffer.from(file.content, 'utf8');
      return { path: file.path, contentBase64: content.toString('base64'), contentHash: sha256(content) };
    }),
  };
  const content = JSON.stringify(releasePackage);
  return { content, contentHash: sha256(content) };
};

const processSupervisor = (): ReleaseProcessSupervisor => ({
  prepare: vi.fn(async ({ manifest }) => Object.freeze({
    id: `process_${manifest.releaseId}`,
    releaseId: manifest.releaseId,
  }) satisfies PreparedReleaseProcess),
  commit: vi.fn(async () => undefined),
  abort: vi.fn(async () => undefined),
  getStatus: () => ({ pendingReleaseIds: [] }),
  shutdown: vi.fn(async () => undefined),
});

const trackingProcessSupervisor = (failPrepare = false): ReleaseProcessSupervisor => {
  const pending = new Map<string, PreparedReleaseProcess>();
  let active: PreparedReleaseProcess | undefined;
  return {
    prepare: vi.fn(async ({ manifest }) => {
      const prepared = Object.freeze({
        id: `process_${manifest.releaseId}`,
        releaseId: manifest.releaseId,
      }) satisfies PreparedReleaseProcess;
      pending.set(prepared.id, prepared);
      if (failPrepare) throw new Error('Candidate did not become ready.');
      return prepared;
    }),
    commit: vi.fn(async (prepared) => {
      if (pending.get(prepared.id) !== prepared) throw new Error('Unknown process ticket.');
      pending.delete(prepared.id);
      active = prepared;
    }),
    abort: vi.fn(async (prepared) => {
      pending.delete(prepared.id);
    }),
    getStatus: () => ({
      activeReleaseId: active?.releaseId,
      pendingReleaseIds: [...pending.values()].map((prepared) => prepared.releaseId),
    }),
    shutdown: vi.fn(async () => {
      pending.clear();
      active = undefined;
    }),
  };
};

const signedProposal = (artifact: ReturnType<typeof packageArtifact>) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const unsignedProposal: ReleaseProposal = {
    id: 'release_1',
    title: 'Controlled release',
    targetVersion: '1.2.3',
    contentHash: artifact.contentHash,
    evaluationEventIds: ['event_eval_1'],
    rollbackInstructions: 'Restore the previous active manifest.',
    activationState: 'proposed',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
  const signature = crypto.sign(
    null,
    Buffer.from(serializeReleaseAuthorizationPayload(unsignedProposal), 'utf8'),
    privateKey,
  ).toString('base64');
  const proposal: ReleaseProposal = { ...unsignedProposal, signature };
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { proposal, publicKeyBase64 };
};

describe('staged release lifecycle', () => {
  it('binds signature, evaluations, artifact hash, controlled install, health, and active manifest', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'controlled-releases');
    const sourceSentinel = path.join(dir, 'source-file.ts');
    await writeFile(sourceSentinel, 'must remain unchanged', 'utf8');
    const healthCheck = vi.fn(async ({ releaseDir }: { releaseDir: string }) => ({
      ok: (await readFile(path.join(releaseDir, 'core', 'index.cjs'), 'utf8')).includes('setInterval'),
      reason: 'Installed file was not healthy.',
    }));
    const supervisor = processSupervisor();
    const lifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async (id) => id === 'artifact_release_1' ? artifact : undefined,
      verifyEvaluationReference: async (eventId) => eventId === 'event_eval_1',
      healthCheck,
      supervisor,
      now: () => '2026-07-13T00:05:00.000Z',
    });

    const result = await lifecycle.activate(signed.proposal, 'artifact_release_1');

    expect(result.status).toBe('activated');
    expect(result.manifest).toMatchObject({
      releaseId: 'release_1', artifactId: 'artifact_release_1', contentHash: artifact.contentHash,
    });
    expect(healthCheck).toHaveBeenCalledOnce();
    expect(supervisor.prepare).toHaveBeenCalledOnce();
    expect(supervisor.commit).toHaveBeenCalledOnce();
    expect(await lifecycle.getActiveManifest()).toEqual(result.manifest);
    expect(await readFile(sourceSentinel, 'utf8')).toBe('must remain unchanged');
    const relativeInstall = path.relative(releasesDir, healthCheck.mock.calls[0][0].releaseDir);
    expect(relativeInstall.startsWith('..')).toBe(false);
  });

  it('blocks forged or altered authorizations, unverified evaluations, and artifact hash mismatches before installation', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    const base = {
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
    };

    expect((await createReleaseLifecycle(base).activate({ ...signed.proposal, signature: Buffer.from('forged').toString('base64') }, 'artifact')).reasonCode)
      .toBe('signature_invalid');
    const alteredAuthorizations: ReleaseProposal[] = [
      { ...signed.proposal, targetVersion: '1.2.4' },
      { ...signed.proposal, contentHash: 'b'.repeat(64) },
      { ...signed.proposal, evaluationEventIds: ['event_eval_2'] },
      { ...signed.proposal, rollbackInstructions: 'Leave the failed release active.' },
      { ...signed.proposal, evaluationEventIds: ['event_eval_1', 'event_eval_1'] },
    ];
    for (const altered of alteredAuthorizations) {
      expect((await createReleaseLifecycle(base).activate(altered, 'artifact')).reasonCode)
        .toBe('signature_invalid');
    }
    expect((await createReleaseLifecycle({ ...base, verifyEvaluationReference: async () => false }).activate(signed.proposal, 'artifact')).reasonCode)
      .toBe('evaluation_unverified');
    expect((await createReleaseLifecycle({
      ...base,
      resolveArtifact: async () => ({ content: artifact.content, contentHash: 'a'.repeat(64) }),
    }).activate(signed.proposal, 'artifact')).reasonCode).toBe('artifact_hash_mismatch');
    await expect(readdir(releasesDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal in a signed package and never overwrites source files', async () => {
    const sentinel = path.join(dir, 'source.txt');
    await writeFile(sentinel, 'source', 'utf8');
    const artifact = packageArtifact([{ path: '../source.txt', content: 'overwrite' }]);
    const signed = signedProposal(artifact);
    const result = await createReleaseLifecycle({
      releasesDir: path.join(dir, 'releases'),
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
    }).activate(signed.proposal, 'artifact');

    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'package_invalid' });
    expect(await readFile(sentinel, 'utf8')).toBe('source');
  });

  it('atomically restores the previous active manifest and removes the candidate when health fails', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    await mkdir(releasesDir, { recursive: true });
    const previous: ActiveReleaseManifest = {
      schemaVersion: 1,
      releaseId: 'release_previous',
      artifactId: 'artifact_previous',
      targetVersion: '1.2.2',
      contentHash: 'b'.repeat(64),
      releaseDirectory: '1.2.2-bbbbbbbbbbbb',
      entrypoint: 'core/index.cjs',
      activatedAt: '2026-07-12T00:00:00.000Z',
    };
    await writeFile(path.join(releasesDir, 'active-release.json'), JSON.stringify(previous, null, 2), 'utf8');
    const lifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: false, reason: 'Candidate failed its smoke test.' }),
      supervisor: processSupervisor(),
    });

    const result = await lifecycle.activate(signed.proposal, 'artifact_release_1');

    expect(result).toMatchObject({ status: 'rolled_back', reasonCode: 'health_check_failed' });
    expect(await lifecycle.getActiveManifest()).toEqual(previous);
    const installedEntries = await readdir(path.join(releasesDir, 'installed'));
    expect(installedEntries).toEqual([]);
  });

  it('reports rollback failure when candidate abort and supervisor-wide cleanup cannot confirm termination', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const prepared = Object.freeze({
      id: 'process_release_1',
      releaseId: 'release_1',
    }) satisfies PreparedReleaseProcess;
    const supervisor: ReleaseProcessSupervisor = {
      prepare: vi.fn(async () => prepared),
      commit: vi.fn(async () => {
        throw new Error('Previous process tree could not be terminated.');
      }),
      abort: vi.fn(async () => {
        throw new Error('Candidate process tree could not be terminated.');
      }),
      getStatus: () => ({ pendingReleaseIds: ['release_1'] }),
      shutdown: vi.fn(async () => {
        throw new Error('Process-tree cleanup remains uncertain.');
      }),
    };
    const lifecycle = createReleaseLifecycle({
      releasesDir: path.join(dir, 'releases'),
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor,
    });

    const result = await lifecycle.activate(signed.proposal, 'artifact_release_1');

    expect(result).toMatchObject({ status: 'rollback_failed', reasonCode: 'rollback_failed' });
    expect(result.reason).toMatch(/candidate abort failed/i);
    expect(result.reason).toMatch(/could not be confirmed/i);
    expect(supervisor.abort).toHaveBeenCalledWith(prepared);
    expect(supervisor.shutdown).toHaveBeenCalledTimes(2);
  });

  it('reauthenticates installed bytes and restores the active process without rewriting the manifest', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    const installLifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
      now: () => '2026-07-13T00:05:00.000Z',
    });
    expect((await installLifecycle.activate(signed.proposal, 'artifact_release_1')).status).toBe('activated');
    await installLifecycle.shutdown();
    const activeManifestPath = path.join(releasesDir, 'active-release.json');
    const manifestBeforeRestore = await readFile(activeManifestPath, 'utf8');
    const supervisor = trackingProcessSupervisor();
    const resolveArtifact = vi.fn(async (artifactId: string) => (
      artifactId === 'artifact_release_1' ? artifact : undefined
    ));
    const verifyEvaluationReference = vi.fn(async (eventId: string) => eventId === 'event_eval_1');
    const healthCheck = vi.fn(async () => ({ ok: true, reason: 'healthy' }));
    const restoreLifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact,
      verifyEvaluationReference,
      healthCheck,
      supervisor,
    });

    const result = await restoreLifecycle.restoreActive({
      ...signed.proposal,
      activationState: 'activated',
    });

    expect(result).toMatchObject({
      status: 'activated', reasonCode: 'activated', manifest: { releaseId: 'release_1' },
    });
    expect(resolveArtifact).toHaveBeenCalledWith('artifact_release_1');
    expect(verifyEvaluationReference).toHaveBeenCalledWith('event_eval_1');
    expect(healthCheck).toHaveBeenCalledOnce();
    expect(supervisor.prepare).toHaveBeenCalledOnce();
    expect(supervisor.commit).toHaveBeenCalledOnce();
    expect(restoreLifecycle.getProcessStatus()).toMatchObject({
      activeReleaseId: 'release_1', pendingReleaseIds: [],
    });
    expect(await readFile(activeManifestPath, 'utf8')).toBe(manifestBeforeRestore);
  });

  it('blocks restore when an installed signed file was changed and leaves no process alive', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    const installer = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
    });
    const activation = await installer.activate(signed.proposal, 'artifact_release_1');
    expect(activation.status).toBe('activated');
    await installer.shutdown();
    await writeFile(
      path.join(releasesDir, 'installed', activation.manifest!.releaseDirectory, 'core', 'index.cjs'),
      'module.exports = "tampered";\n',
      'utf8',
    );
    const supervisor = trackingProcessSupervisor();
    const lifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor,
    });

    const result = await lifecycle.restoreActive({ ...signed.proposal, activationState: 'activated' });

    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'installed_release_invalid' });
    expect(supervisor.prepare).not.toHaveBeenCalled();
    expect(lifecycle.getProcessStatus()).toEqual({ activeReleaseId: undefined, pendingReleaseIds: [] });
  });

  it('blocks a manifest that disagrees with the activated kernel proposal before process dispatch', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    const installer = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
    });
    const activation = await installer.activate(signed.proposal, 'artifact_release_1');
    expect(activation.manifest).toBeDefined();
    await installer.shutdown();
    await writeFile(path.join(releasesDir, 'active-release.json'), JSON.stringify({
      ...activation.manifest,
      targetVersion: '1.2.4',
    }, null, 2), 'utf8');
    const supervisor = trackingProcessSupervisor();
    const lifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor,
    });

    const result = await lifecycle.restoreActive({ ...signed.proposal, activationState: 'activated' });

    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'active_manifest_mismatch' });
    expect(supervisor.prepare).not.toHaveBeenCalled();
    expect(lifecycle.getProcessStatus()).toEqual({ activeReleaseId: undefined, pendingReleaseIds: [] });
  });

  it('drains a pending candidate when process readiness throws during restore', async () => {
    const artifact = packageArtifact();
    const signed = signedProposal(artifact);
    const releasesDir = path.join(dir, 'releases');
    const installer = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor: processSupervisor(),
    });
    expect((await installer.activate(signed.proposal, 'artifact_release_1')).status).toBe('activated');
    await installer.shutdown();
    const supervisor = trackingProcessSupervisor(true);
    const lifecycle = createReleaseLifecycle({
      releasesDir,
      publicKey: signed.publicKeyBase64,
      resolveArtifact: async () => artifact,
      verifyEvaluationReference: async () => true,
      healthCheck: async () => ({ ok: true, reason: 'ok' }),
      supervisor,
    });

    const result = await lifecycle.restoreActive({ ...signed.proposal, activationState: 'activated' });

    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'process_restore_failed' });
    expect(lifecycle.getProcessStatus()).toEqual({ activeReleaseId: undefined, pendingReleaseIds: [] });
    expect(supervisor.shutdown).toHaveBeenCalledTimes(2);
  });
});
