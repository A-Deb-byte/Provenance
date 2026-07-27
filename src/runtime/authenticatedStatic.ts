import crypto from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_KIND = 'provenance.runtime-resource-manifest';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESOURCE_FILES = 4096;
const MAX_RESOURCE_BYTES = 256 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const manifestNamePattern = /^\.desktop-resource-manifest-[a-f0-9]{32}\.json$/u;
const resourcePathPattern = /^[A-Za-z0-9][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@+-]*)*$/u;

interface ResourceRecord {
  path: string;
  sha256: string;
  size: number;
}

export interface AuthenticatedStaticResources {
  indexFile: string;
  assets: ReadonlyMap<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const samePath = (left: string, right: string): boolean => (
  process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
);

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const parseManifest = (bytes: Buffer): ResourceRecord[] => {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The authenticated runtime resource manifest is invalid JSON.');
  }
  if (!isRecord(value)
      || !hasExactKeys(value, ['kind', 'resources', 'schemaVersion'])
      || value.schemaVersion !== 1
      || value.kind !== MANIFEST_KIND
      || !Array.isArray(value.resources)
      || value.resources.length < 1
      || value.resources.length > MAX_RESOURCE_FILES) {
    throw new Error('The authenticated runtime resource manifest has an invalid schema.');
  }
  const records: ResourceRecord[] = [];
  let previous = '';
  for (const candidate of value.resources) {
    if (!isRecord(candidate)
        || !hasExactKeys(candidate, ['path', 'sha256', 'size'])
        || typeof candidate.path !== 'string'
        || candidate.path.length > 512
        || !resourcePathPattern.test(candidate.path)
        || candidate.path <= previous
        || typeof candidate.sha256 !== 'string'
        || !sha256Pattern.test(candidate.sha256)
        || !Number.isSafeInteger(candidate.size)
        || (candidate.size as number) < 1
        || (candidate.size as number) > MAX_RESOURCE_BYTES) {
      throw new Error('The authenticated runtime resource manifest has an invalid entry.');
    }
    records.push({
      path: candidate.path,
      sha256: candidate.sha256,
      size: candidate.size as number,
    });
    previous = candidate.path;
  }
  return records;
};

const authenticateStaticFile = async (
  projectRoot: string,
  record: ResourceRecord,
): Promise<string> => {
  const candidate = path.resolve(projectRoot, ...record.path.split('/'));
  const resolved = await realpath(candidate);
  if (!isWithin(projectRoot, resolved) || !samePath(candidate, resolved)) {
    throw new Error(`Authenticated static resource ${record.path} escaped its resource root.`);
  }
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.size) {
    throw new Error(`Authenticated static resource ${record.path} is not the signed regular file.`);
  }
  const bytes = await readFile(resolved);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== record.sha256) {
    throw new Error(`Authenticated static resource ${record.path} failed its signed digest.`);
  }
  return resolved;
};

export const loadAuthenticatedStaticResources = async (options: {
  projectRoot: string;
  runtimeDirectory: string;
  manifestPath: string | undefined;
  manifestSha256: string | undefined;
}): Promise<AuthenticatedStaticResources> => {
  if (!options.manifestPath || !path.isAbsolute(options.manifestPath)
      || !manifestNamePattern.test(path.basename(options.manifestPath))
      || !options.manifestSha256 || !sha256Pattern.test(options.manifestSha256)) {
    throw new Error('Packaged static resources require a Rust-authenticated manifest lease.');
  }
  const runtimeDirectory = await realpath(options.runtimeDirectory);
  const projectRoot = await realpath(options.projectRoot);
  const manifestMetadata = await lstat(options.manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
      || manifestMetadata.size < 1 || manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error('The Rust-authenticated resource manifest is not a bounded regular file.');
  }
  const manifestPath = await realpath(options.manifestPath);
  if (!samePath(path.dirname(manifestPath), runtimeDirectory)) {
    throw new Error('The Rust-authenticated resource manifest escaped the runtime directory.');
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestDigest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestDigest !== options.manifestSha256) {
    throw new Error('The Rust-authenticated resource manifest digest does not match.');
  }
  const records = parseManifest(manifestBytes);
  const indexRecord = records.find((record) => record.path === 'dist/index.html');
  const assetRecords = records.filter((record) => record.path.startsWith('dist/assets/'));
  if (!indexRecord || assetRecords.length < 1) {
    throw new Error('The authenticated manifest has no complete static application.');
  }
  const indexFile = await authenticateStaticFile(projectRoot, indexRecord);
  const assets = new Map<string, string>();
  for (const record of assetRecords) {
    const requestPath = `/${record.path.slice('dist/'.length)}`;
    assets.set(requestPath, await authenticateStaticFile(projectRoot, record));
  }
  return Object.freeze({
    indexFile,
    assets,
  });
};
