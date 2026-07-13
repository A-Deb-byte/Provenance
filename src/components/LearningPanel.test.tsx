import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningPanel } from './LearningPanel';

interface LearningPayloads {
  memories?: unknown[];
  skills?: unknown[];
  evaluations?: unknown[];
}

const mockLearningFetch = ({
  memories = [],
  skills = [],
  evaluations = [],
}: LearningPayloads = {}) => {
  const payloads: Record<string, Record<string, unknown[]>> = {
    '/api/kernel/memories': { memories },
    '/api/kernel/skills': { skills },
    '/api/kernel/skill-evaluations': { evaluations },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => payloads[String(input)],
  } as Response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const memory = (id: string, status: string, content: string, evidenceCount: number) => ({
  id,
  kind: 'semantic',
  status,
  content,
  contentHash: id.padEnd(64, 'a'),
  confidence: 0.9,
  scope: { kind: 'workspace', id: 'workspace_1' },
  sensitivity: 'internal',
  retention: { kind: 'durable' },
  provenance: {
    sourceType: 'kernel_event',
    sourceId: 'event_source',
    actor: 'kernel',
    observedAt: '2026-07-12T00:00:00.000Z',
  },
  evidenceRefs: Array.from({ length: evidenceCount }, (_, index) => ({ eventId: `event_${index}` })),
  contradictionIds: [],
  supersedesIds: [],
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LearningPanel', () => {
  it('renders clear empty states', async () => {
    mockLearningFetch();
    render(<LearningPanel />);

    expect(screen.getByText('Learning Cockpit')).toBeInTheDocument();
    expect(await screen.findByText('No kernel memory records yet.')).toBeInTheDocument();
    expect(screen.getByText('No skill packages yet.')).toBeInTheDocument();
    expect(screen.getByText('No skill evaluations yet.')).toBeInTheDocument();
  });

  it('renders memory lifecycle evidence and skill evaluation scores without execution controls', async () => {
    mockLearningFetch({
      memories: [
        memory('mem_candidate', 'candidate', 'Candidate workspace fact', 1),
        memory('mem_promoted', 'promoted', 'Promoted workspace fact', 2),
        memory('mem_revoked', 'revoked', 'Revoked workspace fact', 0),
      ],
      skills: [{
        id: 'skill_1',
        status: 'canary',
        manifest: { name: 'NormalizeReleaseText', version: '1.0.0', description: 'Normalizes release text.' },
        updatedAt: '2026-07-12T01:00:00.000Z',
      }],
      evaluations: [{
        id: 'eval_1',
        skillId: 'skill_1',
        baselineScore: 0.5,
        candidateScore: 1,
        eligibleForCanary: true,
        createdAt: '2026-07-12T01:00:00.000Z',
      }],
    });

    render(<LearningPanel />);
    expect(screen.getByText('Learning Cockpit')).toBeInTheDocument();
    expect(await screen.findByText('Candidate workspace fact')).toBeInTheDocument();
    expect(screen.getByText('Promoted workspace fact')).toBeInTheDocument();
    expect(screen.getByText('Revoked workspace fact')).toBeInTheDocument();
    expect(screen.getAllByText('candidate')).toHaveLength(1);
    expect(screen.getByText('promoted')).toBeInTheDocument();
    expect(screen.getByText('revoked')).toBeInTheDocument();
    expect(screen.getByText('1 evidence ref')).toBeInTheDocument();
    expect(screen.getByText('2 evidence refs')).toBeInTheDocument();

    const skillCard = screen.getByTestId('skill-skill_1');
    expect(within(skillCard).getByText('NormalizeReleaseText')).toBeInTheDocument();
    expect(within(skillCard).getByText('canary')).toBeInTheDocument();
    expect(within(skillCard).getByText('Baseline 50.0%')).toBeInTheDocument();
    expect(within(skillCard).getByText('Candidate 100.0%')).toBeInTheDocument();
    expect(within(skillCard).queryByRole('button', { name: /invoke|run|execute/i })).not.toBeInTheDocument();
  });

  it('promotes a candidate using an inline reason and updates the rendered lifecycle', async () => {
    const candidate = memory('mem_candidate', 'candidate', 'Candidate workspace fact', 1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/kernel/memories/mem_candidate/promote') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...candidate, status: 'promoted', lifecycleReason: 'Evidence confirmed.' }),
        } as Response;
      }
      const payloads: Record<string, Record<string, unknown[]>> = {
        '/api/kernel/memories': { memories: [candidate] },
        '/api/kernel/skills': { skills: [] },
        '/api/kernel/skill-evaluations': { evaluations: [] },
      };
      return { ok: true, status: 200, json: async () => payloads[url] } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<LearningPanel />);

    const card = await screen.findByTestId('memory-mem_candidate');
    await user.click(within(card).getByRole('button', { name: 'Promote' }));
    expect(within(card).getByLabelText('Promotion reason')).toBeInTheDocument();
    await user.type(within(card).getByLabelText('Promotion reason'), 'Evidence confirmed.');
    await user.click(within(card).getByRole('button', { name: 'Confirm promotion' }));

    expect(await within(card).findByText('promoted')).toBeInTheDocument();
    expect(within(card).queryByLabelText('Promotion reason')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/kernel/memories/mem_candidate/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Evidence confirmed.' }),
    });
  });

  it('shows loading and request failure states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const { unmount } = render(<LearningPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading learning state...');
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response)));
    render(<LearningPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Learning state unavailable');
  });
});
