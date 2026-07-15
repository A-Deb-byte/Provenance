import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderExecution } from '../../providers/types';
import type {
  ResearchMission,
  ResearchMissionDraft,
  ResearchMissionSource,
} from '../types';
import {
  buildResearchMissionGoal,
  chunkResearchSource,
  MAX_RESEARCH_SOURCE_CHARS,
  MAX_RESEARCH_SOURCES,
  normalizeResearchMissionInput,
  parseResearchDraft,
  parseResearchPlan,
  renderVerifiedResearchReport,
  type CapturedResearchSource,
  verifyResearchDraft,
} from './research';

const sha256 = (value: string): string => (
  crypto.createHash('sha256').update(value, 'utf8').digest('hex')
);

const providerExecution = (value: unknown, options: { textOnly?: boolean } = {}): ProviderExecution => ({
  plan: {
    mode: 'automatic',
    selections: [{ provider: 'openrouter', model: 'test-model' }],
    reason: 'Test route.',
  },
  results: [{
    requestId: 'request_test',
    provider: 'openrouter',
    model: 'test-model',
    text: JSON.stringify(value),
    structured: options.textOnly ? undefined : value,
    toolCalls: [],
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    finishReason: 'stop',
    latencyMs: 4,
  }],
  errors: [],
  disagreement: false,
});

const capturedSource = (
  id: string,
  rawContent: string,
  overrides: Partial<ResearchMissionSource> = {},
): CapturedResearchSource => {
  const { content, chunks } = chunkResearchSource(id, rawContent);
  const url = `https://${id.toLowerCase()}.example.test/source`;
  return {
    content,
    source: {
      id,
      url,
      origin: new URL(url).origin,
      status: 'captured',
      artifactId: `artifact_${id}`,
      contentHash: sha256(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
      chunks,
      observationId: `observation_${id}`,
      observationRisk: 'none',
      injectionSignalCodes: [],
      evidenceEventId: `event_${id}`,
      capturedAt: '2026-07-14T00:00:00.000Z',
      ...overrides,
    },
  };
};

const groundedDraft = (
  quote: string,
  sourceId = 'S1',
  chunkId = 'S1-C1',
): ResearchMissionDraft => ({
  title: 'Grounded findings',
  executiveSummary: 'The cited findings are summarized below.',
  claims: [{
    id: 'C1',
    statement: 'The source contains the supported finding.',
    confidence: 'medium',
    evidence: [{ sourceId, chunkId, quote }],
  }],
  limitations: ['The report verifies citation grounding, not real-world truth.'],
});

describe('research mission input', () => {
  it('trims the objective and canonicalizes explicit HTTPS URLs', () => {
    expect(normalizeResearchMissionInput({
      objective: '  Compare the supplied evidence.  ',
      sourceUrls: ['https://example.com', 'https://example.org/a?b=1'],
    })).toEqual({
      objective: 'Compare the supplied evidence.',
      sourceUrls: ['https://example.com/', 'https://example.org/a?b=1'],
    });
  });

  it.each([
    ['a non-object input', null],
    ['a blank objective', { objective: ' ', sourceUrls: ['https://example.com'] }],
    ['no sources', { objective: 'Research this', sourceUrls: [] }],
    ['too many sources', {
      objective: 'Research this',
      sourceUrls: Array.from({ length: MAX_RESEARCH_SOURCES + 1 }, (_, index) => `https://s${index}.example.com`),
    }],
    ['an invalid URL', { objective: 'Research this', sourceUrls: ['not a URL'] }],
    ['plain HTTP', { objective: 'Research this', sourceUrls: ['http://example.com'] }],
    ['embedded credentials', { objective: 'Research this', sourceUrls: ['https://user:pass@example.com'] }],
    ['a fragment', { objective: 'Research this', sourceUrls: ['https://example.com/a#section'] }],
    ['canonical duplicates', {
      objective: 'Research this',
      sourceUrls: ['https://example.com', 'https://example.com/'],
    }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeResearchMissionInput(value)).toThrow();
  });
});

describe('research source chunking', () => {
  it('normalizes, bounds, and hashes stable source chunks', () => {
    const raw = `${Array.from({ length: 2_500 }, (_, index) => `word-${index}`).join('  \n ')} trailing`;
    const first = chunkResearchSource('S1', raw);
    const second = chunkResearchSource('S1', raw);

    expect(second).toEqual(first);
    expect(first.content.length).toBeLessThanOrEqual(MAX_RESEARCH_SOURCE_CHARS);
    expect(first.content).not.toMatch(/\s{2,}/);
    expect(first.chunks.length).toBeGreaterThan(1);
    first.chunks.forEach((chunk, index) => {
      expect(chunk.id).toBe(`S1-C${index + 1}`);
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      expect(chunk.charEnd).toBeLessThanOrEqual(first.content.length);
      expect(chunk.contentHash).toBe(sha256(first.content.slice(chunk.charStart, chunk.charEnd)));
      if (index > 0) expect(chunk.charStart).toBeGreaterThanOrEqual(first.chunks[index - 1].charEnd);
    });
  });

  it('returns no chunks for content that normalizes to empty text', () => {
    expect(chunkResearchSource('S1', ' \n\t ')).toEqual({ content: '', chunks: [] });
  });
});

describe('research goal and task graph', () => {
  it('builds a bounded, sequential mission DAG without command authority', () => {
    const now = '2026-07-14T01:02:03.000Z';
    const input = normalizeResearchMissionInput({
      objective: 'Produce a source-backed comparison.',
      sourceUrls: ['https://one.example.test/a', 'https://two.example.test/b'],
    });
    const { goal, tasks, mission } = buildResearchMissionGoal(input, 'C:\\workspace', now);

    expect(goal).toMatchObject({
      id: mission.goalId,
      kind: 'research_report',
      status: 'active',
      autonomyLevel: 'bounded',
      workspaceRoot: 'C:\\workspace',
      verificationCommands: [],
      research: mission,
      createdAt: now,
    });
    expect(goal.budget).toEqual({
      maxOperations: input.sourceUrls.length + 8,
      maxCommandRuntimeMs: 1,
      maxApprovals: 0,
      maxProviderCalls: 8,
    });
    expect(mission).toMatchObject({
      objective: input.objective,
      status: 'planning',
      revision: 1,
      checkpoint: 0,
      synthesisAttempts: 0,
      createdAt: now,
    });
    expect(mission.sources.map(({ id, url, status }) => ({ id, url, status }))).toEqual([
      { id: 'S1', url: input.sourceUrls[0], status: 'pending' },
      { id: 'S2', url: input.sourceUrls[1], status: 'pending' },
    ]);

    expect(tasks.map((item) => item.missionStep)).toEqual([
      'planning', 'collecting', 'synthesizing', 'verifying', 'publish',
    ]);
    expect(tasks.map((item) => item.status)).toEqual(['ready', 'pending', 'pending', 'pending', 'pending']);
    expect(tasks[0].dependsOn).toEqual([]);
    for (let index = 1; index < tasks.length; index += 1) {
      expect(tasks[index].dependsOn).toEqual([tasks[index - 1].id]);
    }
    expect(tasks.every((item) => item.commandRequest === undefined)).toBe(true);
    expect(mission.taskIds).toEqual({
      plan: tasks[0].id,
      collect: tasks[1].id,
      synthesize: tasks[2].id,
      verify: tasks[3].id,
      publish: tasks[4].id,
    });
  });
});

describe('structured provider output parsing', () => {
  const plan = {
    title: 'Evidence plan',
    researchQuestions: ['What does each source establish?'],
    reportOutline: ['Evidence', 'Limitations'],
  };
  const draft = {
    title: 'Evidence report',
    executiveSummary: 'A bounded summary.',
    claims: [{
      id: 'C1',
      statement: 'A supported statement.',
      confidence: 'medium',
      evidence: [{ sourceId: 'S1', chunkId: 'S1-C1', quote: 'a sufficiently specific exact quote' }],
    }],
    limitations: ['Citation grounding is not truth proof.'],
  };

  it('parses schema-valid plan and draft objects, including JSON text fallback', () => {
    expect(parseResearchPlan(providerExecution(plan))).toEqual(plan);
    expect(parseResearchPlan(providerExecution(plan, { textOnly: true }))).toEqual(plan);
    expect(parseResearchDraft(providerExecution(draft))).toEqual(draft);
    expect(parseResearchDraft(providerExecution(draft, { textOnly: true }))).toEqual(draft);
  });

  it('rejects malformed, over-broad, and duplicate structured output', () => {
    expect(() => parseResearchPlan(providerExecution({ ...plan, extra: 'not allowed' }))).toThrow(/schema validation/i);
    expect(() => parseResearchPlan(providerExecution({ ...plan, researchQuestions: [] }))).toThrow(/researchQuestions/i);
    expect(() => parseResearchDraft(providerExecution({ ...draft, claims: [] }))).toThrow(/claims/i);
    expect(() => parseResearchDraft(providerExecution({
      ...draft,
      claims: [draft.claims[0], { ...draft.claims[0] }],
    }))).toThrow(/unique/i);
    expect(() => parseResearchDraft(providerExecution({
      ...draft,
      claims: [{ ...draft.claims[0], evidence: [] }],
    }))).toThrow(/evidence/i);
    expect(() => parseResearchDraft(providerExecution({
      ...draft,
      claims: [{ ...draft.claims[0], id: '### injected heading' }],
    }))).toThrow(/C1-C12/i);
    expect(() => parseResearchDraft(providerExecution({
      ...draft,
      claims: [{
        ...draft.claims[0],
        evidence: [{ ...draft.claims[0].evidence[0], quote: 'common' }],
      }],
    }))).toThrow(/specific excerpt/i);
  });
});

describe('deterministic research grounding', () => {
  it('accepts exact source-bound excerpts and rejects fabricated source, chunk, and quote references', () => {
    const source = capturedSource('S1', 'The exact supported quote appears in this source.');
    expect(verifyResearchDraft(groundedDraft('exact supported quote'), [source])).toEqual([]);

    expect(verifyResearchDraft(groundedDraft('exact supported quote', 'S9', 'S9-C1'), [source]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/unknown or unavailable source S9/i)]));
    expect(verifyResearchDraft(groundedDraft('exact supported quote', 'S1', 'S1-C9'), [source]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/unknown chunk S1-C9/i)]));
    expect(verifyResearchDraft(groundedDraft('fabricated quotation that is not present'), [source]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/not an exact excerpt/i)]));
    expect(verifyResearchDraft(groundedDraft('a'), [source]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/too short or nonspecific/i)]));
  });

  it('rejects quarantined or high-risk evidence', () => {
    const highRisk = capturedSource('S1', 'The exact supported quote appears here.', {
      observationRisk: 'high',
    });
    const issues = verifyResearchDraft(groundedDraft('exact supported quote'), [highRisk]);

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/source S1 is not eligible evidence/i),
      expect.stringMatching(/no valid evidence remains/i),
    ]));
  });

  it('requires high-confidence claims to cite two distinct eligible sources', () => {
    const sourceOne = capturedSource('S1', 'Shared exact evidence is present in the first record.');
    const sourceTwo = capturedSource('S2', 'Shared exact evidence is present in a distinct second record.');
    const oneSource: ResearchMissionDraft = {
      ...groundedDraft('Shared exact evidence'),
      claims: [{ ...groundedDraft('Shared exact evidence').claims[0], confidence: 'high' }],
    };
    expect(verifyResearchDraft(oneSource, [sourceOne])).toEqual(expect.arrayContaining([
      expect.stringMatching(/high confidence requires two captured sources with distinct origins and content hashes/i),
    ]));

    const twoSources: ResearchMissionDraft = {
      ...oneSource,
      claims: [{
        ...oneSource.claims[0],
        evidence: [
          { sourceId: 'S1', chunkId: 'S1-C1', quote: 'Shared exact evidence' },
          { sourceId: 'S2', chunkId: 'S2-C1', quote: 'Shared exact evidence' },
        ],
      }],
    };
    expect(verifyResearchDraft(twoSources, [sourceOne, sourceTwo])).toEqual([]);

    const duplicateContent = capturedSource('S2', sourceOne.content);
    expect(verifyResearchDraft(twoSources, [sourceOne, duplicateContent])).toEqual(expect.arrayContaining([
      expect.stringMatching(/distinct origins and content hashes/i),
    ]));

    const sharedOrigin = capturedSource('S2', sourceTwo.content, { origin: sourceOne.source.origin });
    expect(verifyResearchDraft(twoSources, [sourceOne, sharedOrigin])).toEqual(expect.arrayContaining([
      expect.stringMatching(/distinct origins and content hashes/i),
    ]));
  });

  it('rejects captured content that no longer matches its authenticated source hash', () => {
    const original = capturedSource('S1', `exact supported quote ${'tail '.repeat(1_000)}`);
    const tamperedContent = `${original.content.slice(0, -1)}X`;
    const draft = groundedDraft('exact supported quote', 'S1', original.source.chunks[0].id);

    expect(verifyResearchDraft(draft, [{ ...original, content: tamperedContent }]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/source S1.*content hash/i)]));
  });
});

describe('verified report rendering', () => {
  const verifiedMission = (): ResearchMission => {
    const source = capturedSource('S1', 'The exact supported quote appears here.');
    const { mission } = buildResearchMissionGoal(
      normalizeResearchMissionInput({
        objective: 'Publish a verified report.',
        sourceUrls: [source.source.url],
      }),
      'C:\\workspace',
      '2026-07-14T00:00:00.000Z',
    );
    return {
      ...mission,
      sources: [source.source],
      draft: groundedDraft('exact supported quote'),
      verification: {
        status: 'passed',
        deterministicIssues: [],
        criticVerdict: 'pass',
        criticSummary: 'All grounded claims passed.',
        criticIssues: [],
        verifiedAt: '2026-07-14T00:01:00.000Z',
      },
      providerRuns: [{
        purpose: 'synthesis',
        requestId: 'request_1',
        evidenceEventId: 'event_provider_1',
        provider: 'openrouter',
        model: 'test-model',
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        latencyMs: 20,
        completedAt: '2026-07-14T00:00:30.000Z',
      }],
    };
  };

  it('renders verified claims, exact citations, source hashes, and bounded provenance', () => {
    const mission = verifiedMission();
    const report = renderVerifiedResearchReport(mission);

    expect(report).toContain('# Verified Research Report');
    expect(report).toContain('The source contains the supported finding. [S1]');
    expect(report).toContain('[S1 / S1-C1] "exact supported quote"');
    expect(report).toContain(`SHA-256: ${mission.sources[0].contentHash}`);
    expect(report).toContain('Separate critique pass: pass');
    expect(report).toContain('Total provider tokens: 12');
    expect(report).toContain('not a guarantee of real-world truth');
    expect(report).toContain('Price estimate: unavailable');
  });

  it('refuses to publish missing or failed verification', () => {
    const mission = verifiedMission();
    expect(() => renderVerifiedResearchReport({ ...mission, draft: undefined })).toThrow(/passed research draft/i);
    expect(() => renderVerifiedResearchReport({
      ...mission,
      verification: { ...mission.verification!, status: 'failed' },
    })).toThrow(/passed research draft/i);
  });

  it('does not publish uncited provider prose as part of a verified report', () => {
    const mission = verifiedMission();
    mission.draft = {
      ...mission.draft!,
      executiveSummary: 'UNSUPPORTED EXECUTIVE CLAIM THAT HAS NO CITATION',
    };

    expect(renderVerifiedResearchReport(mission)).not.toContain('UNSUPPORTED EXECUTIVE CLAIM');
  });

  it('escapes dynamic Markdown and HTML in the published artifact', () => {
    const mission = verifiedMission();
    mission.objective = 'Explain <script>alert(1)</script> [click](https://evil.test).';
    mission.draft = {
      ...mission.draft!,
      claims: [{
        ...mission.draft!.claims[0],
        statement: 'Supported text\n## injected ![pixel](https://evil.test/pixel).',
      }],
    };
    mission.sources[0] = {
      ...mission.sources[0],
      url: 'https://s1.example.test/a)[redirect](https://evil.test)',
    };

    const report = renderVerifiedResearchReport(mission);

    expect(report).not.toContain('<script>');
    expect(report).not.toContain('## injected');
    expect(report).not.toContain('![pixel]');
    expect(report).not.toContain('](https://evil.test)');
    expect(report).toContain('&lt;script&gt;');
    expect(report).toContain('\\#\\# injected');
  });
});
