import crypto from 'node:crypto';
import parseSpdxExpression from 'spdx-expression-parse';

export const applicationLicenseIdentifier = 'BUSL-1.1';
export const applicationLicenseSha256 =
  'a1795552d1786d8f443187ac3de2b4a869bc94c706cfdc74b5825cbc13a5327b';

const acceptedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
]);

const acceptedExceptions = new Set(['LLVM-exception']);

const isAcceptedNode = (node) => {
  if (node.conjunction === 'and') return isAcceptedNode(node.left) && isAcceptedNode(node.right);
  if (node.conjunction === 'or') return isAcceptedNode(node.left) || isAcceptedNode(node.right);
  return typeof node.license === 'string'
    && acceptedLicenses.has(node.license)
    && !node.plus
    && (!node.exception || acceptedExceptions.has(node.exception));
};

export const validateLicenseExpression = (expression) => {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('A declared SPDX license expression is required.');
  }
  let parsed;
  try {
    parsed = parseSpdxExpression(expression);
  } catch {
    throw new Error(`Invalid SPDX license expression: ${expression}.`);
  }
  if (!isAcceptedNode(parsed)) {
    throw new Error(`The SPDX license expression is outside release policy: ${expression}.`);
  }
  return expression;
};

export const acceptedLicenseIdentifiers = () => [...acceptedLicenses].sort();

export const digestApplicationLicenseText = (licenseText) => {
  if (typeof licenseText !== 'string') {
    throw new Error('LICENSE must be UTF-8 text.');
  }
  const normalizedText = licenseText.replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex');
};

export const validateApplicationLicenseContract = ({
  packageLicense,
  packageLockLicense,
  cargoLicense,
  licenseText,
}) => {
  for (const [source, value] of [
    ['package.json', packageLicense],
    ['package-lock.json', packageLockLicense],
    ['src-tauri/Cargo.toml', cargoLicense],
  ]) {
    if (value !== applicationLicenseIdentifier) {
      throw new Error(
        `${source} must declare the application license as ${applicationLicenseIdentifier}.`,
      );
    }
  }
  if (digestApplicationLicenseText(licenseText) !== applicationLicenseSha256) {
    throw new Error(
      'LICENSE must exactly match the authenticated Business Source License 1.1 text.',
    );
  }
  return applicationLicenseIdentifier;
};
