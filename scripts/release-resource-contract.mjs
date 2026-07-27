const sha256Pattern = /^[a-f0-9]{64}$/u;

export const assertRuntimeResourceManifestDigest = ({
  compiledSha256,
  currentSha256,
  phase,
}) => {
  if (!sha256Pattern.test(compiledSha256) || !sha256Pattern.test(currentSha256)) {
    throw new Error('Runtime resource manifest digests must be lowercase SHA-256 values.');
  }
  if (compiledSha256 !== currentSha256) {
    throw new Error(`Runtime resources changed ${phase}.`);
  }
  return currentSha256;
};
