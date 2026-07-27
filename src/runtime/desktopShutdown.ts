import crypto from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHUTDOWN_FILE_NAME = /^\.desktop-shutdown-[a-zA-Z0-9-]{8,128}\.json$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface DesktopShutdownControl {
  enabled: boolean;
  authenticate(candidate: string | undefined): boolean;
  publish(): Promise<void>;
}

const removeIfPresent = async (target: string): Promise<void> => {
  await unlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
};

export const createDesktopShutdownControl = (
  runtimeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  pid = process.pid,
): DesktopShutdownControl => {
  const token = env.DESKTOP_HOST_SHUTDOWN_TOKEN?.trim() ?? '';
  const nonce = env.DESKTOP_HOST_SHUTDOWN_NONCE?.trim() ?? '';
  const suppliedPath = env.DESKTOP_HOST_SHUTDOWN_FILE?.trim() ?? '';
  if (!token && !nonce && !suppliedPath) {
    return { enabled: false, authenticate: () => false, publish: async () => undefined };
  }
  if (!SECRET_PATTERN.test(token) || !SECRET_PATTERN.test(nonce) || !suppliedPath) {
    throw new Error('Desktop shutdown control requires exact per-launch token, nonce, and receipt path.');
  }
  const runtime = path.resolve(runtimeDir);
  const receiptPath = path.resolve(suppliedPath);
  if (path.dirname(receiptPath) !== runtime || !SHUTDOWN_FILE_NAME.test(path.basename(receiptPath))) {
    throw new Error('Desktop shutdown receipt must use the controlled runtime directory and filename format.');
  }
  let published = false;

  return {
    enabled: true,
    authenticate: (candidate) => {
      if (typeof candidate !== 'string' || candidate.length !== token.length) return false;
      return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
    },
    publish: async () => {
      if (published) throw new Error('Desktop shutdown receipt has already been published.');
      const temporaryPath = `${receiptPath}.${pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify({
        schemaVersion: 1,
        nonce,
        pid,
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        await link(temporaryPath, receiptPath);
        published = true;
      } finally {
        await removeIfPresent(temporaryPath);
      }
    },
  };
};
