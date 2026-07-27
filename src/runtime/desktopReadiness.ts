import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const READY_FILE_NAME = /^\.desktop-ready-[a-zA-Z0-9-]{8,128}\.json$/;

export interface DesktopReadyPublisher {
  enabled: boolean;
  publish(input: DesktopReadyInput): Promise<void>;
  cleanup(): Promise<void>;
}

export interface DesktopReadyInput {
  port: number;
  hostInstanceId: string;
  kernelReady: boolean;
  accessMode: 'open' | 'operator_token' | 'multi_user';
  bridgeAuthenticated: boolean;
  schedulerEnabled: boolean;
  desktopStatus: 'available' | 'configured' | 'unavailable' | 'blocked';
}

interface DesktopReadyRecord {
  schemaVersion: 3;
  nonce: string;
  pid: number;
  port: number;
  hostInstanceId: string;
  kernelReady: boolean;
  accessMode: DesktopReadyInput['accessMode'];
  bridgeAuthenticated: boolean;
  schedulerEnabled: boolean;
  desktopStatus: DesktopReadyInput['desktopStatus'];
}

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
};

export const createDesktopReadyPublisher = (
  runtimeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  pid = process.pid,
): DesktopReadyPublisher => {
  const nonce = env.DESKTOP_HOST_NONCE?.trim() ?? '';
  const suppliedPath = env.DESKTOP_HOST_READY_FILE?.trim() ?? '';
  if (!nonce && !suppliedPath) {
    return { enabled: false, publish: async () => undefined, cleanup: async () => undefined };
  }
  if (!nonce || !suppliedPath || !env.DESKTOP_RUNTIME_OWNER_NONCE?.trim()) {
    throw new Error('Desktop host readiness requires a nonce, ready file, and runtime ownership proof.');
  }
  if (nonce.length < 32) throw new Error('Desktop host readiness nonce must contain at least 32 characters.');
  const absoluteRuntimeDir = path.resolve(runtimeDir);
  const readyPath = path.resolve(suppliedPath);
  if (path.dirname(readyPath) !== absoluteRuntimeDir || !READY_FILE_NAME.test(path.basename(readyPath))) {
    throw new Error('Desktop host readiness file must use the controlled runtime directory and filename format.');
  }
  let published = false;

  return {
    enabled: true,
    publish: async ({
      port,
      hostInstanceId,
      kernelReady,
      accessMode,
      bridgeAuthenticated,
      schedulerEnabled,
      desktopStatus,
    }) => {
      if (published) throw new Error('Desktop host readiness has already been published.');
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Desktop host readiness port is invalid.');
      }
      if (!['available', 'configured', 'unavailable', 'blocked'].includes(desktopStatus)) {
        throw new Error('Desktop host readiness status is invalid.');
      }
      if (!/^desktop-host-[a-f0-9]{32}$/u.test(hostInstanceId)) {
        throw new Error('Desktop host readiness instance id is invalid.');
      }
      if (!kernelReady || !bridgeAuthenticated) {
        throw new Error('Desktop host readiness requires a ready kernel and authenticated bridge state.');
      }
      if (!['open', 'operator_token', 'multi_user'].includes(accessMode)) {
        throw new Error('Desktop host readiness access mode is invalid.');
      }
      const record: DesktopReadyRecord = {
        schemaVersion: 3,
        nonce,
        pid,
        port,
        hostInstanceId,
        kernelReady,
        accessMode,
        bridgeAuthenticated,
        schedulerEnabled,
        desktopStatus,
      };
      const temporaryPath = `${readyPath}.${pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        await link(temporaryPath, readyPath);
        published = true;
      } finally {
        await unlinkIfPresent(temporaryPath);
      }
    },
    cleanup: async () => {
      if (!published) return;
      try {
        const parsed = JSON.parse(await readFile(readyPath, 'utf8')) as Partial<DesktopReadyRecord>;
        if (parsed.schemaVersion === 3 && parsed.nonce === nonce && parsed.pid === pid) {
          await unlinkIfPresent(readyPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
};
