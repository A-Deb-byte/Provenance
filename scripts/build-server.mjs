#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertServerBundleHasBuiltinOnlyExternals } from './server-bundle-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = path.join(repositoryRoot, 'dist', 'server.cjs');
const metadataFile = path.join(repositoryRoot, 'dist', 'server.meta.json');
const disabledOptionalPackages = new Set([
  'bufferutil',
  'supports-color',
  'utf-8-validate',
]);

export const packagedDependencyStubs = {
  name: 'provenance-packaged-dependency-stubs',
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^(?:bufferutil|supports-color|utf-8-validate)$/ },
      ({ path: requestedPackage }) => ({
        path: requestedPackage,
        namespace: 'provenance-disabled-optional-package',
      }),
    );
    buildContext.onLoad(
      { filter: /.*/, namespace: 'provenance-disabled-optional-package' },
      ({ path: requestedPackage }) => {
        if (!disabledOptionalPackages.has(requestedPackage)) {
          throw new Error(`Unexpected optional package stub request: ${requestedPackage}`);
        }
        return {
          contents: `throw new Error(${JSON.stringify(
            `Optional package ${requestedPackage} is disabled in the packaged server.`,
          )});`,
          loader: 'js',
        };
      },
    );
    buildContext.onResolve({ filter: /^vite$/ }, () => ({
      path: 'vite',
      namespace: 'provenance-disabled-vite',
    }));
    buildContext.onLoad(
      { filter: /.*/, namespace: 'provenance-disabled-vite' },
      () => ({
        contents: [
          'export async function createServer() {',
          "  throw new Error('Vite is unavailable in the packaged production server.');",
          '}',
        ].join('\n'),
        loader: 'js',
      }),
    );
  },
};

export const buildPackagedServer = async () => {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['server.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    metafile: true,
    outfile: outputFile,
    plugins: [packagedDependencyStubs],
    write: false,
  });
  assertServerBundleHasBuiltinOnlyExternals(result.metafile);
  const outputs = new Map(result.outputFiles.map((file) => [path.resolve(file.path), file.contents]));
  const serverBytes = outputs.get(outputFile);
  const sourceMapBytes = outputs.get(`${outputFile}.map`);
  if (!serverBytes || !sourceMapBytes || outputs.size !== 2) {
    throw new Error('The packaged server build produced an unexpected output inventory.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await Promise.all([
    writeFile(outputFile, serverBytes),
    writeFile(`${outputFile}.map`, sourceMapBytes),
    writeFile(metadataFile, `${JSON.stringify(result.metafile, null, 2)}\n`, 'utf8'),
  ]);
  return result.metafile;
};

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await buildPackagedServer();
}
