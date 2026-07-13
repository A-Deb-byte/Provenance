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

const MAX_ARTIFACT_CHARS = 16 * 1024;
const FILE_SUFFIX = '.artifact.json';

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
 * File-backed store for typed payloads (e.g. the text a browser worker will
 * enter into a form field). Payloads are addressed by id and verified by a
 * sha256 content hash, so an action intent can only cause a known, staged
 * value to be typed — untrusted page content cannot inject keystrokes.
 */
export const createFileArtifactStore = (dir: string): ArtifactStore => {
  const artifactsDir = path.resolve(dir);
  const filePath = (id: string) => path.join(artifactsDir, `${id}${FILE_SUFFIX}`);

  return {
    create: async (content) => {
      if (typeof content !== 'string' || content.length === 0 || content.length > MAX_ARTIFACT_CHARS) {
        throw new Error(`Artifact content must be 1-${MAX_ARTIFACT_CHARS} characters.`);
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
