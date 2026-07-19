import crypto from 'node:crypto';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
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
const STOP_POLL_INTERVAL_MS = 10;
const READY_POLL_INTERVAL_MS = 10;
const MAX_READY_BYTES = 4 * 1024;
const NATIVE_RUNNER_FLAG = '--provenance-native-release-runner-v1';

const INHERITED_RUNTIME_ENV = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
] as const;

// Release children may inherit only the non-secret policy markers needed to
// preserve the native host's fail-closed command boundary. In particular, no
// bridge credential, ownership nonce, provider key, or session secret crosses.
const INHERITED_RELEASE_POLICY_ENV = [
  'DESKTOP_PACKAGED_RELEASE',
  'PROVENANCE_SANDBOX_IMAGE',
] as const;

export interface NodeReleaseSupervisorOptions {
  readyTimeoutMs?: number;
  stabilityWindowMs?: number;
  stopTimeoutMs?: number;
  environment?: Readonly<Record<string, string>>;
  nativeRunnerPath?: string;
  nativeRunnerArguments?: readonly string[];
  readinessDirectory?: string;
  /** Observability only; it cannot replace or alter process-tree termination. */
  onTerminationStart?: (pid: number) => void;
}

interface ManagedReleaseProcess {
  child: ChildProcess;
  candidatePid: number;
  candidate: ReleaseProcessCandidate;
  ticket: PreparedReleaseProcess;
}

interface TrackedReleaseProcess {
  candidate: ReleaseProcessCandidate;
  candidatePid?: number;
}

interface ReleaseReadyMessage {
  type: 'release.ready';
  nonce: string;
  targetVersion: string;
  contentHash: string;
}

interface ReleaseReadyRecord extends ReleaseReadyMessage {
  schemaVersion: 1;
  pid: number;
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

const isReadyRecord = (value: unknown): value is ReleaseReadyRecord => {
  if (!isReadyMessage(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join(',') === 'contentHash,nonce,pid,schemaVersion,targetVersion,type' &&
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0;
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

const hasLivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const delay = (durationMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

const taskkillExecutable = (): string => {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows SystemRoot is unavailable; process-tree termination cannot be trusted.');
  }
  return path.win32.join(path.win32.resolve(systemRoot), 'System32', 'taskkill.exe');
};

const stopWindowsProcessTree = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined || !hasLiveProcess(child)) return;
  const deadline = Date.now() + timeoutMs;
  const executable = taskkillExecutable();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killer: ChildProcess | undefined;
    let launchError: Error | undefined;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killer?.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    try {
      killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      finish(new Error(`Could not start trusted taskkill for release process ${pid}: ${errorMessage(error)}`));
      return;
    }
    killer.once('error', (error) => {
      launchError = new Error(`Trusted taskkill failed for release process ${pid}: ${error.message}`);
    });
    killer.once('close', (code, signal) => {
      if (launchError) {
        finish(launchError);
        return;
      }
      if (timedOut) {
        finish(new Error(`Trusted taskkill timed out terminating release process tree ${pid}.`));
        return;
      }
      if (code === 0 || !hasLiveProcess(child)) {
        finish();
        return;
      }
      finish(new Error(
        `Trusted taskkill could not confirm termination of release process tree ${pid} ` +
        `(code ${String(code)}, signal ${String(signal)}).`,
      ));
    });
    timer = setTimeout(() => {
      timedOut = true;
      // Wait for close after TerminateProcess so the helper is reaped before
      // this cleanup promise settles or another cleanup attempt may begin.
      killer?.kill('SIGKILL');
    }, timeoutMs);
  });

  while (hasLiveProcess(child) && Date.now() < deadline) {
    await delay(Math.min(STOP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  if (hasLiveProcess(child)) {
    throw new Error(`Release process ${pid} remained live after taskkill completed.`);
  }
};

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const waitForProcessGroupExit = async (pid: number, deadline: number): Promise<boolean> => {
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(STOP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
};

const stopPosixProcessTree = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  const graceDeadline = Math.min(deadline, Date.now() + Math.max(5, Math.min(250, Math.floor(timeoutMs / 2))));
  if (!signalProcessGroup(pid, 'SIGTERM')) return;
  if (await waitForProcessGroupExit(pid, graceDeadline)) return;
  if (!signalProcessGroup(pid, 'SIGKILL')) return;
  if (!await waitForProcessGroupExit(pid, deadline)) {
    throw new Error(`Release process group ${pid} remained live after SIGKILL.`);
  }
};

const stopProcessTree = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  try {
    if (process.platform === 'win32') await stopWindowsProcessTree(child, timeoutMs);
    else await stopPosixProcessTree(child, timeoutMs);
  } catch (error) {
    throw new Error(
      `Release process-tree termination could not be confirmed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

const waitForReady = async (
  child: ChildProcess,
  expected: Omit<ReleaseReadyMessage, 'type'>,
  timeoutMs: number,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (!isReadyMessage(message)) return;
      if (
        message.nonce === expected.nonce &&
        message.targetVersion === expected.targetVersion &&
        message.contentHash === expected.contentHash
      ) {
        finish();
        return;
      }
      finish(new Error('Release child readiness proof did not match the signed release metadata.'));
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Release child exited before readiness (code ${String(code)}, signal ${String(signal)}).`));
    };
    const onDisconnect = () => finish(new Error('Release child disconnected before readiness.'));
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
    timer = setTimeout(() => finish(new Error('Release child readiness timed out.')), timeoutMs);
  });
};

const freshReadyPath = async (directory: string, nonce: string): Promise<string> => {
  const readyPath = path.join(directory, `.release-ready-${nonce}.json`);
  if (path.dirname(readyPath) !== directory) {
    throw new Error('Release readiness path escaped its trusted runtime directory.');
  }
  try {
    await lstat(readyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readyPath;
    throw error;
  }
  throw new Error('Release readiness path was not fresh.');
};

const readReadyRecord = async (
  readyPath: string,
  expected: Omit<ReleaseReadyMessage, 'type'>,
): Promise<ReleaseReadyRecord> => {
  const metadata = await lstat(readyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_READY_BYTES) {
    throw new Error('Release child readiness proof was not a bounded regular file.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(readyPath, 'utf8'));
  } catch {
    throw new Error('Release child readiness proof was not valid JSON.');
  }
  if (!isReadyRecord(parsed) ||
      parsed.nonce !== expected.nonce ||
      parsed.targetVersion !== expected.targetVersion ||
      parsed.contentHash !== expected.contentHash) {
    throw new Error('Release child readiness proof did not match the signed release metadata.');
  }
  if (!hasLivePid(parsed.pid)) {
    throw new Error('Release child readiness proof named a process that was not live.');
  }
  return parsed;
};

const waitForReadyFile = async (
  helper: ChildProcess,
  readyPath: string,
  expected: Omit<ReleaseReadyMessage, 'type'>,
  timeoutMs: number,
): Promise<ReleaseReadyRecord> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hasLiveProcess(helper)) {
      throw new Error(
        `Native release runner exited before readiness (code ${String(helper.exitCode)}, ` +
        `signal ${String(helper.signalCode)}).`,
      );
    }
    try {
      return await readReadyRecord(readyPath, expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(Math.min(READY_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Release child readiness timed out.');
};

const waitForStability = async (
  child: ChildProcess,
  stabilityWindowMs: number,
  candidatePid: number,
  requireIpc: boolean,
): Promise<void> => {
  if (!hasLiveProcess(child)) throw new Error('Release child exited before the stability window.');
  if (!hasLivePid(candidatePid)) throw new Error('Release child exited before the stability window.');
  if (requireIpc && !child.connected) throw new Error('Release child disconnected before the stability window.');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let finalCheck: NodeJS.Immediate | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finalCheck) clearImmediate(finalCheck);
      child.off('exit', onExit);
      child.off('error', onError);
      child.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => {
      finish(new Error('Release child exited during the stability window.'));
    };
    const onError = (error: Error) => finish(error);
    const onDisconnect = () => finish(new Error('Release child disconnected during the stability window.'));
    const timer = setTimeout(() => {
      // Give a queued process-handle callback one turn before accepting the
      // child, then confirm liveness with the operating system as well.
      finalCheck = setImmediate(() => {
        finalCheck = undefined;
        if (!hasLiveProcess(child) || !hasLivePid(candidatePid)) {
          finish(new Error('Release child exited during the stability window.'));
          return;
        }
        finish();
      });
    }, stabilityWindowMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (requireIpc) child.once('disconnect', onDisconnect);
  });
};

const boundedDuration = (value: number | undefined, fallback: number, maximum: number): number => (
  Number.isSafeInteger(value) && value! >= 10 ? Math.min(value!, maximum) : fallback
);

interface WindowsLaunchAuthority {
  runner: string;
  runnerArguments: string[];
  nodeExecutable: string;
  readinessDirectory: string;
}

const resolveWindowsLaunchAuthority = async (
  options: NodeReleaseSupervisorOptions,
): Promise<WindowsLaunchAuthority> => {
  const requestedRunner = options.nativeRunnerPath ?? process.env.PROVENANCE_NATIVE_RELEASE_RUNNER;
  const requestedReadinessDirectory = options.readinessDirectory ?? process.env.PROVENANCE_RUNTIME_DIR;
  if (!requestedRunner || !path.win32.isAbsolute(requestedRunner)) {
    throw new Error('Windows release activation requires the trusted native release runner.');
  }
  if (!requestedReadinessDirectory || !path.win32.isAbsolute(requestedReadinessDirectory)) {
    throw new Error('Windows release activation requires the trusted native runtime directory.');
  }
  const runner = await realpath(requestedRunner);
  const runnerMetadata = await stat(runner);
  if (!runnerMetadata.isFile() || path.extname(runner).toLowerCase() !== '.exe') {
    throw new Error('Windows native release runner is not a canonical executable file.');
  }
  const nodeExecutable = await realpath(process.execPath);
  const nodeMetadata = await stat(nodeExecutable);
  if (!nodeMetadata.isFile() || path.extname(nodeExecutable).toLowerCase() !== '.exe') {
    throw new Error('Windows release activation requires the canonical Node executable.');
  }
  const readinessDirectory = await realpath(requestedReadinessDirectory);
  if (!(await stat(readinessDirectory)).isDirectory()) {
    throw new Error('Windows release readiness directory is not canonical.');
  }
  const runnerArguments = [...(options.nativeRunnerArguments ?? [])];
  if (runnerArguments.some((argument) => !argument || argument.length > 32_768 || argument.includes('\0'))) {
    throw new Error('Windows native release runner arguments are invalid.');
  }
  return { runner, runnerArguments, nodeExecutable, readinessDirectory };
};

/**
 * Supervises one signed Node core child. The package chooses no command,
 * arguments, or shell: only its verified relative `.cjs` entrypoint is used.
 * The child receives a minimal environment and must prove readiness with a
 * per-launch nonce and signed release metadata. POSIX uses inherited IPC;
 * Windows uses the native suspended-process Job runner and an atomic file.
 */
export const createNodeReleaseSupervisor = (
  options: NodeReleaseSupervisorOptions = {},
): ReleaseProcessSupervisor => {
  const readyTimeoutMs = boundedDuration(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 60_000);
  const stabilityWindowMs = boundedDuration(options.stabilityWindowMs, DEFAULT_STABILITY_WINDOW_MS, 30_000);
  const stopTimeoutMs = boundedDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 30_000);
  const pending = new Map<string, ManagedReleaseProcess>();
  const tracked = new Map<ChildProcess, TrackedReleaseProcess>();
  const stopping = new Map<ChildProcess, Promise<void>>();
  const liveTickets = new WeakSet<object>();
  let active: ManagedReleaseProcess | undefined;

  const stopTracked = (child: ChildProcess): Promise<void> => {
    const inFlight = stopping.get(child);
    if (inFlight) return inFlight;
    const operation = (async () => {
      if (hasLiveProcess(child)) {
        try {
          options.onTerminationStart?.(child.pid!);
        } catch {
          // An observer cannot influence the mandatory cleanup path.
        }
        await stopProcessTree(child, stopTimeoutMs);
      }
      tracked.delete(child);
    })();
    stopping.set(child, operation);
    void operation.finally(() => {
      if (stopping.get(child) === operation) stopping.delete(child);
    }).catch(() => undefined);
    return operation;
  };

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
        ...options.environment,
        NODE_ENV: 'production',
        PORT: '0',
        RELEASE_CHILD_MODE: '1',
        RELEASE_SUPERVISOR_NONCE: nonce,
        RELEASE_ID: candidate.manifest.releaseId,
        RELEASE_TARGET_VERSION: candidate.manifest.targetVersion,
        RELEASE_CONTENT_HASH: candidate.manifest.contentHash,
      };
      delete environment.PROVENANCE_NATIVE_RELEASE_RUNNER;
      delete environment.RELEASE_SUPERVISOR_READY_FILE;
      for (const key of INHERITED_RUNTIME_ENV) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      }
      for (const key of INHERITED_RELEASE_POLICY_ENV) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      }

      const windowsAuthority = process.platform === 'win32'
        ? await resolveWindowsLaunchAuthority(options)
        : undefined;
      const readyPath = windowsAuthority
        ? await freshReadyPath(windowsAuthority.readinessDirectory, nonce)
        : undefined;
      if (readyPath) environment.RELEASE_SUPERVISOR_READY_FILE = readyPath;

      const child = windowsAuthority
        ? spawn(windowsAuthority.runner, [
            ...windowsAuthority.runnerArguments,
            NATIVE_RUNNER_FLAG,
            windowsAuthority.nodeExecutable,
            entrypoint,
            releaseRoot,
          ], {
            cwd: releaseRoot,
            env: environment,
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          })
        : fork(entrypoint, [], {
            cwd: releaseRoot,
            env: environment,
            execArgv: [],
            serialization: 'json',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            detached: true,
          });
      const trackedProcess: TrackedReleaseProcess = { candidate };
      tracked.set(child, trackedProcess);
      let candidatePid: number | undefined;
      try {
        const expected = {
          nonce,
          targetVersion: candidate.manifest.targetVersion,
          contentHash: candidate.manifest.contentHash,
        };
        if (readyPath) {
          const ready = await waitForReadyFile(child, readyPath, expected, readyTimeoutMs);
          candidatePid = ready.pid;
        } else {
          await waitForReady(child, expected, readyTimeoutMs);
          candidatePid = child.pid;
        }
        if (candidatePid === undefined) throw new Error('Release child did not expose a process identifier.');
        trackedProcess.candidatePid = candidatePid;
        await waitForStability(child, stabilityWindowMs, candidatePid, !windowsAuthority);
      } catch (error) {
        try {
          await stopTracked(child);
        } catch (terminationError) {
          throw new AggregateError(
            [error, terminationError],
            `Release candidate failed (${errorMessage(error)}) and its process tree could not be terminated ` +
            `(${errorMessage(terminationError)}).`,
          );
        }
        throw error;
      } finally {
        if (readyPath) await rm(readyPath, { force: true }).catch(() => undefined);
      }
      if (candidatePid === undefined) throw new Error('Release child readiness did not expose a process identifier.');

      const ticket = Object.freeze({
        id: `release_process_${crypto.randomUUID()}`,
        releaseId: candidate.manifest.releaseId,
      });
      const managed = { child, candidatePid, candidate, ticket };
      pending.set(ticket.id, managed);
      liveTickets.add(ticket);
      return ticket;
    },

    commit: async (prepared) => {
      const managed = resolveManaged(prepared);
      if (!isRunning(managed.child) || !hasLivePid(managed.candidatePid)) {
        throw new Error('Release child exited before manifest commit.');
      }
      const previous = active;
      if (previous && previous !== managed) await stopTracked(previous.child);
      pending.delete(prepared.id);
      liveTickets.delete(prepared as object);
      active = managed;
    },

    abort: async (prepared) => {
      const managed = resolveManaged(prepared);
      await stopTracked(managed.child);
      pending.delete(prepared.id);
      liveTickets.delete(prepared as object);
    },

    getStatus: (): ReleaseProcessStatus => {
      const pendingReleaseIds = new Set(
        [...pending.values()].map((managed) => managed.candidate.manifest.releaseId),
      );
      for (const [child, trackedProcess] of tracked) {
        if (child !== active?.child) pendingReleaseIds.add(trackedProcess.candidate.manifest.releaseId);
      }
      return {
        activeReleaseId: active?.candidate.manifest.releaseId,
        activePid: active?.candidatePid,
        pendingReleaseIds: [...pendingReleaseIds],
      };
    },

    shutdown: async () => {
      const children = [...tracked.keys()];
      const results = await Promise.allSettled(children.map((child) => stopTracked(child)));
      for (const [id, managed] of pending) {
        if (!tracked.has(managed.child)) {
          pending.delete(id);
          liveTickets.delete(managed.ticket as object);
        }
      }
      if (active && !tracked.has(active.child)) active = undefined;
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more release process trees could not be terminated.');
      }
    },
  };
};
