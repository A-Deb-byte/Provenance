import { describe, expect, it, vi } from 'vitest';
import {
  buildDockerRunArgs,
  createDockerSandbox,
  createHostSandbox,
  DEFAULT_DOCKER_SANDBOX_CONFIG,
  detectDockerSandbox,
  sandboxStatus,
  SandboxExec,
  SandboxRunSpec,
} from './sandbox';

const spec = (over: Partial<SandboxRunSpec> = {}): SandboxRunSpec => ({
  command: 'npm',
  args: ['run', 'lint'],
  cwd: process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj',
  timeoutMs: 30000,
  maxBuffer: 256 * 1024,
  env: {},
  ...over,
});

describe('buildDockerRunArgs', () => {
  it('applies the isolation flags and mounts only the workspace', () => {
    const args = buildDockerRunArgs(spec(), DEFAULT_DOCKER_SANDBOX_CONFIG);
    const joined = args.join(' ');

    expect(args[0]).toBe('run');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--memory 2g');
    expect(joined).toContain('--pids-limit 512');
    expect(joined).toContain('--cpus 2');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain(':/workspace');
    // The image, then the logical command and args, unresolved.
    expect(args.slice(-4)).toEqual(['node:20-alpine', 'npm', 'run', 'lint']);
  });
});

describe('host sandbox', () => {
  it('reports no isolation and returns exit 0 on success', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '' })) as unknown as SandboxExec;
    const host = createHostSandbox(exec);
    expect(host.mode).toBe('host');
    expect(sandboxStatus(host).status).toBe('unavailable');

    const result = await host.run(spec());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('maps a failed command to its exit code and stderr', async () => {
    const exec = vi.fn(async () => {
      throw { code: 2, stdout: 'partial', stderr: 'boom' };
    }) as unknown as SandboxExec;
    const result = await createHostSandbox(exec).run(spec());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('boom');
  });
});

describe('docker sandbox', () => {
  it('invokes the docker CLI with the run args and reports available', async () => {
    const exec = vi.fn(async () => ({ stdout: 'lint ok', stderr: '' })) as unknown as SandboxExec;
    const docker = createDockerSandbox(exec);
    expect(sandboxStatus(docker).status).toBe('available');

    const result = await docker.run(spec());
    expect(result.exitCode).toBe(0);
    const [file, args] = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe('docker');
    expect(args[0]).toBe('run');
  });
});

describe('detectDockerSandbox', () => {
  it('returns a docker sandbox when the version probe succeeds', async () => {
    const exec = vi.fn(async () => ({ stdout: '24.0.0', stderr: '' })) as unknown as SandboxExec;
    const runner = await detectDockerSandbox(exec);
    expect(runner?.mode).toBe('docker');
  });

  it('returns undefined when docker is not present', async () => {
    const exec = vi.fn(async () => {
      throw new Error('docker: command not found');
    }) as unknown as SandboxExec;
    expect(await detectDockerSandbox(exec)).toBeUndefined();
  });
});
