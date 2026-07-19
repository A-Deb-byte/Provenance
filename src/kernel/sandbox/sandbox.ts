import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SandboxRunSpec {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxRunner {
  readonly mode: 'docker' | 'host' | 'disabled';
  /** Human-readable description of the isolation actually provided. */
  readonly isolation: string;
  run(spec: SandboxRunSpec): Promise<SandboxRunResult>;
}

/**
 * Minimal exec surface so both sandboxes can be tested with an injected fake.
 * Mirrors child_process.execFile's promisified result and error shape.
 */
export type SandboxExec = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number; windowsHide: boolean; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const asString = (value: string | Buffer | undefined): string => (
  typeof value === 'string' ? value : value ? value.toString('utf8') : ''
);

const normalizeExecError = (error: unknown): SandboxRunResult => {
  const commandError = error as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return {
    stdout: asString(commandError.stdout),
    stderr: asString(commandError.stderr) || commandError.message || 'Command failed.',
    exitCode: typeof commandError.code === 'number' ? commandError.code : 1,
  };
};

const resolveHostExecutable = (command: string, args: string[]): { file: string; args: string[] } => {
  if (process.platform === 'win32' && command === 'npm') {
    const npmCliPath = process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath)
      ? process.env.npm_execpath
      : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { file: process.execPath, args: [npmCliPath, ...args] };
  }
  return { file: command, args };
};

/**
 * Runs the command directly on the trusted host. This is the honest default
 * when no container runtime is available: it provides NO OS isolation, only
 * the allowlist and capability-token bounds enforced by the caller.
 */
export const createHostSandbox = (exec: SandboxExec = execFileAsync as unknown as SandboxExec): SandboxRunner => ({
  mode: 'host',
  isolation: 'none (runs on the trusted host; bounded only by the command allowlist and capability tokens)',
  run: async (spec) => {
    const executable = resolveHostExecutable(spec.command, spec.args);
    try {
      const result = await exec(executable.file, executable.args, {
        cwd: spec.cwd,
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: spec.maxBuffer,
        env: spec.env,
      });
      return { stdout: asString(result.stdout), stderr: asString(result.stderr), exitCode: 0 };
    } catch (error) {
      return normalizeExecError(error);
    }
  },
});

/**
 * A deliberate fail-closed runner. Server policy selects this in native
 * desktop mode when no approved isolation boundary is healthy.
 */
export const createDisabledSandbox = (reason: string): SandboxRunner => ({
  mode: 'disabled',
  isolation: reason,
  run: async () => ({
    stdout: '',
    stderr: `Command execution is disabled: ${reason}`,
    exitCode: 126,
  }),
});

export interface DockerSandboxConfig {
  /** Path or name of the docker executable (e.g. 'docker' or a full path). */
  dockerPath: string;
  image: string;
  memory: string;
  pidsLimit: number;
  cpus: string;
  containerWorkdir: string;
}

export const DEFAULT_DOCKER_SANDBOX_CONFIG: DockerSandboxConfig = {
  dockerPath: 'docker',
  image: 'node:20-alpine',
  // 2 GB fits the project's tsc/vite verification commands; 512m OOMs tsc.
  memory: '2g',
  pidsLimit: 512,
  cpus: '2',
  containerWorkdir: '/workspace',
};

/**
 * Docker Desktop for Windows accepts a Windows path in `-v`, but the WSL2
 * backend is happiest with the `//c/Users/...` form. Convert on win32; leave
 * POSIX paths untouched.
 */
const toDockerMountSource = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const winMatch = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!winMatch) return resolved;
  const drive = winMatch[1].toLowerCase();
  const rest = winMatch[2].replace(/\\/g, '/');
  return `//${drive}/${rest}`;
};

/**
 * The docker CLI shells out to sibling credential helpers (e.g.
 * docker-credential-desktop) that live in its own directory. When docker is
 * invoked by absolute path, that directory may be absent from PATH, so prepend
 * it for the child process.
 */
const dockerEnv = (dockerPath: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  if (!path.isAbsolute(dockerPath)) return env;
  const binDir = path.dirname(dockerPath);
  const currentPath = env.PATH ?? env.Path ?? '';
  return { ...env, PATH: currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir };
};

/**
 * Builds the argument vector for `docker run`. Pure and deterministic so the
 * exact isolation flags are unit-testable without a Docker daemon.
 *
 * Isolation provided: no network (`--network none`), a read-only root
 * filesystem with a writable tmpfs for /tmp, bounded memory/pids/cpu, and
 * filesystem access limited to the mounted workspace. HOME and the npm cache
 * are redirected into the workspace so tools do not need to write elsewhere.
 */
export const buildDockerRunArgs = (spec: SandboxRunSpec, config: DockerSandboxConfig): string[] => {
  const workdir = config.containerWorkdir;
  return [
    'run', '--rm',
    '--pull', 'never',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec',
    '--memory', config.memory,
    '--memory-swap', config.memory,
    '--pids-limit', String(config.pidsLimit),
    '--cpus', config.cpus,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${toDockerMountSource(spec.cwd)}:${workdir}`,
    '-w', workdir,
    '-e', `HOME=${workdir}`,
    '-e', `npm_config_cache=${workdir}/.npm-cache`,
    config.image,
    spec.command,
    ...spec.args,
  ];
};

const buildDockerHealthArgs = (config: DockerSandboxConfig, workspaceRoot?: string): string[] => {
  if (!workspaceRoot) {
    return [
      'run', '--rm',
      '--pull', 'never',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec',
      '--memory', config.memory,
      '--memory-swap', config.memory,
      '--pids-limit', String(config.pidsLimit),
      '--cpus', config.cpus,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      config.image,
      'node', '--version',
    ];
  }
  const script = [
    "const fs=require('fs')",
    "const cp=require('child_process')",
    "const marker='.provenance-sandbox-health'",
    "try{if(!fs.statSync('package.json').isFile())process.exit(2);fs.writeFileSync(marker,'ok',{flag:'wx'});cp.execFileSync('npm',['--version'],{stdio:'ignore'})}",
    "finally{try{fs.unlinkSync(marker)}catch{}}",
  ].join(';');
  return buildDockerRunArgs({
    command: 'node',
    args: ['-e', script],
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    env: {},
    maxBuffer: 64 * 1024,
  }, config);
};

export const createDockerSandbox = (
  exec: SandboxExec = execFileAsync as unknown as SandboxExec,
  config: DockerSandboxConfig = DEFAULT_DOCKER_SANDBOX_CONFIG,
): SandboxRunner => ({
  mode: 'docker',
  isolation: `docker: no network, read-only root, ${config.memory} memory, ${config.pidsLimit} pids, ${config.cpus} cpu, workspace-only mount`,
  run: async (spec) => {
    try {
      const result = await exec(config.dockerPath, buildDockerRunArgs(spec, config), {
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: spec.maxBuffer,
        env: dockerEnv(config.dockerPath, spec.env),
      });
      return { stdout: asString(result.stdout), stderr: asString(result.stderr), exitCode: 0 };
    } catch (error) {
      return normalizeExecError(error);
    }
  },
});

/**
 * Returns a Docker sandbox when a working Docker daemon is reachable,
 * otherwise undefined. Detection is a real `docker version` probe.
 */
export const detectDockerSandbox = async (
  exec: SandboxExec = execFileAsync as unknown as SandboxExec,
  config: DockerSandboxConfig = DEFAULT_DOCKER_SANDBOX_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
): Promise<SandboxRunner | undefined> => {
  try {
    await exec(config.dockerPath, ['version', '--format', '{{.Server.Version}}'], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: dockerEnv(config.dockerPath, env),
    });
    await exec(config.dockerPath, buildDockerHealthArgs(config, workspaceRoot), {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: dockerEnv(config.dockerPath, env),
    });
    return createDockerSandbox(exec, config);
  } catch {
    return undefined;
  }
};

export type CommandRuntimeMode = 'native-desktop' | 'standalone';

export const isPinnedDockerImage = (value: string): boolean => {
  if (value.length > 456) return false;
  const separator = '@sha256:';
  const separatorIndex = value.lastIndexOf(separator);
  if (separatorIndex <= 0 || value.indexOf(separator) !== separatorIndex) return false;
  const repository = value.slice(0, separatorIndex);
  const digest = value.slice(separatorIndex + separator.length);
  return repository.includes('/')
    && !repository.startsWith('/')
    && !repository.endsWith('/')
    && /^[a-z0-9._:/-]+$/.test(repository)
    && /^[a-f0-9]{64}$/.test(digest);
};

const NATIVE_DESKTOP_MARKERS = [
  'DESKTOP_PACKAGED_RELEASE',
  'DESKTOP_RUNTIME_OWNER_NONCE',
  'DESKTOP_RUNTIME_OWNER_PID',
  'DESKTOP_HOST_NONCE',
  'DESKTOP_HOST_READY_FILE',
] as const;

export const detectCommandRuntimeMode = (env: NodeJS.ProcessEnv): CommandRuntimeMode => (
  NATIVE_DESKTOP_MARKERS.some((name) => Boolean(env[name]?.trim())) ? 'native-desktop' : 'standalone'
);

const defaultDockerPathCandidates = (
  env: NodeJS.ProcessEnv,
  configuredPath: string,
): string[] => {
  if (configuredPath !== DEFAULT_DOCKER_SANDBOX_CONFIG.dockerPath) return [configuredPath];
  if (process.platform !== 'win32') return [configuredPath];

  const windowsRoot = path.parse(env.WINDIR?.trim() || 'C:\\Windows').root || 'C:\\';
  const programFiles = env.ProgramW6432?.trim() || env.ProgramFiles?.trim() || path.join(windowsRoot, 'Program Files');
  return [...new Set([
    configuredPath,
    path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
  ])];
};

export interface CommandSandboxSelection {
  runner: SandboxRunner;
  runtimeMode: CommandRuntimeMode;
  dockerHealthy: boolean;
  trustedHostFallback: boolean;
}

export interface ResolveCommandSandboxOptions {
  env?: NodeJS.ProcessEnv;
  exec?: SandboxExec;
  config?: DockerSandboxConfig;
  workspaceRoot?: string;
}

/**
 * Selects command authority once at startup. Native desktop launches never
 * fall back to the host; standalone launches retain the explicitly reported
 * trusted-host fallback used by development and source checkouts.
 */
export const resolveCommandSandbox = async (
  options: ResolveCommandSandboxOptions = {},
): Promise<CommandSandboxSelection> => {
  const env = options.env ?? process.env;
  const exec = options.exec ?? execFileAsync as unknown as SandboxExec;
  const runtimeMode = detectCommandRuntimeMode(env);
  const baseConfig = options.config ?? DEFAULT_DOCKER_SANDBOX_CONFIG;
  const configuredPath = env.DOCKER_PATH?.trim() || baseConfig.dockerPath;
  const packagedRelease = env.DESKTOP_PACKAGED_RELEASE?.trim() === '1';
  const configuredImage = env.PROVENANCE_SANDBOX_IMAGE?.trim();

  if (packagedRelease && (!configuredImage || !isPinnedDockerImage(configuredImage))) {
    return {
      runner: createDisabledSandbox(
        'packaged desktop mode requires a build-pinned Docker image reference with a sha256 digest',
      ),
      runtimeMode,
      dockerHealthy: false,
      trustedHostFallback: false,
    };
  }
  const config = configuredImage ? { ...baseConfig, image: configuredImage } : baseConfig;

  for (const dockerPath of defaultDockerPathCandidates(env, configuredPath)) {
    const runner = await detectDockerSandbox(
      exec,
      { ...config, dockerPath },
      env,
      options.workspaceRoot,
    );
    if (runner) {
      return { runner, runtimeMode, dockerHealthy: true, trustedHostFallback: false };
    }
  }

  if (runtimeMode === 'native-desktop') {
    return {
      runner: createDisabledSandbox(
        'native desktop mode requires a healthy Docker runtime and the configured image to be present',
      ),
      runtimeMode,
      dockerHealthy: false,
      trustedHostFallback: false,
    };
  }

  return {
    runner: createHostSandbox(exec),
    runtimeMode,
    dockerHealthy: false,
    trustedHostFallback: true,
  };
};

export interface SandboxStatus {
  status: 'available' | 'unavailable';
  mode: 'docker' | 'host' | 'disabled';
  reason: string;
  commandExecution: { status: 'available' | 'unavailable'; reason: string };
}

export const sandboxStatus = (runner: SandboxRunner): SandboxStatus => {
  if (runner.mode === 'docker') {
    return {
      status: 'available',
      mode: 'docker',
      reason: runner.isolation,
      commandExecution: {
        status: 'available',
        reason: 'Allowlisted verification commands execute inside the healthy Docker isolation boundary.',
      },
    };
  }
  if (runner.mode === 'host') {
    return {
      status: 'unavailable',
      mode: 'host',
      reason: `No container runtime detected; ${runner.isolation}.`,
      commandExecution: {
        status: 'available',
        reason: 'Standalone trusted-host fallback is enabled; commands are allowlisted but have no OS isolation.',
      },
    };
  }
  return {
    status: 'unavailable',
    mode: 'disabled',
    reason: runner.isolation,
    commandExecution: {
      status: 'unavailable',
      reason: `Command execution is disabled because ${runner.isolation}.`,
    },
  };
};
