import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { useCapabilityToken } from '../capabilities';
import { CapabilityToken, KernelCommandRequest, KernelEvidence } from '../types';

const execFileAsync = promisify(execFile);
const allowedNpmArguments = new Set(['test', 'run lint', 'run build', '--version']);
const sensitiveEnvironmentName = /(auth|credential|key|password|secret|token)/i;
const maxEvidenceOutputLength = 32 * 1024;

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isWorkerAllowlistedRequest = (request: KernelCommandRequest): boolean => {
  return request.command === 'npm' && allowedNpmArguments.has(request.args.join(' '));
};

const resolveExecutable = (request: KernelCommandRequest): { file: string; args: string[] } => {
  if (process.platform === 'win32' && request.command === 'npm') {
    const npmCliPath = process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath)
      ? process.env.npm_execpath
      : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return {
      file: process.execPath,
      args: [npmCliPath, ...request.args],
    };
  }

  return { file: request.command, args: request.args };
};

const createWorkerEnvironment = (): NodeJS.ProcessEnv => {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)),
  );
};

const sanitizeOutput = (value: unknown): string => {
  const output = typeof value === 'string' ? value : value ? String(value) : '';
  const redacted = output.replace(
    /((?:auth|credential|api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s]+/gi,
    '$1[REDACTED]',
  );
  if (redacted.length <= maxEvidenceOutputLength) return redacted;
  return `${redacted.slice(0, maxEvidenceOutputLength)}\n[output truncated]`;
};

const isTokenScopedToRequest = (token: CapabilityToken, request: KernelCommandRequest): boolean => {
  return (
    token.family === 'command.run' &&
    token.scope.command === request.command &&
    token.scope.args?.join('\u0000') === request.args.join('\u0000') &&
    typeof token.scope.cwd === 'string' &&
    path.resolve(token.scope.cwd) === path.resolve(request.cwd)
  );
};

export interface CommandWorkerOptions {
  timeoutMs?: number;
}

export const runKernelCommand = async (
  token: CapabilityToken,
  request: KernelCommandRequest,
  options: CommandWorkerOptions = {},
): Promise<KernelEvidence> => {
  const started = Date.now();
  if (!isTokenScopedToRequest(token, request)) {
    return {
      kind: 'command_output',
      summary: 'Command denied by capability token.',
      exitCode: 1,
      stderr: 'Command not allowlisted by capability token.',
    };
  }
  let canonicalWorkspaceRoot: string;
  let canonicalCwd: string;
  try {
    [canonicalWorkspaceRoot, canonicalCwd] = await Promise.all([
      realpath(token.scope.workspaceRoot),
      realpath(request.cwd),
    ]);
  } catch {
    return {
      kind: 'command_output',
      summary: 'Command denied because its workspace could not be resolved.',
      exitCode: 1,
      stderr: 'Command workspace or cwd does not exist.',
    };
  }
  if (!isWithinRoot(canonicalWorkspaceRoot, canonicalCwd)) {
    return {
      kind: 'command_output',
      summary: 'Command denied outside workspace.',
      exitCode: 1,
      stderr: 'Command cwd is outside the token workspace root.',
    };
  }
  if (!isWorkerAllowlistedRequest(request)) {
    return {
      kind: 'command_output',
      summary: 'Command denied by worker allowlist.',
      exitCode: 1,
      stderr: 'Command request is not allowlisted.',
    };
  }
  const capabilityUse = useCapabilityToken(token);
  if (!capabilityUse.allowed) {
    return {
      kind: 'command_output',
      summary: 'Command denied by capability token.',
      exitCode: 1,
      stderr: capabilityUse.reason,
    };
  }
  token.usedOperations = capabilityUse.token.usedOperations;

  try {
    const executable = resolveExecutable(request);
    const result = await execFileAsync(executable.file, executable.args, {
      cwd: request.cwd,
      timeout: Math.max(1, Math.min(options.timeoutMs ?? 120000, 120000)),
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: createWorkerEnvironment(),
    });
    return {
      kind: 'command_output',
      summary: `${request.command} ${request.args.join(' ')} exited with code 0.`,
      command: `${request.command} ${request.args.join(' ')}`,
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: sanitizeOutput(result.stdout),
      stderr: sanitizeOutput(result.stderr),
    };
  } catch (error) {
    const commandError = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      kind: 'command_output',
      summary: `${request.command} ${request.args.join(' ')} failed.`,
      command: `${request.command} ${request.args.join(' ')}`,
      exitCode: typeof commandError.code === 'number' ? commandError.code : 1,
      durationMs: Date.now() - started,
      stdout: sanitizeOutput(commandError.stdout),
      stderr: sanitizeOutput(commandError.stderr || commandError.message || 'Command failed.'),
    };
  }
};
