import crypto from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

export const RUNTIME_RESOURCE_MANIFEST_KIND = 'provenance.runtime-resource-manifest';
export const DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL = 'unverified-development';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumResources = 4096;
const maximumResourceBytes = 256 * 1024 * 1024;

export const compareAsciiOrdinal = (left, right) => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const canonicalPath = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
      || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new Error('Runtime resource paths must be canonical relative paths.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/u.test(segment))) {
    throw new Error('Runtime resource paths must be canonical relative paths.');
  }
  return value;
};

const digestBytes = (value) => crypto.createHash('sha256').update(value).digest('hex');

const resourceRecord = (resource) => {
  const path = canonicalPath(resource.destination ?? resource.path);
  let size = resource.size;
  let sha256 = resource.sha256;
  if (resource.source !== undefined) {
    const metadata = lstatSync(resource.source);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size < 1 || metadata.size > maximumResourceBytes) {
      throw new Error(`Runtime resource ${path} is not a bounded regular file.`);
    }
    const bytes = readFileSync(resource.source);
    size = metadata.size;
    sha256 = digestBytes(bytes);
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumResourceBytes
      || typeof sha256 !== 'string' || !sha256Pattern.test(sha256)) {
    throw new Error(`Runtime resource ${path} has invalid size or hash metadata.`);
  }
  return Object.freeze({ path, sha256, size });
};

export const createRuntimeResourceManifest = (resources) => {
  if (!Array.isArray(resources) || resources.length < 1 || resources.length > maximumResources) {
    throw new Error('Runtime resources must be a bounded non-empty list.');
  }
  const records = resources.map(resourceRecord)
    .sort((left, right) => compareAsciiOrdinal(left.path, right.path));
  if (records.some((record, index) => index > 0 && records[index - 1].path === record.path)) {
    throw new Error('Runtime resource paths must be unique.');
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: RUNTIME_RESOURCE_MANIFEST_KIND,
    resources: records,
  });
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  return Object.freeze({
    manifest,
    bytes,
    sha256: digestBytes(bytes),
  });
};

export const writeRuntimeResourceManifest = (resources, target) => {
  const created = createRuntimeResourceManifest(resources);
  writeFileSync(target, created.bytes, { flag: 'wx' });
  return Object.freeze({ ...created, path: target });
};
