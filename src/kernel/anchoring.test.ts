import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anchorHead,
  appendAnchor,
  buildAnchorRecord,
  readAnchors,
  verifyAgainstAnchors,
  type AnchorPublisher,
} from './anchoring';

let runtimeDir = '';
const NOW = '2026-08-16T12:00:00.000Z';
const hashOf = (seed: string) => seed.repeat(64).slice(0, 64);

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-anchor-'));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

describe('anchor records', () => {
  it('binds its fields so a published anchor cannot be edited afterwards', async () => {
    const record = buildAnchorRecord({
      headHash: hashOf('a'), eventCount: 10, createdAt: NOW, publisher: 'local',
    });
    await appendAnchor(runtimeDir, record);

    const file = path.join(runtimeDir, 'anchors.jsonl');
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.eventCount = 999;
    await writeFile(file, `${JSON.stringify(tampered)}\n`, 'utf8');

    await expect(readAnchors(runtimeDir)).rejects.toThrow('does not match its own record hash');
  });

  it('refuses an anchor covering fewer events than the one before it', async () => {
    // Going backwards is either a truncation or a rewrite; neither should be
    // recorded quietly.
    await appendAnchor(runtimeDir, buildAnchorRecord({
      headHash: hashOf('a'), eventCount: 10, createdAt: NOW, publisher: 'local',
    }));

    await expect(appendAnchor(runtimeDir, buildAnchorRecord({
      headHash: hashOf('b'), eventCount: 9, createdAt: NOW, publisher: 'local',
    }))).rejects.toThrow('fewer events');
  });

  it('rejects malformed anchor files rather than skipping the bad line', async () => {
    await writeFile(path.join(runtimeDir, 'anchors.jsonl'), 'not json\n', 'utf8');
    await expect(readAnchors(runtimeDir)).rejects.toThrow('not valid JSON');

    await writeFile(path.join(runtimeDir, 'anchors.jsonl'), '{"schemaVersion":1}\n', 'utf8');
    await expect(readAnchors(runtimeDir)).rejects.toThrow('malformed');
  });

  it('reads an empty list when nothing has been anchored', async () => {
    expect(await readAnchors(runtimeDir)).toEqual([]);
  });
});

describe('verification against anchors', () => {
  const anchors = [
    buildAnchorRecord({ headHash: hashOf('a'), eventCount: 5, createdAt: NOW, publisher: 'local' }),
    buildAnchorRecord({ headHash: hashOf('b'), eventCount: 12, createdAt: NOW, publisher: 'local' }),
  ];
  const honestChain = (count: number) =>
    count === 5 ? hashOf('a') : count === 12 ? hashOf('b') : undefined;

  it('accepts a chain that still matches every anchor', async () => {
    const verdict = await verifyAgainstAnchors(anchors, 20, honestChain);
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBe(2);
  });

  it('says plainly that local-only anchors are weak evidence', async () => {
    // A local anchor detects a rewrite only if the log survived it, and the
    // report must not let that pass for external witnessing.
    const verdict = await verifyAgainstAnchors(anchors, 20, honestChain);
    expect(verdict.reason).toContain('None is externally witnessed');
  });

  it('reports external witnessing when an anchor carries one', async () => {
    const witnessed = [
      buildAnchorRecord({
        headHash: hashOf('a'), eventCount: 5, createdAt: NOW,
        publisher: 'transparency-log', externalRef: 'entry-42',
      }),
    ];
    const verdict = await verifyAgainstAnchors(witnessed, 20, honestChain);
    expect(verdict.reason).toContain('externally witnessed');
  });

  it('detects a history rewritten from before an anchor', async () => {
    // The rewrite is internally consistent, which is exactly why chaining alone
    // cannot see it.
    const rewritten = (count: number) => count === 5 ? hashOf('c') : honestChain(count);
    const verdict = await verifyAgainstAnchors(anchors, 20, rewritten);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('rewritten');
    expect(verdict.ok === false && verdict.divergedAt?.eventCount).toBe(5);
  });

  it('detects a chain truncated below an anchor', async () => {
    const verdict = await verifyAgainstAnchors(anchors, 8, honestChain);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('truncated');
  });

  it('accepts an unanchored chain but says it checked nothing', async () => {
    const verdict = await verifyAgainstAnchors([], 20, honestChain);
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(verdict.reason).toContain('nothing to check against');
  });
});

describe('publishing', () => {
  it('records the witness reference when a publisher succeeds', async () => {
    const publisher: AnchorPublisher = {
      name: 'transparency-log',
      publish: vi.fn(async () => 'entry-7'),
    };
    const record = await anchorHead(runtimeDir, hashOf('a'), 5, NOW, publisher);

    expect(record.externalRef).toBe('entry-7');
    expect(record.publisher).toBe('transparency-log');
    expect(await readAnchors(runtimeDir)).toHaveLength(1);
  });

  it('still records the head when publication fails, marked unwitnessed', async () => {
    // Dropping the anchor would lose evidence of what the head was; claiming it
    // was witnessed would be false. It is recorded as neither.
    const publisher: AnchorPublisher = {
      name: 'transparency-log',
      publish: vi.fn(async () => { throw new Error('network down'); }),
    };
    const record = await anchorHead(runtimeDir, hashOf('a'), 5, NOW, publisher);

    expect(record.externalRef).toBeUndefined();
    expect(record.publisher).toBe('transparency-log:unwitnessed');
    expect(await readAnchors(runtimeDir)).toHaveLength(1);
  });

  it('records a local anchor when no publisher is configured', async () => {
    const record = await anchorHead(runtimeDir, hashOf('a'), 5, NOW);
    expect(record.publisher).toBe('local');
    expect(record.externalRef).toBeUndefined();
  });
});
