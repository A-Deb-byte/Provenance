import { describe, expect, it } from 'vitest';
import type { KernelMemoryRecord } from './types';
import {
  createMemoryCandidate,
  createMemoryLedgerPayload,
  hashMemoryContent,
  isMemoryCandidateInput,
  listActiveMemories,
  promoteMemoryRecord,
  revokeMemoryRecord,
} from './memory';

const createdAt = '2026-07-12T00:00:00.000Z';
const later = '2026-07-12T01:00:00.000Z';

const candidateInput = (overrides: Record<string, unknown> = {}) => ({
  kind: 'semantic',
  content: 'The workspace uses TypeScript.',
  confidence: 0.9,
  scope: { kind: 'workspace', id: 'workspace_1' },
  sensitivity: 'internal',
  retention: { kind: 'durable' },
  provenance: {
    sourceType: 'kernel_event',
    sourceId: 'event_1',
    actor: 'kernel',
    observedAt: createdAt,
    excerptHash: 'a'.repeat(64),
  },
  evidenceRefs: [{ eventId: 'event_1', artifactId: 'artifact_1' }],
  contradictionIds: [],
  supersedesIds: [],
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): KernelMemoryRecord => (
  createMemoryCandidate(candidateInput(overrides), createdAt)
);

describe('kernel memory domain', () => {
  it('guards candidate input recursively and enforces scope and retention shapes', () => {
    expect(isMemoryCandidateInput(candidateInput())).toBe(true);
    expect(isMemoryCandidateInput(candidateInput({ confidence: Number.NaN }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({ scope: { kind: 'workspace' } }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({ scope: { kind: 'global', id: 'unexpected' } }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({ retention: { kind: 'until', expiresAt: 'not-a-date' } }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({
      provenance: { ...candidateInput().provenance as object, observedAt: 'not-a-date' },
    }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({ evidenceRefs: [{ eventId: '' }] }))).toBe(false);
    expect(isMemoryCandidateInput(candidateInput({ contradictionIds: ['mem_1', 'mem_1'] }))).toBe(false);
  });

  it('creates a content-addressed candidate and omits raw content from ledger payloads', () => {
    const record = createMemoryCandidate(candidateInput({ content: '  Evidence-backed fact.  ' }), createdAt);

    expect(record.id).toMatch(/^mem_/);
    expect(record.status).toBe('candidate');
    expect(record.content).toBe('Evidence-backed fact.');
    expect(record.contentHash).toBe(hashMemoryContent('Evidence-backed fact.'));
    expect(record.createdAt).toBe(createdAt);

    const payload = createMemoryLedgerPayload(record);
    expect(payload).not.toHaveProperty('content');
    expect(payload).toMatchObject({ memoryId: record.id, contentHash: record.contentHash, status: 'candidate' });
    expect(JSON.stringify(payload)).not.toContain(record.content);
  });

  it.each(['confidential', 'secret'])('rejects %sensitivity memory at creation', (sensitivity) => {
    expect(() => createMemoryCandidate(candidateInput({ sensitivity }), createdAt)).toThrow(/sensitivity/i);
  });

  it('promotes only candidates with an explicit reason and confirmed evidence', () => {
    const record = candidate();

    expect(() => promoteMemoryRecord([record], record.id, ' ', ['event_1'], later)).toThrow(/reason/i);
    const withoutEvidence = candidate({ evidenceRefs: [] });
    expect(() => promoteMemoryRecord([withoutEvidence], withoutEvidence.id, 'Confirmed.', ['event_1'], later))
      .toThrow(/evidence/i);
    expect(() => promoteMemoryRecord([record], record.id, 'Confirmed.', [], later))
      .toThrow(/independent source-backed evidence/i);

    const { record: promoted, records } = promoteMemoryRecord(
      [record],
      record.id,
      'Confirmed by verification.',
      ['event_1'],
      later,
    );
    expect(promoted.status).toBe('promoted');
    expect(promoted.promotedAt).toBe(later);
    expect(promoted.lifecycleReason).toBe('Confirmed by verification.');
    expect(records[0]).toEqual(promoted);
    expect(() => promoteMemoryRecord([promoted], promoted.id, 'Try twice.', ['event_1'], later)).toThrow(/candidate/i);
  });

  it('blocks unresolved promoted contradictions and resolves explicit supersession', () => {
    const priorCandidate = candidate({ content: 'The project uses JavaScript.' });
    const { record: prior } = promoteMemoryRecord(
      [priorCandidate],
      priorCandidate.id,
      'Previously verified.',
      ['event_1'],
      createdAt,
    );
    const conflicting = candidate({
      content: 'The project uses TypeScript.',
      contradictionIds: [prior.id],
      evidenceRefs: [{ eventId: 'event_2' }],
    });

    expect(() => promoteMemoryRecord([prior, conflicting], conflicting.id, 'New verification.', ['event_2'], later))
      .toThrow(/contradiction/i);

    const replacement = { ...conflicting, supersedesIds: [prior.id] };
    const { records } = promoteMemoryRecord(
      [prior, replacement],
      replacement.id,
      'New verification supersedes the old fact.',
      ['event_2'],
      later,
    );
    expect(records.find((record) => record.id === prior.id)?.status).toBe('superseded');
    expect(records.find((record) => record.id === replacement.id)).toMatchObject({
      status: 'promoted',
      supersedesIds: [prior.id],
    });
  });

  it('detects reciprocal contradictions declared by an existing promoted record', () => {
    const incoming = candidate({ content: 'Incoming fact.', evidenceRefs: [{ eventId: 'event_2' }] });
    const priorCandidate = candidate({
      content: 'Prior fact.',
      contradictionIds: [incoming.id],
    });
    const { record: prior } = promoteMemoryRecord(
      [priorCandidate],
      priorCandidate.id,
      'Prior evidence.',
      ['event_1'],
      createdAt,
    );

    expect(() => promoteMemoryRecord([prior, incoming], incoming.id, 'Incoming evidence.', ['event_2'], later))
      .toThrow(/contradiction/i);
  });

  it('revokes without deletion and lists only non-revoked, non-superseded, unexpired records', () => {
    const promotedCandidate = candidate();
    const { record: promoted } = promoteMemoryRecord(
      [promotedCandidate],
      promotedCandidate.id,
      'Verified.',
      ['event_1'],
      createdAt,
    );
    const revoked = revokeMemoryRecord([promoted], promoted.id, 'User revoked this fact.', later);
    expect(revoked.records).toHaveLength(1);
    expect(revoked.record).toMatchObject({ status: 'revoked', revokedAt: later, content: promoted.content });

    const draft = candidate({ content: 'Candidate.' });
    const superseded = { ...candidate({ content: 'Old.' }), status: 'superseded' as const };
    const expired = candidate({
      content: 'Expired.',
      retention: { kind: 'until', expiresAt: later },
    });
    const future = candidate({
      content: 'Future.',
      retention: { kind: 'until', expiresAt: '2026-07-12T02:00:00.000Z' },
    });

    expect(listActiveMemories([...revoked.records, draft, superseded, expired, future], later).map((record) => record.id))
      .toEqual([draft.id, future.id]);
  });
});
