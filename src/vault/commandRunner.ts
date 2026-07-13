import { spawn } from 'node:child_process';

export interface VaultCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs a CLI, optionally feeding a secret on stdin so it never appears in the
 * argument vector / process listing. Injected in tests so adapter command
 * construction is verifiable without the real OS keychain tools.
 */
export type VaultCommandRunner = (file: string, args: string[], input?: string) => Promise<VaultCommandResult>;

export const spawnVaultRunner: VaultCommandRunner = (file, args, input) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('Vault command timed out.'));
  }, 30_000);
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
});
