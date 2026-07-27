import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthenticatedStaticResources } from './authenticatedStatic';

const manifestKind = 'provenance.runtime-resource-manifest';

describe('authenticated packaged static resources', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  const fixture = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'provenance-static-root-'));
    const runtime = await mkdtemp(path.join(os.tmpdir(), 'provenance-static-runtime-'));
    temporary.push(root, runtime);
    await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
    const files = [
      ['dist/assets/app.js', Buffer.from('console.log("signed");')],
      ['dist/index.html', Buffer.from('<main>signed</main>')],
      ['dist/server.cjs', Buffer.from('not exposed')],
    ] as const;
    for (const [relative, bytes] of files) {
      await writeFile(path.join(root, ...relative.split('/')), bytes);
    }
    const resources = files.map(([resourcePath, bytes]) => ({
      path: resourcePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    })).sort((left, right) => left.path < right.path ? -1 : 1);
    const manifestBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      kind: manifestKind,
      resources,
    })}\n`);
    const manifestPath = path.join(
      runtime,
      '.desktop-resource-manifest-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
    );
    await writeFile(manifestPath, manifestBytes);
    return {
      root,
      runtime,
      manifestPath,
      manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    };
  };

  it('maps only the signed UI index and exact signed asset routes', async () => {
    const created = await fixture();
    const resources = await loadAuthenticatedStaticResources({
      projectRoot: created.root,
      runtimeDirectory: created.runtime,
      manifestPath: created.manifestPath,
      manifestSha256: created.manifestSha256,
    });
    expect(resources.indexFile).toBe(path.join(created.root, 'dist', 'index.html'));
    expect([...resources.assets.keys()]).toEqual(['/assets/app.js']);
    expect(resources.assets.has('/server.cjs')).toBe(false);
  });

  it('fails closed on a changed manifest, resource, or non-runtime path', async () => {
    const changedManifest = await fixture();
    await expect(loadAuthenticatedStaticResources({
      projectRoot: changedManifest.root,
      runtimeDirectory: changedManifest.runtime,
      manifestPath: changedManifest.manifestPath,
      manifestSha256: '0'.repeat(64),
    })).rejects.toThrow(/digest does not match/u);

    const changedResource = await fixture();
    await writeFile(path.join(changedResource.root, 'dist', 'assets', 'app.js'), 'changed');
    await expect(loadAuthenticatedStaticResources({
      projectRoot: changedResource.root,
      runtimeDirectory: changedResource.runtime,
      manifestPath: changedResource.manifestPath,
      manifestSha256: changedResource.manifestSha256,
    })).rejects.toThrow(/signed regular file|signed digest/u);

    const escaped = await fixture();
    const outside = path.join(
      escaped.root,
      '.desktop-resource-manifest-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
    );
    await writeFile(outside, await import('node:fs/promises').then(({ readFile }) => (
      readFile(escaped.manifestPath)
    )));
    await expect(loadAuthenticatedStaticResources({
      projectRoot: escaped.root,
      runtimeDirectory: escaped.runtime,
      manifestPath: outside,
      manifestSha256: escaped.manifestSha256,
    })).rejects.toThrow(/escaped the runtime directory/u);
  });
});
