import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityToken } from '../capabilities';
import { runKernelCommand } from './commandWorker';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-worker-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('command worker', () => {
  it('denies commands that do not match the capability token', async () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: tempDir,
      command: 'npm',
      args: ['test'],
      cwd: tempDir,
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await runKernelCommand(token, {
      command: 'powershell',
      args: ['Get-ChildItem'],
      cwd: tempDir,
      expectedEvidence: 'listing',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowlisted');
  });

  it('runs an allowlisted npm command inside the workspace', async () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: process.cwd(),
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await runKernelCommand(token, {
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      expectedEvidence: 'npm version prints',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim().length).toBeGreaterThan(0);
  });

  it('rejects expired, reused, or differently scoped capability tokens', async () => {
    const createToken = (expiresAt = '2999-01-01T00:00:00.000Z') => createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: process.cwd(),
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt,
    });

    const expired = await runKernelCommand(createToken('2000-01-01T00:00:00.000Z'), {
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      expectedEvidence: 'npm version prints',
    });
    expect(expired.stderr).toContain('expired');

    const mismatched = await runKernelCommand(createToken(), {
      command: 'npm',
      args: ['run', 'lint'],
      cwd: process.cwd(),
      expectedEvidence: 'lint passes',
    });
    expect(mismatched.stderr).toContain('capability token');

    const singleUseToken = createToken();
    expect((await runKernelCommand(singleUseToken, {
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      expectedEvidence: 'npm version prints',
    })).exitCode).toBe(0);
    const reused = await runKernelCommand(singleUseToken, {
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      expectedEvidence: 'npm version prints',
    });
    expect(reused.stderr).toContain('exhausted');
  });

  it('does not pass secret-bearing environment variables to npm scripts', async () => {
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"process.stdout.write(process.env.KERNEL_WORKER_SECRET || 'filtered')\"" },
    }), 'utf8');
    process.env.KERNEL_WORKER_SECRET = 'must-not-leak';
    try {
      const token = createCapabilityToken({
        family: 'command.run',
        goalId: 'goal_1',
        taskId: 'task_1',
        workspaceRoot: tempDir,
        command: 'npm',
        args: ['test'],
        cwd: tempDir,
        riskLevel: 'L1',
        maxOperations: 1,
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const result = await runKernelCommand(token, {
        command: 'npm',
        args: ['test'],
        cwd: tempDir,
        expectedEvidence: 'test output',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filtered');
      expect(result.stdout).not.toContain('must-not-leak');
    } finally {
      delete process.env.KERNEL_WORKER_SECRET;
    }
  });

  it('strips every desktop launch variable and every nonce-bearing name from worker environments', async () => {
    const names = [
      'DESKTOP_IPC_BASE_URL',
      'DESKTOP_APP_ALLOWLIST',
      'DESKTOP_READY_FILE',
      'DESKTOP_RUNTIME_OWNER_NONCE',
      'PROVENANCE_RUNTIME_DIR',
      'KERNEL_RUNTIME_NONCE_VALUE',
      'COMMAND_WORKER_VISIBLE_VALUE',
    ] as const;
    const original = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `value-for-${name}`;

    try {
      const run = vi.fn(async (spec: { env: NodeJS.ProcessEnv }) => {
        expect(spec.env.DESKTOP_IPC_BASE_URL).toBeUndefined();
        expect(spec.env.DESKTOP_APP_ALLOWLIST).toBeUndefined();
        expect(spec.env.DESKTOP_READY_FILE).toBeUndefined();
        expect(spec.env.DESKTOP_RUNTIME_OWNER_NONCE).toBeUndefined();
        expect(spec.env.PROVENANCE_RUNTIME_DIR).toBeUndefined();
        expect(spec.env.KERNEL_RUNTIME_NONCE_VALUE).toBeUndefined();
        expect(spec.env.COMMAND_WORKER_VISIBLE_VALUE).toBe('value-for-COMMAND_WORKER_VISIBLE_VALUE');
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      });
      const token = createCapabilityToken({
        family: 'command.run',
        goalId: 'goal_1',
        taskId: 'task_1',
        workspaceRoot: tempDir,
        command: 'npm',
        args: ['--version'],
        cwd: tempDir,
        riskLevel: 'L1',
        maxOperations: 1,
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const result = await runKernelCommand(token, {
        command: 'npm',
        args: ['--version'],
        cwd: tempDir,
        expectedEvidence: 'npm version prints',
      }, {
        sandbox: {
          mode: 'host',
          isolation: 'test',
          run,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('fails closed before consuming a capability when command execution is disabled', async () => {
    const run = vi.fn(async () => ({ stdout: 'should not run', stderr: '', exitCode: 0 }));
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: tempDir,
      command: 'npm',
      args: ['--version'],
      cwd: tempDir,
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await runKernelCommand(token, {
      command: 'npm',
      args: ['--version'],
      cwd: tempDir,
      expectedEvidence: 'npm version prints',
    }, {
      sandbox: {
        mode: 'disabled',
        isolation: 'native desktop mode requires healthy Docker isolation',
        run,
      },
    });

    expect(result).toMatchObject({
      summary: 'Command execution is unavailable.',
      exitCode: 126,
      stderr: expect.stringContaining('requires healthy Docker isolation'),
    });
    expect(run).not.toHaveBeenCalled();
    expect(token.usedOperations).toBe(0);
  });
});
