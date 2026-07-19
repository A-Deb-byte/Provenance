import parseSpdxExpression from 'spdx-expression-parse';

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
