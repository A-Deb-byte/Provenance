import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  PreparedReleaseProcess,
  ReleaseProcessCandidate,
  ReleaseProcessStatus,
  ReleaseProcessSupervisor,
} from './types';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_STABILITY_WINDOW_MS = 750;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;

const INHERITED_RUNTIME_ENV = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
] as const;

export interface NodeReleaseSupervisorOptions {
  readyTimeoutMs?: number;
  stabilityWindowMs?: number;
  stopTimeoutMs?: number;
  environment?: Readonly<Record<string, string>>;
}

interface ManagedReleaseProcess {
  child: ChildProcess;
  candidate: ReleaseProcessCandidate;
  ticket: PreparedReleaseProcess;
}

interface ReleaseReadyMessage {
  type: 'release.ready';
  nonce: string;
  targetVersion: string;
  contentHash: string;
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isReadyMessage = (value: unknown): value is ReleaseReadyMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'release.ready' &&
    typeof message.nonce === 'string' &&
    typeof message.targetVersion === 'string' &&
    typeof message.contentHash === 'string';
};

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

const hasLiveProcess = (child: ChildProcess): boolean => {
  if (!isRunning(child) || child.pid === undefined) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopChild = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  if (!isRunning(child)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      child.off('exit', finish);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (isRunning(child)) child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    child.kill('SIGTERM');
    if (!isRunning(child)) finish();
  });
};

const waitForReady = async (
  child: ChildProcess,
  expected: Omit<ReleaseReadyMessage, 'type'>,
  timeoutMs: number,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (!isReadyMessage(message)) return;
      if (
        message.nonce === expected.nonce &&
        message.targetVersion === expected.targetVersion &&
        message.contentHash === expected.contentHash
      ) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Release child exited before readiness (code ${String(code)}, signal ${String(signal)}).`));
    };
    const timer = setTimeout(() => finish(new Error('Release child readiness timed out.')), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
};

const waitForStability = async (child: ChildProcess, stabilityWindowMs: number): Promise<void> => {
  if (!hasLiveProcess(child)) throw new Error('Release child exited before the stability window.');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let finalCheck: NodeJS.Immediate | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finalCheck) clearImmediate(finalCheck);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => {
      finish(new Error('Release child exited during the stability window.'));
    };
    const timer = setTimeout(() => {
      // Give a queued process-handle callback one turn before accepting the
      // child, then confirm liveness with the operating system as well.
      finalCheck = setImmediate(() => {
        finalCheck = undefined;
        if (!hasLiveProcess(child)) {
          finish(new Error('Release child exited during the stability window.'));
          return;
        }
        finish();
      });
    }, stabilityWindowMs);
    child.once('exit', onExit);
  });
};

const boundedDuration = (value: number | undefined, fallback: number, maximum: number): number => (
  Number.isSafeInteger(value) && value! >= 10 ? Math.min(value!, maximum) : fallback
);

/**
 * Supervises one signed Node core child. The package chooses no command,
 * arguments, or shell: only its verified relative `.cjs` entrypoint is used.
 * The child receives a minimal environment and must prove readiness over the
 * inherited IPC channel with a per-launch nonce and signed release metadata.
 */
export const createNodeReleaseSupervisor = (
  options: NodeReleaseSupervisorOptions = {},
): ReleaseProcessSupervisor => {
  const readyTimeoutMs = boundedDuration(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 60_000);
  const stabilityWindowMs = boundedDuration(options.stabilityWindowMs, DEFAULT_STABILITY_WINDOW_MS, 30_000);
  const stopTimeoutMs = boundedDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 30_000);
  const pending = new Map<string, ManagedReleaseProcess>();
  const liveTickets = new WeakSet<object>();
  let active: ManagedReleaseProcess | undefined;

  const resolveManaged = (prepared: PreparedReleaseProcess): ManagedReleaseProcess => {
    if (!prepared || typeof prepared !== 'object' || !liveTickets.has(prepared as object)) {
      throw new Error('Release process ticket is invalid or no longer active.');
    }
    const managed = pending.get(prepared.id);
    if (!managed || managed.ticket !== prepared || managed.candidate.manifest.releaseId !== prepared.releaseId) {
      throw new Error('Release process ticket does not match a pending candidate.');
    }
    return managed;
  };

  return {
    prepare: async (candidate) => {
      const releaseRoot = await realpath(candidate.releaseDir);
      if (!candidate.manifest.entrypoint.toLowerCase().endsWith('.cjs')) {
        throw new Error('Signed release entrypoint must be a CommonJS Node module.');
      }
      const requestedEntrypoint = path.resolve(releaseRoot, ...candidate.manifest.entrypoint.split('/'));
      if (!isWithinRoot(releaseRoot, requestedEntrypoint)) {
        throw new Error('Signed release entrypoint escaped the installed release directory.');
      }
      const entrypoint = await realpath(requestedEntrypoint);
      if (!isWithinRoot(releaseRoot, entrypoint) || !(await stat(entrypoint)).isFile()) {
        throw new Error('Signed release entrypoint is not a regular file inside the installed release directory.');
      }

      const nonce = crypto.randomBytes(32).toString('hex');
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        PORT: '0',
        RELEASE_CHILD_MODE: '1',
        RELEASE_SUPERVISOR_NONCE: nonce,
        RELEASE_ID: candidate.manifest.releaseId,
        RELEASE_TARGET_VERSION: candidate.manifest.targetVersion,
        RELEASE_CONTENT_HASH: candidate.manifest.contentHash,
        ...options.environment,
      };
      for (const key of INHERITED_RUNTIME_ENV) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      }

      const child = fork(entrypoint, [], {
        cwd: releaseRoot,
        env: environment,
        execArgv: [],
        serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      try {
        await waitForReady(child, {
          nonce,
          targetVersion: candidate.manifest.targetVersion,
          contentHash: candidate.manifest.contentHash,
        }, readyTimeoutMs);
        await waitForStability(child, stabilityWindowMs);
      } catch (error) {
        await stopChild(child, stopTimeoutMs);
        throw error;
      }

      const ticket = Object.freeze({
        id: `release_process_${crypto.randomUUID()}`,
        releaseId: candidate.manifest.releaseId,
      });
      const managed = { child, candidate, ticket };
      pending.set(ticket.id, managed);
      liveTickets.add(ticket);
      return ticket;
    },

    commit: async (prepared) => {
      const managed = resolveManaged(prepared);
      if (!isRunning(managed.child)) throw new Error('Release child exited before manifest commit.');
      const previous = active;
      pending.delete(prepared.id);
      liveTickets.delete(prepared as object);
      active = managed;
      if (previous && previous !== managed) await stopChild(previous.child, stopTimeoutMs);
    },

    abort: async (prepared) => {
      const managed = resolveManaged(prepared);
      pending.delete(prepared.id);
      liveTickets.delete(prepared as object);
      await stopChild(managed.child, stopTimeoutMs);
    },

    getStatus: (): ReleaseProcessStatus => ({
      activeReleaseId: active?.candidate.manifest.releaseId,
      activePid: active?.child.pid,
      pendingReleaseIds: [...pending.values()].map((managed) => managed.candidate.manifest.releaseId),
    }),

    shutdown: async () => {
      const children = [...pending.values()].map((managed) => managed.child);
      if (active) children.push(active.child);
      pending.clear();
      active = undefined;
      await Promise.all(children.map((child) => stopChild(child, stopTimeoutMs)));
    },
  };
};
