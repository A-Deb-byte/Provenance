import crypto from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createKernelId } from '../ids';

export interface ArtifactMetadata {
  id: string;
  contentHash: string;
  byteLength: number;
  createdAt: string;
}

export interface ResolvedArtifact {
  content: string;
  contentHash: string;
}

export interface ArtifactStore {
  create(content: string): Promise<ArtifactMetadata>;
  resolve(id: string): Promise<ResolvedArtifact | undefined>;
  list(): Promise<ArtifactMetadata[]>;
}

const DEFAULT_MAX_ARTIFACT_CHARS = 16 * 1024;
const MAX_CONFIGURED_ARTIFACT_CHARS = 32 * 1024 * 1024;
const FILE_SUFFIX = '.artifact.json';

export interface FileArtifactStoreOptions {
  maxArtifactChars?: number;
}

export const hashArtifactContent = (content: string): string => (
  crypto.createHash('sha256').update(content, 'utf8').digest('hex')
);

interface ArtifactFile extends ArtifactMetadata {
  content: string;
}

const isArtifactFile = (value: unknown): value is ArtifactFile => (
  typeof value === 'object' && value !== null &&
  typeof (value as ArtifactFile).id === 'string' &&
  typeof (value as ArtifactFile).content === 'string' &&
  typeof (value as ArtifactFile).contentHash === 'string'
);

/**
 * File-backed content-addressed store for staged payloads. Individual
 * consumers enforce their own tighter size and content constraints. A
 * sha256 content hash ensures a resolved payload still matches its record.
 */
export const createFileArtifactStore = (
  dir: string,
  options: FileArtifactStoreOptions = {},
): ArtifactStore => {
  const artifactsDir = path.resolve(dir);
  const maxArtifactChars = options.maxArtifactChars ?? DEFAULT_MAX_ARTIFACT_CHARS;
  if (!Number.isSafeInteger(maxArtifactChars) || maxArtifactChars < 1 || maxArtifactChars > MAX_CONFIGURED_ARTIFACT_CHARS) {
    throw new Error(`Artifact store limit must be between 1 and ${MAX_CONFIGURED_ARTIFACT_CHARS} characters.`);
  }
  const filePath = (id: string) => path.join(artifactsDir, `${id}${FILE_SUFFIX}`);

  return {
    create: async (content) => {
      if (typeof content !== 'string' || content.length === 0 || content.length > maxArtifactChars) {
        throw new Error(`Artifact content must be 1-${maxArtifactChars} characters.`);
      }
      const record: ArtifactFile = {
        id: createKernelId('artifact'),
        content,
        contentHash: hashArtifactContent(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
        createdAt: new Date().toISOString(),
      };
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(filePath(record.id), JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      const { content: _omit, ...metadata } = record;
      return metadata;
    },
    resolve: async (id) => {
      if (!/^artifact_[A-Za-z0-9-]+$/.test(id)) return undefined;
      try {
        const parsed = JSON.parse(await readFile(filePath(id), 'utf8'));
        if (!isArtifactFile(parsed)) return undefined;
        // Re-verify the stored hash so a tampered file cannot smuggle content.
        if (hashArtifactContent(parsed.content) !== parsed.contentHash) return undefined;
        return { content: parsed.content, contentHash: parsed.contentHash };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    list: async () => {
      try {
        const entries = await readdir(artifactsDir);
        const files = entries.filter((entry) => entry.endsWith(FILE_SUFFIX));
        const metadata = await Promise.all(files.map(async (file) => {
          const parsed = JSON.parse(await readFile(path.join(artifactsDir, file), 'utf8')) as ArtifactFile;
          return { id: parsed.id, contentHash: parsed.contentHash, byteLength: parsed.byteLength, createdAt: parsed.createdAt };
        }));
        return metadata.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
};
