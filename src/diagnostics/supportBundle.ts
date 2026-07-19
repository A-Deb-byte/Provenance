import crypto from 'node:crypto';

const MAX_HEALTH_COMPONENTS = 64;
const MAX_LOG_ENTRIES = 200;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_ITEMS = 64;
const MAX_BUNDLE_BYTES = 256 * 1024;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const COMMIT = /^(?:unknown|[a-f0-9]{7,64})$/;
const SENSITIVE_IDENTIFIER = /^(?:sk[-_]|xox[baprs]-|akia|eyj)|(?:bearer|password|secret|token|credential)/i;
const SAFE_CONTEXT_KEYS = new Set([
  'attempt', 'count', 'durationMs', 'errorCode', 'family', 'operation', 'provider',
  'riskLevel', 'sourceRef', 'status', 'workerId',
]);

export type DiagnosticStatus = 'ok' | 'degraded' | 'blocked' | 'unavailable';
export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticHealthInput {
  component: string;
  status: DiagnosticStatus;
  reasonCode: string;
  metrics?: Readonly<Record<string, number | boolean>>;
}

export interface DiagnosticSnapshotInput {
  generatedAt?: string;
  build: {
    version: string;
    commit: string;
    mode: 'development' | 'production';
    builtAt?: string;
  };
  runtime: {
    ownershipMode: 'desktop-host' | 'node-standalone';
    desktopHost: boolean;
    processId?: number;
    uptimeSeconds?: number;
  };
  health: readonly DiagnosticHealthInput[];
}

export interface DiagnosticSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  build: {
    version: string;
    commit: string;
    mode: 'development' | 'production';
    builtAt?: string;
  };
  runtime: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
    ownershipMode: 'desktop-host' | 'node-standalone';
    desktopHost: boolean;
    processId: number;
    uptimeSeconds: number;
  };
  health: Array<{
    component: string;
    status: DiagnosticStatus;
    reasonCode: string;
    metrics: Record<string, number | boolean>;
  }>;
}

export interface DiagnosticLogInput {
  timestamp: string;
  level: DiagnosticLogLevel;
  component: string;
  event: string;
  code?: string;
  metrics?: Readonly<Record<string, number | boolean>>;
  context?: unknown;
}

export interface RedactedDiagnosticValue {
  redacted: true;
  correlationId?: string;
  reason?: 'sensitive_key' | 'depth_limit' | 'item_limit' | 'unsupported';
}

export interface DiagnosticSupportBundle {
  schemaVersion: 1;
  generatedAt: string;
  snapshot: DiagnosticSnapshot;
  logs: Array<{
    timestamp: string;
    level: DiagnosticLogLevel;
    component: string;
    event: string;
    code?: string;
    metrics: Record<string, number | boolean>;
    context?: unknown;
  }>;
  integrity: {
    algorithm: 'sha256';
    contentHash: string;
  };
}

export interface DiagnosticSupportBundleArtifact {
  fileName: string;
  contentType: 'application/json';
  byteLength: number;
  contentHash: string;
  content: string;
}

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api.?key|private.?key|session|nonce|payload|content|body|prompt|input|output|message|text)/i;
const REDACTION_REASONS = new Set(['sensitive_key', 'depth_limit', 'item_limit', 'unsupported']);
const DIAGNOSTIC_STATUSES = new Set<DiagnosticStatus>(['ok', 'degraded', 'blocked', 'unavailable']);
const LOG_LEVELS = new Set<DiagnosticLogLevel>(['debug', 'info', 'warn', 'error']);
const NODE_PLATFORMS = new Set([
  'aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd',
  'openbsd', 'sunos', 'win32',
]);

const canonicalTimestamp = (value: string, label: string): string => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
};

export const resolveDiagnosticBuildMetadata = (input: {
  packageVersion?: string;
  buildVersion?: string;
  buildCommit?: string;
  builtAt?: string;
  mode: 'development' | 'production';
}): DiagnosticSnapshotInput['build'] => {
  const packageVersion = input.packageVersion?.trim() || undefined;
  const buildVersion = input.buildVersion?.trim() || undefined;
  for (const value of [packageVersion, buildVersion]) {
    if (value && (!VERSION.test(value) || SENSITIVE_IDENTIFIER.test(value))) {
      throw new Error('Diagnostic build version metadata is invalid.');
    }
  }
  if (packageVersion && buildVersion && packageVersion !== buildVersion) {
    throw new Error('Diagnostic build version metadata does not match the package version.');
  }
  const buildCommit = input.buildCommit?.trim() || 'unknown';
  if (!COMMIT.test(buildCommit)) throw new Error('Diagnostic build commit metadata is invalid.');
  const builtAt = input.builtAt?.trim();
  return {
    version: buildVersion ?? packageVersion ?? 'unknown',
    commit: buildCommit,
    mode: input.mode,
    ...(builtAt ? { builtAt: canonicalTimestamp(builtAt, 'Diagnostic build time') } : {}),
  };
};

const identifier = (value: string, label: string): string => {
  if (value.length > 80 || !IDENTIFIER.test(value) || SENSITIVE_IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a canonical diagnostic identifier.`);
  }
  return value;
};

const boundedInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
};

const safeMetrics = (
  value: Readonly<Record<string, number | boolean>> | undefined,
): Record<string, number | boolean> => {
  if (!value) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_CONTEXT_ITEMS) throw new Error('Diagnostic metrics exceed the item limit.');
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)).map(([key, metric]) => {
    const safeKey = identifier(key, 'Diagnostic metric name');
    if (typeof metric === 'number' && !Number.isFinite(metric)) {
      throw new Error(`Diagnostic metric ${safeKey} must be finite.`);
    }
    if (typeof metric !== 'number' && typeof metric !== 'boolean') {
      throw new Error(`Diagnostic metric ${safeKey} must be numeric or boolean.`);
    }
    return [safeKey, metric];
  }));
};

const correlationMarker = (value: string, correlationKey: Buffer): RedactedDiagnosticValue => ({
  redacted: true,
  correlationId: crypto.createHmac('sha256', correlationKey).update(value, 'utf8').digest('hex'),
});

const sanitizeContext = (value: unknown, correlationKey: Buffer, depth = 0): unknown => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value)
    ? value
    : { redacted: true, reason: 'unsupported' } satisfies RedactedDiagnosticValue;
  if (typeof value === 'string') return correlationMarker(value, correlationKey);
  if (depth >= MAX_CONTEXT_DEPTH) {
    return { redacted: true, reason: 'depth_limit' } satisfies RedactedDiagnosticValue;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_CONTEXT_ITEMS)
      .map((item) => sanitizeContext(item, correlationKey, depth + 1));
    if (value.length > MAX_CONTEXT_ITEMS) {
      items.push({ redacted: true, reason: 'item_limit' } satisfies RedactedDiagnosticValue);
    }
    return items;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_CONTEXT_ITEMS);
    const sanitized: Record<string, unknown> = {};
    for (let index = 0; index < entries.length; index += 1) {
      const [rawKey, item] = entries[index];
      const key = SAFE_CONTEXT_KEYS.has(rawKey) ? rawKey : `field_${index}`;
      sanitized[key] = SENSITIVE_KEY.test(rawKey)
        ? { redacted: true, reason: 'sensitive_key' } satisfies RedactedDiagnosticValue
        : sanitizeContext(item, correlationKey, depth + 1);
    }
    if (Object.keys(value).length > MAX_CONTEXT_ITEMS) {
      sanitized.truncated = { redacted: true, reason: 'item_limit' } satisfies RedactedDiagnosticValue;
    }
    return sanitized;
  }
  return { redacted: true, reason: 'unsupported' } satisfies RedactedDiagnosticValue;
};

export const createDiagnosticSnapshot = (input: DiagnosticSnapshotInput): DiagnosticSnapshot => {
  const generatedAt = canonicalTimestamp(input.generatedAt ?? new Date().toISOString(), 'Diagnostic snapshot time');
  if (!VERSION.test(input.build.version) || SENSITIVE_IDENTIFIER.test(input.build.version)) {
    throw new Error('Diagnostic build version is invalid.');
  }
  if (!COMMIT.test(input.build.commit)) throw new Error('Diagnostic build commit is invalid.');
  if (input.build.mode !== 'development' && input.build.mode !== 'production') {
    throw new Error('Diagnostic build mode is invalid.');
  }
  if (input.runtime.ownershipMode !== 'desktop-host' && input.runtime.ownershipMode !== 'node-standalone') {
    throw new Error('Diagnostic runtime ownership mode is invalid.');
  }
  if (typeof input.runtime.desktopHost !== 'boolean') throw new Error('Diagnostic desktop-host flag is invalid.');
  if (input.runtime.desktopHost !== (input.runtime.ownershipMode === 'desktop-host')) {
    throw new Error('Diagnostic desktop-host mode is inconsistent.');
  }
  if (input.health.length > MAX_HEALTH_COMPONENTS) throw new Error('Diagnostic health component limit exceeded.');

  const health = input.health.map((entry) => {
    if (!DIAGNOSTIC_STATUSES.has(entry.status)) throw new Error('Diagnostic health status is invalid.');
    return {
      component: identifier(entry.component, 'Diagnostic component'),
      status: entry.status,
      reasonCode: identifier(entry.reasonCode, 'Diagnostic reason code'),
      metrics: safeMetrics(entry.metrics),
    };
  }).sort((left, right) => left.component.localeCompare(right.component));
  if (new Set(health.map((entry) => entry.component)).size !== health.length) {
    throw new Error('Diagnostic health components must be unique.');
  }

  const processId = boundedInteger(input.runtime.processId ?? process.pid, 'Diagnostic process id');
  const uptimeSeconds = boundedInteger(
    input.runtime.uptimeSeconds ?? Math.floor(process.uptime()),
    'Diagnostic runtime uptime',
  );
  return {
    schemaVersion: 1,
    generatedAt,
    build: {
      version: input.build.version,
      commit: input.build.commit,
      mode: input.build.mode,
      ...(input.build.builtAt
        ? { builtAt: canonicalTimestamp(input.build.builtAt, 'Diagnostic build time') }
        : {}),
    },
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      ownershipMode: input.runtime.ownershipMode,
      desktopHost: input.runtime.desktopHost,
      processId,
      uptimeSeconds,
    },
    health,
  };
};

const sanitizeLog = (
  entry: DiagnosticLogInput,
  correlationKey: Buffer,
): DiagnosticSupportBundle['logs'][number] => {
  if (!LOG_LEVELS.has(entry.level)) {
    throw new Error('Diagnostic log level is invalid.');
  }
  return {
    timestamp: canonicalTimestamp(entry.timestamp, 'Diagnostic log time'),
    level: entry.level,
    component: identifier(entry.component, 'Diagnostic log component'),
    event: identifier(entry.event, 'Diagnostic event'),
    ...(entry.code ? { code: identifier(entry.code, 'Diagnostic code') } : {}),
    metrics: safeMetrics(entry.metrics),
    ...(entry.context === undefined ? {} : { context: sanitizeContext(entry.context, correlationKey) }),
  };
};

const unsignedBundleContent = (bundle: Omit<DiagnosticSupportBundle, 'integrity'>): string => JSON.stringify(bundle);

const normalizeSnapshot = (snapshot: DiagnosticSnapshot): DiagnosticSnapshot => {
  const normalized = createDiagnosticSnapshot({
    generatedAt: snapshot.generatedAt,
    build: {
      version: snapshot.build.version,
      commit: snapshot.build.commit,
      mode: snapshot.build.mode,
      ...(snapshot.build.builtAt ? { builtAt: snapshot.build.builtAt } : {}),
    },
    runtime: {
      ownershipMode: snapshot.runtime.ownershipMode,
      desktopHost: snapshot.runtime.desktopHost,
      processId: snapshot.runtime.processId,
      uptimeSeconds: snapshot.runtime.uptimeSeconds,
    },
    health: snapshot.health,
  });
  if (snapshot.runtime.platform !== normalized.runtime.platform ||
    snapshot.runtime.architecture !== normalized.runtime.architecture ||
    snapshot.runtime.nodeVersion !== normalized.runtime.nodeVersion) {
    throw new Error('Diagnostic runtime identity does not match this process.');
  }
  return normalized;
};

const finalizeBundle = (
  unsigned: Omit<DiagnosticSupportBundle, 'integrity'>,
): { bundle: DiagnosticSupportBundle; content: string; contentHash: string } => {
  const unsignedContent = unsignedBundleContent(unsigned);
  const contentHash = crypto.createHash('sha256').update(unsignedContent, 'utf8').digest('hex');
  const bundle: DiagnosticSupportBundle = {
    ...unsigned,
    integrity: { algorithm: 'sha256', contentHash },
  };
  return { bundle, content: JSON.stringify(bundle), contentHash };
};

export const createDiagnosticSupportBundle = (input: {
  snapshot: DiagnosticSnapshot;
  logs?: readonly DiagnosticLogInput[];
  generatedAt?: string;
}): DiagnosticSupportBundleArtifact => {
  const generatedAt = canonicalTimestamp(input.generatedAt ?? new Date().toISOString(), 'Support bundle time');
  const correlationKey = crypto.randomBytes(32);
  let logs = (input.logs ?? []).slice(-MAX_LOG_ENTRIES)
    .map((entry) => sanitizeLog(entry, correlationKey));
  let unsigned: Omit<DiagnosticSupportBundle, 'integrity'> = {
    schemaVersion: 1,
    generatedAt,
    snapshot: normalizeSnapshot(input.snapshot),
    logs,
  };
  let finalized = finalizeBundle(unsigned);
  while (logs.length > 0 && Buffer.byteLength(finalized.content, 'utf8') > MAX_BUNDLE_BYTES) {
    logs = logs.slice(1);
    unsigned = { ...unsigned, logs };
    finalized = finalizeBundle(unsigned);
  }
  if (Buffer.byteLength(finalized.content, 'utf8') > MAX_BUNDLE_BYTES) {
    throw new Error('Diagnostic snapshot exceeds the support bundle size limit.');
  }
  return {
    fileName: `provenance-support-${generatedAt.replace(/[:.]/g, '-')}.json`,
    contentType: 'application/json',
    byteLength: Buffer.byteLength(finalized.content, 'utf8'),
    contentHash: crypto.createHash('sha256').update(finalized.content, 'utf8').digest('hex'),
    content: finalized.content,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return canonicalTimestamp(value, 'Diagnostic timestamp') === value;
  } catch {
    return false;
  }
};

const isDiagnosticIdentifier = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return identifier(value, 'Diagnostic identifier') === value;
  } catch {
    return false;
  }
};

const isSafeMetrics = (value: unknown): value is Record<string, number | boolean> => {
  if (!isRecord(value) || Object.keys(value).length > MAX_CONTEXT_ITEMS) return false;
  return Object.entries(value).every(([key, metric]) => (
    isDiagnosticIdentifier(key) &&
    (typeof metric === 'boolean' || (typeof metric === 'number' && Number.isFinite(metric)))
  ));
};

const isRedactionMarker = (value: Record<string, unknown>): boolean => {
  if (value.redacted !== true) return false;
  if (hasExactKeys(value, ['redacted', 'correlationId'])) {
    return typeof value.correlationId === 'string' && /^[a-f0-9]{64}$/.test(value.correlationId);
  }
  return hasExactKeys(value, ['redacted', 'reason']) &&
    typeof value.reason === 'string' && REDACTION_REASONS.has(value.reason);
};

const isSafeSanitizedContext = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || value === undefined) return false;
  if (Array.isArray(value)) {
    if (depth >= MAX_CONTEXT_DEPTH || value.length > MAX_CONTEXT_ITEMS + 1 ||
      !value.every((item) => isSafeSanitizedContext(item, depth + 1))) return false;
    if (value.length !== MAX_CONTEXT_ITEMS + 1) return true;
    const finalItem = value.at(-1);
    return isRecord(finalItem) && hasExactKeys(finalItem, ['redacted', 'reason']) &&
      finalItem.redacted === true && finalItem.reason === 'item_limit';
  }
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'redacted')) return isRedactionMarker(value);
  if (depth >= MAX_CONTEXT_DEPTH || Object.keys(value).length > MAX_CONTEXT_ITEMS + 1) return false;
  return Object.entries(value).every(([key, item]) => {
    const keyAllowed = SAFE_CONTEXT_KEYS.has(key) ||
      /^field_(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(key) || key === 'truncated';
    if (!keyAllowed || !isSafeSanitizedContext(item, depth + 1)) return false;
    return key !== 'truncated' || (
      isRecord(item) && hasExactKeys(item, ['redacted', 'reason']) && item.reason === 'item_limit'
    );
  });
};

const isSafeSnapshot = (value: unknown): value is DiagnosticSnapshot => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'generatedAt', 'build', 'runtime', 'health',
  ]) || value.schemaVersion !== 1 || !isCanonicalTimestamp(value.generatedAt) ||
    !isRecord(value.build) || !isRecord(value.runtime) || !Array.isArray(value.health)) return false;

  if (!hasExactKeys(value.build, ['version', 'commit', 'mode'], ['builtAt']) ||
    typeof value.build.version !== 'string' || !VERSION.test(value.build.version) ||
    SENSITIVE_IDENTIFIER.test(value.build.version) || typeof value.build.commit !== 'string' ||
    !COMMIT.test(value.build.commit) ||
    (value.build.mode !== 'development' && value.build.mode !== 'production') ||
    (value.build.builtAt !== undefined && !isCanonicalTimestamp(value.build.builtAt))) return false;

  if (!hasExactKeys(value.runtime, [
    'platform', 'architecture', 'nodeVersion', 'ownershipMode', 'desktopHost',
    'processId', 'uptimeSeconds',
  ]) || typeof value.runtime.platform !== 'string' || !NODE_PLATFORMS.has(value.runtime.platform) ||
    typeof value.runtime.architecture !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(value.runtime.architecture) ||
    typeof value.runtime.nodeVersion !== 'string' ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.runtime.nodeVersion) ||
    (value.runtime.ownershipMode !== 'desktop-host' && value.runtime.ownershipMode !== 'node-standalone') ||
    typeof value.runtime.desktopHost !== 'boolean' ||
    value.runtime.desktopHost !== (value.runtime.ownershipMode === 'desktop-host') ||
    !Number.isSafeInteger(value.runtime.processId) || (value.runtime.processId as number) < 0 ||
    !Number.isSafeInteger(value.runtime.uptimeSeconds) || (value.runtime.uptimeSeconds as number) < 0 ||
    value.health.length > MAX_HEALTH_COMPONENTS) return false;

  const components = new Set<string>();
  for (const health of value.health) {
    if (!isRecord(health) || !hasExactKeys(health, ['component', 'status', 'reasonCode', 'metrics']) ||
      !isDiagnosticIdentifier(health.component) ||
      typeof health.status !== 'string' || !DIAGNOSTIC_STATUSES.has(health.status as DiagnosticStatus) ||
      !isDiagnosticIdentifier(health.reasonCode) || !isSafeMetrics(health.metrics) ||
      components.has(health.component)) return false;
    components.add(health.component);
  }
  return true;
};

const isSafeLog = (value: unknown): value is DiagnosticSupportBundle['logs'][number] => {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['timestamp', 'level', 'component', 'event', 'metrics'],
    ['code', 'context'],
  ) || !isCanonicalTimestamp(value.timestamp) || typeof value.level !== 'string' ||
    !LOG_LEVELS.has(value.level as DiagnosticLogLevel) || !isDiagnosticIdentifier(value.component) ||
    !isDiagnosticIdentifier(value.event) ||
    (value.code !== undefined && !isDiagnosticIdentifier(value.code)) || !isSafeMetrics(value.metrics)) return false;
  return value.context === undefined || isSafeSanitizedContext(value.context);
};

const isSafeBundle = (value: unknown): value is DiagnosticSupportBundle => (
  isRecord(value) && hasExactKeys(value, ['schemaVersion', 'generatedAt', 'snapshot', 'logs', 'integrity']) &&
  value.schemaVersion === 1 && isCanonicalTimestamp(value.generatedAt) && isSafeSnapshot(value.snapshot) &&
  Array.isArray(value.logs) && value.logs.length <= MAX_LOG_ENTRIES && value.logs.every(isSafeLog) &&
  isRecord(value.integrity) && hasExactKeys(value.integrity, ['algorithm', 'contentHash']) &&
  value.integrity.algorithm === 'sha256' && typeof value.integrity.contentHash === 'string' &&
  /^[a-f0-9]{64}$/.test(value.integrity.contentHash)
);

/** Validates canonical safe-schema conformance and checksum integrity, not signer authenticity. */
export const verifyDiagnosticSupportBundle = (content: string): boolean => {
  try {
    if (Buffer.byteLength(content, 'utf8') > MAX_BUNDLE_BYTES) return false;
    const parsed: unknown = JSON.parse(content);
    if (!isSafeBundle(parsed) || JSON.stringify(parsed) !== content) return false;
    const { integrity, ...unsigned } = parsed;
    const actual = crypto.createHash('sha256').update(JSON.stringify(unsigned), 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(integrity.contentHash, 'hex'));
  } catch {
    return false;
  }
};
