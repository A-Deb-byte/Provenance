import crypto from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER_SCHEMA_VERSION = 1 as const;
const OWNER_FILE = 'runtime-owner.json';

interface DesktopHostOwner {
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
  mode: 'desktop-host';
  proofHash: string;
  hostPid: number;
  createdAt: string;
}

interface StandaloneOwner {
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
  mode: 'node-standalone';
  nonce: string;
  pid: number;
  createdAt: string;
}

type RuntimeOwner = DesktopHostOwner | StandaloneOwner;

export interface RuntimeOwnership {
  mode: RuntimeOwner['mode'];
  ownerPath: string;
  release(): Promise<void>;
}

export interface RuntimeOwnershipOptions {
  desktopOwnerNonce?: string;
  desktopHostPid?: number;
  pid?: number;
  now?: () => string;
  randomNonce?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const isSha256 = (value: unknown): value is string => (
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseOwner = (value: unknown): RuntimeOwner | undefined => {
  if (!isRecord(value) || value.schemaVersion !== OWNER_SCHEMA_VERSION ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    return undefined;
  }
  if (value.mode === 'desktop-host' && isPid(value.hostPid) && isSha256(value.proofHash) &&
    hasExactKeys(value, ['schemaVersion', 'mode', 'proofHash', 'hostPid', 'createdAt'])) {
    return value as unknown as DesktopHostOwner;
  }
  if (value.mode === 'node-standalone' && isPid(value.pid) &&
    typeof value.nonce === 'string' && value.nonce.length >= 32 && /^[\x21-\x7e]+$/.test(value.nonce) &&
    hasExactKeys(value, ['schemaVersion', 'mode', 'nonce', 'pid', 'createdAt'])) {
    return value as unknown as StandaloneOwner;
  }
  return undefined;
};

const hashDesktopProof = (proof: string): Buffer => crypto.createHash('sha256').update(proof, 'utf8').digest();

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readOwner = async (ownerPath: string): Promise<RuntimeOwner | undefined> => {
  try {
    return parseOwner(JSON.parse(await readFile(ownerPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const ownerPid = (owner: RuntimeOwner): number => owner.mode === 'desktop-host' ? owner.hostPid : owner.pid;

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
};

/**
 * Acquires the cross-launch runtime record before any kernel state is opened.
 * The native host owns the record in desktop mode; standalone Node instances
 * publish it atomically with a hard link so readers never observe partial JSON.
 */
export const acquireRuntimeOwnership = async (
  runtimeDir: string,
  options: RuntimeOwnershipOptions = {},
): Promise<RuntimeOwnership> => {
  const absoluteRuntimeDir = path.resolve(runtimeDir);
  const ownerPath = path.join(absoluteRuntimeDir, OWNER_FILE);
  const isAlive = options.isProcessAlive ?? processIsAlive;
  await mkdir(absoluteRuntimeDir, { recursive: true });

  const expectedDesktopNonce = options.desktopOwnerNonce?.trim();
  if (expectedDesktopNonce) {
    const owner = await readOwner(ownerPath);
    const expectedHostPid = options.desktopHostPid;
    const proofMatches = owner?.mode === 'desktop-host' && crypto.timingSafeEqual(
      Buffer.from(owner.proofHash, 'hex'),
      hashDesktopProof(expectedDesktopNonce),
    );
    if (!owner || owner.mode !== 'desktop-host' || !proofMatches ||
      (expectedHostPid !== undefined && owner.hostPid !== expectedHostPid)) {
      throw new Error('Native desktop runtime ownership proof is missing or does not match this launch.');
    }
    if (!isAlive(owner.hostPid)) throw new Error('Native desktop runtime owner process is not alive.');
    return { mode: owner.mode, ownerPath, release: async () => undefined };
  }

  const pid = options.pid ?? process.pid;
  const nonce = options.randomNonce?.() ?? crypto.randomBytes(24).toString('hex');
  const owner: StandaloneOwner = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    mode: 'node-standalone',
    nonce,
    pid,
    createdAt: options.now?.() ?? new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporaryPath = path.join(absoluteRuntimeDir, `.runtime-owner-${pid}-${nonce}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await link(temporaryPath, ownerPath);
      await unlinkIfPresent(temporaryPath);
      return {
        mode: owner.mode,
        ownerPath,
        release: async () => {
          const current = await readOwner(ownerPath);
          if (current?.mode === 'node-standalone' && current.pid === pid && current.nonce === nonce) {
            await unlinkIfPresent(ownerPath);
          }
        },
      };
    } catch (error) {
      await unlinkIfPresent(temporaryPath);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readOwner(ownerPath);
      if (current && isAlive(ownerPid(current))) {
        throw new Error(`Runtime directory is already owned by a live ${current.mode} process.`);
      }
      await unlinkIfPresent(ownerPath);
    }
  }
  throw new Error('Runtime ownership could not be acquired after stale-owner recovery.');
};
