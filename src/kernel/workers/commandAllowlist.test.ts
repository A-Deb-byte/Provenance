import { describe, expect, it } from 'vitest';
import { parseCommandAllowlist } from './commandWorker';

describe('command allowlist configuration', () => {
  it('falls back to the built-in verification set when unset', () => {
    for (const empty of [undefined, null, '']) {
      const list = parseCommandAllowlist(empty);
      expect(list).toHaveLength(4);
      expect(list[0]).toEqual({ command: 'npm', args: ['test'] });
    }
  });

  it('accepts an operator-supplied list of exact invocations', () => {
    const list = parseCommandAllowlist(JSON.stringify([
      { command: 'npm', args: ['run', 'typecheck'] },
      { command: 'cargo', args: ['check'] },
    ]));

    expect(list).toEqual([
      { command: 'npm', args: ['run', 'typecheck'] },
      { command: 'cargo', args: ['check'] },
    ]);
  });

  it('refuses shell metacharacters rather than sanitising them', () => {
    // Sanitising would leave the operator believing they configured something
    // they did not; refusing makes the disagreement visible.
    for (const evil of [
      [{ command: 'sh', args: ['-c', 'rm -rf /'] }],
      [{ command: 'npm', args: ['test;', 'curl', 'evil.test'] }],
      [{ command: 'npm', args: ['run', '$(whoami)'] }],
      [{ command: 'npm', args: ['run', 'build && curl evil.test'] }],
      [{ command: 'npm|tee', args: [] }],
      [{ command: 'npm', args: ['run', '`id`'] }],
    ]) {
      expect(() => parseCommandAllowlist(JSON.stringify(evil))).toThrow(/metacharacters/);
    }
  });

  it('refuses malformed configuration outright', () => {
    expect(() => parseCommandAllowlist('not json')).toThrow(/valid JSON/);
    expect(() => parseCommandAllowlist('[]')).toThrow(/non-empty/);
    expect(() => parseCommandAllowlist('{"command":"npm"}')).toThrow(/non-empty/);
    expect(() => parseCommandAllowlist(JSON.stringify([{ args: ['test'] }]))).toThrow(/requires a command/);
    expect(() => parseCommandAllowlist(JSON.stringify([{ command: 'npm', args: [42] }]))).toThrow(/must be strings/);
    expect(() => parseCommandAllowlist(JSON.stringify(
      Array.from({ length: 65 }, () => ({ command: 'npm', args: ['test'] })),
    ))).toThrow(/64 entries/);
  });

  it('does not do prefix or glob matching', () => {
    // `npm run *` would let anyone who can write package.json choose the payload.
    const list = parseCommandAllowlist(JSON.stringify([{ command: 'npm', args: ['run', 'lint'] }]));
    expect(list[0].args).toEqual(['run', 'lint']);
    expect(() => parseCommandAllowlist(JSON.stringify([{ command: 'npm', args: ['run', '*'] }]))).toThrow();
  });
});
