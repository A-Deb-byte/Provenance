import { describe, expect, it, vi } from 'vitest';
import {
  buildDockerRunArgs,
  createDisabledSandbox,
  createDockerSandbox,
  createHostSandbox,
  DEFAULT_DOCKER_SANDBOX_CONFIG,
  detectCommandRuntimeMode,
  detectDockerSandbox,
  isPinnedDockerImage,
  resolveCommandSandbox,
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
    expect(joined).toContain('--pull never');
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
    expect(sandboxStatus(host).commandExecution).toMatchObject({
      status: 'available',
      reason: expect.stringContaining('trusted-host fallback'),
    });

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

describe('disabled sandbox', () => {
  it('fails closed without invoking an executable', async () => {
    const disabled = createDisabledSandbox('healthy Docker isolation is required');

    expect(sandboxStatus(disabled)).toMatchObject({
      status: 'unavailable',
      mode: 'disabled',
      commandExecution: { status: 'unavailable' },
    });
    await expect(disabled.run(spec())).resolves.toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining('healthy Docker isolation is required'),
    });
  });
});

describe('docker sandbox', () => {
  it('invokes the docker CLI with the run args and reports available', async () => {
    const exec = vi.fn(async () => ({ stdout: 'lint ok', stderr: '' })) as unknown as SandboxExec;
    const docker = createDockerSandbox(exec);
    expect(sandboxStatus(docker).status).toBe('available');
    expect(sandboxStatus(docker).commandExecution.status).toBe('available');

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
    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(calls[1][1]).toEqual(expect.arrayContaining([
      'run', '--pull', 'never', '--network', 'none', '--read-only',
    ]));
  });

  it('rejects a reachable daemon when the isolated container health probe fails', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'version') return { stdout: '24.0.0', stderr: '' };
      throw new Error('configured image is unavailable');
    }) as unknown as SandboxExec;
    expect(await detectDockerSandbox(exec)).toBeUndefined();
  });

  it('returns undefined when docker is not present', async () => {
    const exec = vi.fn(async () => {
      throw new Error('docker: command not found');
    }) as unknown as SandboxExec;
    expect(await detectDockerSandbox(exec)).toBeUndefined();
  });
});

describe('command sandbox policy', () => {
  it('accepts only digest-pinned image references for packaged releases', () => {
    expect(isPinnedDockerImage(`registry.example.test/provenance/node@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isPinnedDockerImage('node:20-alpine')).toBe(false);
    expect(isPinnedDockerImage(`node:20-alpine@sha256:${'z'.repeat(64)}`)).toBe(false);
    expect(isPinnedDockerImage(`Registry.example.test/provenance/node@sha256:${'a'.repeat(64)}`)).toBe(false);
    expect(isPinnedDockerImage(`registry.example.test/provenance/node/@sha256:${'a'.repeat(64)}`)).toBe(false);
  });

  it('classifies any native ownership marker as native desktop mode', () => {
    expect(detectCommandRuntimeMode({ NODE_ENV: 'production' })).toBe('standalone');
    expect(detectCommandRuntimeMode({ DESKTOP_PACKAGED_RELEASE: '1' })).toBe('native-desktop');
    expect(detectCommandRuntimeMode({ DESKTOP_RUNTIME_OWNER_PID: '1234' })).toBe('native-desktop');
    expect(detectCommandRuntimeMode({ DESKTOP_HOST_READY_FILE: 'ready.json' })).toBe('native-desktop');
  });

  it('uses Docker after both daemon and isolated-container probes pass', async () => {
    const exec = vi.fn(async () => ({ stdout: 'healthy', stderr: '' })) as unknown as SandboxExec;
    const selection = await resolveCommandSandbox({
      env: { DESKTOP_RUNTIME_OWNER_NONCE: 'n'.repeat(48), DOCKER_PATH: 'fixed-docker' },
      exec,
    });

    expect(selection).toMatchObject({
      runtimeMode: 'native-desktop',
      dockerHealthy: true,
      trustedHostFallback: false,
    });
    expect(selection.runner.mode).toBe('docker');
    expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('fixed-docker');
  });

  it('disables native desktop commands when Docker is unhealthy', async () => {
    const exec = vi.fn(async () => { throw new Error('Docker unavailable'); }) as unknown as SandboxExec;
    const selection = await resolveCommandSandbox({
      env: { DESKTOP_RUNTIME_OWNER_NONCE: 'n'.repeat(48), DOCKER_PATH: 'fixed-docker' },
      exec,
    });

    expect(selection).toMatchObject({
      runtimeMode: 'native-desktop',
      dockerHealthy: false,
      trustedHostFallback: false,
    });
    expect(selection.runner.mode).toBe('disabled');
    expect(sandboxStatus(selection.runner).commandExecution.status).toBe('unavailable');
  });

  it('rejects a packaged desktop release without a digest-pinned image before probing Docker', async () => {
    const exec = vi.fn(async () => ({ stdout: 'healthy', stderr: '' })) as unknown as SandboxExec;
    const selection = await resolveCommandSandbox({
      env: {
        DESKTOP_PACKAGED_RELEASE: '1',
        DESKTOP_RUNTIME_OWNER_NONCE: 'n'.repeat(48),
        PROVENANCE_SANDBOX_IMAGE: 'node:20-alpine',
        DOCKER_PATH: 'fixed-docker',
      },
      exec,
    });

    expect(selection.runner.mode).toBe('disabled');
    expect(selection.dockerHealthy).toBe(false);
    expect((exec as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(sandboxStatus(selection.runner).commandExecution.reason).toContain('build-pinned');
  });

  it('probes and runs the exact build-pinned image in packaged desktop mode', async () => {
    const image = `registry.example.test/provenance/node@sha256:${'b'.repeat(64)}`;
    const exec = vi.fn(async () => ({ stdout: 'healthy', stderr: '' })) as unknown as SandboxExec;
    const selection = await resolveCommandSandbox({
      env: {
        DESKTOP_PACKAGED_RELEASE: '1',
        DESKTOP_RUNTIME_OWNER_NONCE: 'n'.repeat(48),
        PROVENANCE_SANDBOX_IMAGE: image,
        DOCKER_PATH: 'fixed-docker',
      },
      exec,
      workspaceRoot: 'C:\\projects\\provenance',
    });

    expect(selection.runner.mode).toBe('docker');
    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][1]).toContain(image);
    expect(calls[1][1]).toContain('//c/projects/provenance:/workspace');
    expect(calls[1][1].join(' ')).toContain("statSync('package.json')");
    expect(calls[1][1].join(' ')).toContain("execFileSync('npm'");
  });

  it('retains and explicitly reports the standalone trusted-host fallback', async () => {
    const exec = vi.fn(async () => { throw new Error('Docker unavailable'); }) as unknown as SandboxExec;
    const selection = await resolveCommandSandbox({
      env: { NODE_ENV: 'development', DOCKER_PATH: 'fixed-docker' },
      exec,
    });

    expect(selection).toMatchObject({
      runtimeMode: 'standalone',
      dockerHealthy: false,
      trustedHostFallback: true,
    });
    expect(selection.runner.mode).toBe('host');
    expect(sandboxStatus(selection.runner).commandExecution).toMatchObject({
      status: 'available',
      reason: expect.stringContaining('trusted-host fallback'),
    });
  });
});
