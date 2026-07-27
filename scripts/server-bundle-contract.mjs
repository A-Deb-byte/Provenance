import { builtinModules } from 'node:module';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const normalizedOutputPath = (value) => value.replaceAll('\\', '/');

export const findServerBundleOutput = (metafile) => {
  if (!metafile || typeof metafile !== 'object' || !metafile.outputs ||
      typeof metafile.outputs !== 'object') {
    throw new Error('The packaged server esbuild metadata is missing.');
  }
  const matches = Object.entries(metafile.outputs).filter(([name]) => {
    const normalized = normalizedOutputPath(name);
    return normalized === 'dist/server.cjs' || normalized.endsWith('/dist/server.cjs');
  });
  if (matches.length !== 1 || !Array.isArray(matches[0][1]?.imports)) {
    throw new Error('The packaged server esbuild metadata must describe exactly one server.cjs output.');
  }
  return matches[0][1];
};

export const assertServerBundleHasBuiltinOnlyExternals = (metafile) => {
  const output = findServerBundleOutput(metafile);
  const nonBuiltin = output.imports.filter((item) => (
    item?.external === true &&
    (typeof item.path !== 'string' || !builtins.has(item.path))
  ));
  if (nonBuiltin.length > 0) {
    const imports = nonBuiltin.map((item) => (
      `${typeof item.path === 'string' ? item.path : '<invalid>'}:${item.kind ?? '<unknown>'}`
    ));
    throw new Error(`Packaged server has non-builtin external imports: ${imports.join(', ')}`);
  }
  return Object.freeze({
    externalImports: Object.freeze(output.imports
      .filter((item) => item?.external === true)
      .map((item) => Object.freeze({ path: item.path, kind: item.kind }))),
    nonBuiltinExternalImports: Object.freeze([]),
  });
};
