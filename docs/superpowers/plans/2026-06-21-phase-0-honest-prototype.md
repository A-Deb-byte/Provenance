# Phase 0 Honest Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current prototype deterministic, honest about its capabilities, and covered by baseline tests before any kernel, desktop, or multi-provider expansion.

**Architecture:** Extract fragile app behavior into small TypeScript helper modules that can be unit tested without rendering the full UI. Keep the React dashboard as the presentation layer, remove unsupported security/autonomy claims, and make generated skills explicit drafts until deterministic validation passes.

**Tech Stack:** React 19, Vite 6, Express 4, TypeScript 5.8, Vitest, Testing Library, jsdom.

---

## Scope Boundary

This plan implements Phase 0 from `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md`.

It does not implement the Rust kernel, desktop automation, provider router, encrypted SQLite, OS vault integration, autonomous core releases, or multi-agent scheduler. Those are separate plans after this prototype becomes honest and testable.

Current repository note: `git rev-parse --is-inside-work-tree` currently returns `fatal: not a git repository`. Commit steps are included because the execution workflow expects them. In this workspace they should be treated as checkpoints unless git is initialized before execution begins.

## File Structure

- Create: `vitest.config.ts`
  - Vitest configuration for jsdom React tests.
- Create: `src/test/setup.ts`
  - Shared test setup for Testing Library and localStorage isolation.
- Modify: `package.json`
  - Add `test`, `test:watch`, and testing dependencies.
- Create: `src/lib/chatSession.ts`
  - Pure chat-tree update helpers used by `App.tsx`.
- Create: `src/lib/chatSession.test.ts`
  - Regression tests for the stale session-state bug and branch-link handling.
- Create: `src/lib/persistence.ts`
  - Safe localStorage read/write helpers and runtime guards for app state.
- Create: `src/lib/persistence.test.ts`
  - Tests for corrupt storage, schema fallback, and framework validation.
- Create: `src/lib/skillValidation.ts`
  - Deterministic validation for draft skill snippets.
- Create: `src/lib/skillValidation.test.ts`
  - Tests replacing random sandbox verification.
- Modify: `src/types.ts`
  - Add shared provider, draft-skill, and validation status types.
- Modify: `src/App.tsx`
  - Use pure chat helpers and safe persistence.
- Modify: `src/components/MemoryDashboard.tsx`
  - Remove client-stored API keys, fake accuracy metrics, random verification, and unsupported security wording.
- Modify: `server.ts`
  - Change the self-improvement endpoint into a draft-skill endpoint that returns generated code plus non-proof notes.
- Modify: `src/lib/demoData.ts`
  - Replace personalized demo data with neutral demo data.
- Modify: `README.md`
  - Replace AI Studio boilerplate and overclaims with actual setup, current limits, and Phase 0 verification commands.
- Modify: `.gitignore`
  - Add `.superpowers/` so brainstorming companion files stay local.

---

### Task 1: Add The Test Harness

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`

- [ ] **Step 1: Install test dependencies**

Run:

```powershell
npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Expected: npm exits with code 0 and `package-lock.json` updates.

- [ ] **Step 2: Update package scripts**

Modify the `scripts` block in `package.json` to:

```json
{
  "dev": "tsx server.ts",
  "build": "vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs",
  "start": "node dist/server.cjs",
  "clean": "rm -rf dist server.js",
  "lint": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create Vitest config**

Create `vitest.config.ts`:

```ts
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    css: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

- [ ] **Step 4: Create shared test setup**

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});
```

- [ ] **Step 5: Run the empty test suite**

Run:

```powershell
npm test
```

Expected: Vitest exits with code 1 and reports that no test files were found, or exits with code 0 if the installed Vitest version treats an empty suite as valid. Continue after confirming Vitest starts.

- [ ] **Step 6: Run the type checker**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 7: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add package.json package-lock.json vitest.config.ts src/test/setup.ts
git commit -m "test: add vitest harness"
```

---

### Task 2: Extract Chat Session Updates And Reproduce The Stale-State Bug

**Files:**
- Create: `src/lib/chatSession.ts`
- Create: `src/lib/chatSession.test.ts`

- [ ] **Step 1: Create the failing regression tests**

Create `src/lib/chatSession.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChatSession, Message } from '../types';
import { addAssistantMessageToSession, addUserMessageToSession } from './chatSession';

const baseSession = (): ChatSession => ({
  id: 'session_1',
  title: 'Test Session',
  activeLeafId: 'msg_root',
  updatedAt: '2026-06-21T00:00:00.000Z',
  messages: [
    {
      id: 'msg_root',
      role: 'system',
      content: 'root',
      timestamp: '2026-06-21T00:00:00.000Z',
      parentId: null,
      childrenIds: [],
    },
  ],
});

const userMessage = (): Message => ({
  id: 'msg_user_1',
  role: 'user',
  content: 'hello',
  timestamp: '2026-06-21T00:00:01.000Z',
  parentId: 'msg_root',
  childrenIds: ['msg_agent_1'],
});

const assistantMessage = (): Message => ({
  id: 'msg_agent_1',
  role: 'assistant',
  content: 'hi back',
  timestamp: '2026-06-21T00:00:02.000Z',
  parentId: 'msg_user_1',
  childrenIds: [],
});

describe('chat session updates', () => {
  it('keeps the optimistic user message when the assistant response is appended', () => {
    const afterUser = addUserMessageToSession(
      [baseSession()],
      'session_1',
      'msg_root',
      userMessage(),
      '2026-06-21T00:00:01.000Z',
    );

    const afterAssistant = addAssistantMessageToSession(
      afterUser,
      'session_1',
      'msg_user_1',
      assistantMessage(),
      '2026-06-21T00:00:02.000Z',
    );

    expect(afterAssistant[0].messages.map((message) => message.id)).toEqual([
      'msg_root',
      'msg_user_1',
      'msg_agent_1',
    ]);
    expect(afterAssistant[0].activeLeafId).toBe('msg_agent_1');
  });

  it('links the parent to a new branch without removing existing children', () => {
    const session = baseSession();
    session.messages[0].childrenIds = ['msg_existing_child'];

    const afterUser = addUserMessageToSession(
      [session],
      'session_1',
      'msg_root',
      userMessage(),
      '2026-06-21T00:00:01.000Z',
    );

    expect(afterUser[0].messages[0].childrenIds).toEqual(['msg_existing_child', 'msg_user_1']);
  });
});
```

- [ ] **Step 2: Run the failing regression tests**

Run:

```powershell
npx vitest run src/lib/chatSession.test.ts
```

Expected: FAIL because `src/lib/chatSession.ts` does not exist.

- [ ] **Step 3: Create pure chat session helpers**

Create `src/lib/chatSession.ts`:

```ts
import { ChatSession, Message } from '../types';

const appendUnique = (ids: string[] | undefined, id: string): string[] => {
  const current = ids || [];
  return current.includes(id) ? current : [...current, id];
};

export const addUserMessageToSession = (
  sessions: ChatSession[],
  sessionId: string,
  parentId: string | null,
  userMessage: Message,
  updatedAt: string,
): ChatSession[] => {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;

    const messagesWithParentLink = session.messages.map((message) => {
      if (message.id !== parentId) return message;
      return {
        ...message,
        childrenIds: appendUnique(message.childrenIds, userMessage.id),
      };
    });

    return {
      ...session,
      messages: [...messagesWithParentLink, userMessage],
      activeLeafId: userMessage.id,
      updatedAt,
    };
  });
};

export const addAssistantMessageToSession = (
  sessions: ChatSession[],
  sessionId: string,
  userMessageId: string,
  assistantMessage: Message,
  updatedAt: string,
): ChatSession[] => {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;

    const userExists = session.messages.some((message) => message.id === userMessageId);
    if (!userExists) return session;

    const messagesWithUserLink = session.messages.map((message) => {
      if (message.id !== userMessageId) return message;
      return {
        ...message,
        childrenIds: appendUnique(message.childrenIds, assistantMessage.id),
      };
    });

    return {
      ...session,
      messages: [...messagesWithUserLink, assistantMessage],
      activeLeafId: assistantMessage.id,
      updatedAt,
    };
  });
};
```

- [ ] **Step 4: Run the chat helper tests**

Run:

```powershell
npx vitest run src/lib/chatSession.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the type checker**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 6: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/lib/chatSession.ts src/lib/chatSession.test.ts
git commit -m "test: cover chat session updates"
```

---

### Task 3: Use Chat Helpers In The App

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the helper import**

In `src/App.tsx`, add this import after the `demoData` import:

```ts
import { addAssistantMessageToSession, addUserMessageToSession } from './lib/chatSession';
```

- [ ] **Step 2: Replace the optimistic user-session update**

Replace the current `updatedMessagesWithParentsList`, `updatedSessions`, and `setSessions(updatedSessions)` block inside `handleSendMessage` with:

```ts
    const optimisticUpdatedAt = new Date().toISOString();

    setSessions((previousSessions) =>
      addUserMessageToSession(
        previousSessions,
        activeSession.id,
        determineParentId,
        userMsg,
        optimisticUpdatedAt,
      ),
    );
```

- [ ] **Step 3: Replace the assistant-session update**

Replace the current `finalSessions` block and `setSessions(finalSessions)` call inside the successful chat response branch with:

```ts
      const assistantUpdatedAt = new Date().toISOString();

      setSessions((previousSessions) =>
        addAssistantMessageToSession(
          previousSessions,
          activeSession.id,
          userMsgId,
          assistantMsg,
          assistantUpdatedAt,
        ),
      );
```

- [ ] **Step 4: Remove the stale local variable references**

Delete references to `updatedMessagesWithParentsList`, `updatedSessions`, and `finalSessions` from `handleSendMessage`.

- [ ] **Step 5: Run chat helper tests**

Run:

```powershell
npx vitest run src/lib/chatSession.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run app verification**

Run:

```powershell
npm run lint
npm run build
```

Expected: both commands exit with code 0.

- [ ] **Step 7: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/App.tsx src/lib/chatSession.ts src/lib/chatSession.test.ts
git commit -m "fix: preserve chat messages across async responses"
```

---

### Task 4: Add Safe Local Persistence

**Files:**
- Create: `src/lib/persistence.ts`
- Create: `src/lib/persistence.test.ts`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/MemoryDashboard.tsx`

- [ ] **Step 1: Add provider and framework types**

In `src/types.ts`, add these shared types above `MemoryItem`:

```ts
export type AgentFramework = 'vellum' | 'hermes' | 'perplexity' | 'zeroclaw';

export type ProviderName = 'gemini' | 'openai' | 'deepseek' | 'openrouter' | 'glm' | 'aws';
```

Replace `AgentProviderConfig` with:

```ts
export interface AgentProviderConfig {
  provider: ProviderName;
  modelName: string;
  endpointUrl?: string;
  isEnabled: boolean;
  credentialMode: 'server_env' | 'not_configured';
}
```

- [ ] **Step 2: Create persistence tests**

Create `src/lib/persistence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AgentProviderConfig, ChatSession, MemoryItem, UserProfile } from '../types';
import {
  isAgentFramework,
  isAgentProviderConfigArray,
  isChatSessionArray,
  isMemoryItemArray,
  isUserProfile,
  readJsonFromStorage,
  writeJsonToStorage,
} from './persistence';

describe('persistence guards', () => {
  it('falls back when stored JSON is corrupt', () => {
    localStorage.setItem('broken', '{bad json');
    const value = readJsonFromStorage('broken', ['fallback'], Array.isArray);
    expect(value).toEqual(['fallback']);
  });

  it('validates chat session arrays', () => {
    const session: ChatSession = {
      id: 'session_1',
      title: 'Session',
      messages: [],
      activeLeafId: 'msg_1',
      updatedAt: '2026-06-21T00:00:00.000Z',
    };

    expect(isChatSessionArray([session])).toBe(true);
    expect(isChatSessionArray([{ id: 'bad' }])).toBe(false);
  });

  it('validates memory arrays', () => {
    const memory: MemoryItem = {
      id: 'mem_1',
      content: 'Prefers local-first software',
      category: 'preferences',
      source: 'manual',
      createdAt: '2026-06-21T00:00:00.000Z',
      importance: 5,
    };

    expect(isMemoryItemArray([memory])).toBe(true);
    expect(isMemoryItemArray([{ ...memory, importance: 6 }])).toBe(false);
  });

  it('validates user profiles and frameworks', () => {
    const profile: UserProfile = {
      bio: 'Local demo user',
      extractedName: 'Demo',
      lastSummaryUpdate: '2026-06-21T00:00:00.000Z',
    };

    expect(isUserProfile(profile)).toBe(true);
    expect(isUserProfile({ bio: 42 })).toBe(false);
    expect(isAgentFramework('vellum')).toBe(true);
    expect(isAgentFramework('unknown')).toBe(false);
  });

  it('validates provider label arrays without accepting client secrets', () => {
    const provider: AgentProviderConfig = {
      provider: 'gemini',
      modelName: 'gemini-3.5-flash',
      isEnabled: true,
      credentialMode: 'server_env',
    };

    expect(isAgentProviderConfigArray([provider])).toBe(true);
    expect(isAgentProviderConfigArray([{ ...provider, credentialMode: 'browser_secret' }])).toBe(false);
    expect(isAgentProviderConfigArray([{ ...provider, apiKey: 'sk-client-secret' }])).toBe(false);
  });

  it('writes JSON to storage', () => {
    writeJsonToStorage('key', { value: 1 });
    expect(localStorage.getItem('key')).toBe('{"value":1}');
  });
});
```

- [ ] **Step 3: Run the failing persistence tests**

Run:

```powershell
npx vitest run src/lib/persistence.test.ts
```

Expected: FAIL because `src/lib/persistence.ts` does not exist.

- [ ] **Step 4: Create persistence helpers**

Create `src/lib/persistence.ts`:

```ts
import { AgentFramework, AgentProviderConfig, ChatSession, MemoryItem, ProviderName, UserProfile } from '../types';

export const STORAGE_KEYS = {
  sessions: 'agent_kb_sessions_v2',
  memories: 'agent_kb_memories_v2',
  profile: 'agent_kb_profile_v2',
  activeSessionId: 'agent_kb_active_sid_v2',
  framework: 'agent_kb_framework',
  skills: 'agent_autonomous_skills',
  providers: 'agent_provider_labels_v1',
  skillDrafts: 'agent_skill_draft_activities',
} as const;

const memoryCategories = new Set(['personal', 'technical', 'work', 'preferences', 'general']);
const frameworks = new Set(['vellum', 'hermes', 'perplexity', 'zeroclaw']);
const providerNames = new Set(['gemini', 'openai', 'deepseek', 'openrouter', 'glm', 'aws']);
const credentialModes = new Set(['server_env', 'not_configured']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
};

export const isAgentFramework = (value: unknown): value is AgentFramework => {
  return typeof value === 'string' && frameworks.has(value);
};

export const isProviderName = (value: unknown): value is ProviderName => {
  return typeof value === 'string' && providerNames.has(value);
};

export const isMemoryItem = (value: unknown): value is MemoryItem => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.content === 'string' &&
    typeof value.source === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.importance === 'number' &&
    value.importance >= 1 &&
    value.importance <= 5 &&
    typeof value.category === 'string' &&
    memoryCategories.has(value.category)
  );
};

export const isMemoryItemArray = (value: unknown): value is MemoryItem[] => {
  return Array.isArray(value) && value.every(isMemoryItem);
};

export const isUserProfile = (value: unknown): value is UserProfile => {
  if (!isRecord(value)) return false;
  return (
    typeof value.bio === 'string' &&
    (value.extractedName === undefined || typeof value.extractedName === 'string') &&
    (value.lastSummaryUpdate === undefined || typeof value.lastSummaryUpdate === 'string')
  );
};

export const isMessage = (value: unknown): value is ChatSession['messages'][number] => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'string' &&
    (value.parentId === undefined || value.parentId === null || typeof value.parentId === 'string') &&
    (value.childrenIds === undefined || isStringArray(value.childrenIds))
  );
};

export const isChatSession = (value: unknown): value is ChatSession => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    (value.activeLeafId === undefined || typeof value.activeLeafId === 'string') &&
    typeof value.updatedAt === 'string'
  );
};

export const isChatSessionArray = (value: unknown): value is ChatSession[] => {
  return Array.isArray(value) && value.every(isChatSession);
};

export const isAgentProviderConfig = (value: unknown): value is AgentProviderConfig => {
  if (!isRecord(value)) return false;
  return (
    isProviderName(value.provider) &&
    typeof value.modelName === 'string' &&
    typeof value.isEnabled === 'boolean' &&
    typeof value.credentialMode === 'string' &&
    credentialModes.has(value.credentialMode) &&
    !('apiKey' in value) &&
    (value.endpointUrl === undefined || typeof value.endpointUrl === 'string')
  );
};

export const isAgentProviderConfigArray = (value: unknown): value is AgentProviderConfig[] => {
  return Array.isArray(value) && value.every(isAgentProviderConfig);
};

export const readJsonFromStorage = <T>(
  key: string,
  fallback: T,
  guard: (value: unknown) => value is T,
): T => {
  const stored = localStorage.getItem(key);
  if (!stored) return fallback;

  try {
    const parsed: unknown = JSON.parse(stored);
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export const writeJsonToStorage = (key: string, value: unknown): void => {
  localStorage.setItem(key, JSON.stringify(value));
};

export const readStringFromStorage = (key: string, fallback: string): string => {
  const stored = localStorage.getItem(key);
  return stored || fallback;
};
```

- [ ] **Step 5: Run persistence tests**

Run:

```powershell
npx vitest run src/lib/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Use safe persistence in App**

In `src/App.tsx`, add this import:

```ts
import {
  isAgentFramework,
  isChatSessionArray,
  isMemoryItemArray,
  isUserProfile,
  readJsonFromStorage,
  readStringFromStorage,
  STORAGE_KEYS,
  writeJsonToStorage,
} from './lib/persistence';
```

Replace the session, memory, profile, active session id, and framework state initializers with:

```ts
  const defaultSessions = () => {
    return INITIAL_SESSIONS.map(s => {
      const activeLeaf = s.messages[s.messages.length - 1]?.id || '';
      const mappedMsgs = s.messages.map((m, idx) => ({
        ...m,
        parentId: idx > 0 ? s.messages[idx - 1].id : null,
        childrenIds: idx < s.messages.length - 1 ? [s.messages[idx + 1].id] : []
      }));
      return {
        ...s,
        messages: mappedMsgs,
        activeLeafId: activeLeaf
      };
    });
  };

  const [sessions, setSessions] = useState<ChatSession[]>(() =>
    readJsonFromStorage(STORAGE_KEYS.sessions, defaultSessions(), isChatSessionArray)
  );

  const [memories, setMemories] = useState<MemoryItem[]>(() =>
    readJsonFromStorage(STORAGE_KEYS.memories, INITIAL_MEMORIES, isMemoryItemArray)
  );

  const [profile, setProfile] = useState<UserProfile>(() =>
    readJsonFromStorage(STORAGE_KEYS.profile, INITIAL_PROFILE, isUserProfile)
  );

  const [activeSessionId, setActiveSessionId] = useState<string>(() =>
    readStringFromStorage(STORAGE_KEYS.activeSessionId, sessions[0]?.id || '')
  );

  const [agentFramework, setAgentFramework] = useState<AgentFramework>(() =>
    readJsonFromStorage(STORAGE_KEYS.framework, 'vellum', isAgentFramework)
  );
```

Replace the persistence effects with:

```ts
  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.sessions, sessions);
  }, [sessions]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.memories, memories);
  }, [memories]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.profile, profile);
  }, [profile]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.framework, agentFramework);
  }, [agentFramework]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
  }, [activeSessionId]);
```

- [ ] **Step 7: Update imports and prop types**

In `src/App.tsx`, change:

```ts
import { MemoryItem, UserProfile, ChatSession, Message, ResearchMutation } from './types';
```

to:

```ts
import { AgentFramework, MemoryItem, UserProfile, ChatSession, Message, ResearchMutation } from './types';
```

In `src/components/MemoryDashboard.tsx`, change:

```ts
import { MemoryItem, UserProfile, AgentSkill, AgentProviderConfig, ImprovementActivity } from '../types';
```

to:

```ts
import { AgentFramework, MemoryItem, UserProfile, AgentSkill, AgentProviderConfig, ImprovementActivity } from '../types';
```

Then replace the prop type fragments:

```ts
  agentFramework: 'vellum' | 'hermes' | 'perplexity' | 'zeroclaw';
  onSetAgentFramework: (framework: 'vellum' | 'hermes' | 'perplexity' | 'zeroclaw') => void;
```

with:

```ts
  agentFramework: AgentFramework;
  onSetAgentFramework: (framework: AgentFramework) => void;
```

- [ ] **Step 8: Run verification**

Run:

```powershell
npx vitest run src/lib/persistence.test.ts
npm run lint
```

Expected: both commands exit with code 0.

- [ ] **Step 9: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/types.ts src/App.tsx src/components/MemoryDashboard.tsx src/lib/persistence.ts src/lib/persistence.test.ts
git commit -m "feat: add guarded local persistence"
```

---

### Task 5: Replace Random Skill Verification With Deterministic Draft Validation

**Files:**
- Create: `src/lib/skillValidation.ts`
- Create: `src/lib/skillValidation.test.ts`
- Modify: `src/types.ts`
- Modify: `src/components/MemoryDashboard.tsx`

- [ ] **Step 1: Update skill-related types**

In `src/types.ts`, add:

```ts
export type SkillValidationStatus = 'untested' | 'passed' | 'failed';

export interface SkillValidationResult {
  status: SkillValidationStatus;
  messages: string[];
}
```

Change `AgentSkill.lastRunStatus` to:

```ts
  lastRunStatus: SkillValidationStatus;
```

- [ ] **Step 2: Create deterministic validation tests**

Create `src/lib/skillValidation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AgentSkill } from '../types';
import { validateSkillSnippet, withValidationResult } from './skillValidation';

const skill = (codeSnippet: string): AgentSkill => ({
  id: 'skill_1',
  name: 'ExampleSkill',
  description: 'Example deterministic skill',
  codeSnippet,
  capabilities: ['Example capability'],
  successCount: 0,
  failureCount: 0,
  lastRunStatus: 'untested',
  createdAt: '2026-06-21T00:00:00.000Z',
});

describe('skill validation', () => {
  it('passes when a snippet exports an execute function and contains no forbidden dynamic evaluation', () => {
    const result = validateSkillSnippet(skill('export function execute(input) { return input; }'));
    expect(result.status).toBe('passed');
    expect(result.messages).toEqual(['Found exported execute function.']);
  });

  it('fails when the execute function is missing', () => {
    const result = validateSkillSnippet(skill('export const value = 1;'));
    expect(result.status).toBe('failed');
    expect(result.messages).toContain('Missing exported execute function.');
  });

  it('fails when a snippet uses dynamic evaluation or network access', () => {
    const result = validateSkillSnippet(skill('export function execute() { return eval("1 + 1"); }'));
    expect(result.status).toBe('failed');
    expect(result.messages).toContain('Contains blocked token: eval(');
  });

  it('records deterministic validation counters', () => {
    const updated = withValidationResult(skill('export const value = 1;'));
    expect(updated.lastRunStatus).toBe('failed');
    expect(updated.failureCount).toBe(1);
    expect(updated.successCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run the failing validation tests**

Run:

```powershell
npx vitest run src/lib/skillValidation.test.ts
```

Expected: FAIL because `src/lib/skillValidation.ts` does not exist.

- [ ] **Step 4: Create deterministic skill validation helpers**

Create `src/lib/skillValidation.ts`:

```ts
import { AgentSkill, SkillValidationResult } from '../types';

const blockedTokens = ['eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'localStorage', 'document.cookie'];

export const validateSkillSnippet = (skill: Pick<AgentSkill, 'codeSnippet'>): SkillValidationResult => {
  const messages: string[] = [];
  const code = skill.codeSnippet;

  if (!/export\s+function\s+execute\s*\(/.test(code)) {
    messages.push('Missing exported execute function.');
  } else {
    messages.push('Found exported execute function.');
  }

  for (const token of blockedTokens) {
    if (code.includes(token)) {
      messages.push(`Contains blocked token: ${token}`);
    }
  }

  const hasFailure = messages.some((message) =>
    message.startsWith('Missing') || message.startsWith('Contains blocked token'),
  );

  return {
    status: hasFailure ? 'failed' : 'passed',
    messages,
  };
};

export const withValidationResult = (skill: AgentSkill): AgentSkill => {
  const result = validateSkillSnippet(skill);

  return {
    ...skill,
    successCount: result.status === 'passed' ? skill.successCount + 1 : skill.successCount,
    failureCount: result.status === 'failed' ? skill.failureCount + 1 : skill.failureCount,
    lastRunStatus: result.status,
  };
};
```

- [ ] **Step 5: Run validation tests**

Run:

```powershell
npx vitest run src/lib/skillValidation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Replace random local skill test in MemoryDashboard**

In `src/components/MemoryDashboard.tsx`, add:

```ts
import { withValidationResult } from '../lib/skillValidation';
```

Replace `executeLocalSkillTest` with:

```ts
  const executeLocalSkillTest = async (skill: AgentSkill) => {
    if (isExecutingLocalTest) return;
    setIsExecutingLocalTest(true);

    await new Promise(r => setTimeout(r, 300));

    setAutonomousSkills(prev =>
      prev.map(s => (s.id === skill.id ? withValidationResult(s) : s))
    );

    setIsExecutingLocalTest(false);
  };
```

Replace the default skill statuses:

```ts
        lastRunStatus: 'success',
```

with:

```ts
        lastRunStatus: 'passed',
```

Replace the status label:

```tsx
Status: Sandbox Stable (Acc: {activeSkill.lastRunStatus.toUpperCase()})
```

with:

```tsx
Status: Draft Validation {activeSkill.lastRunStatus.toUpperCase()}
```

- [ ] **Step 7: Run verification**

Run:

```powershell
npx vitest run src/lib/skillValidation.test.ts
npm run lint
```

Expected: both commands exit with code 0.

- [ ] **Step 8: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/types.ts src/lib/skillValidation.ts src/lib/skillValidation.test.ts src/components/MemoryDashboard.tsx
git commit -m "fix: make skill validation deterministic"
```

---

### Task 6: Make Provider And Skill Draft UI Honest

**Files:**
- Modify: `src/types.ts`
- Modify: `src/components/MemoryDashboard.tsx`
- Modify: `server.ts`

- [ ] **Step 1: Replace improvement activity type with skill draft activity**

In `src/types.ts`, replace `ImprovementActivity` with:

```ts
export interface SkillDraftActivity {
  id: string;
  taskTitle: string;
  deficitIdentified: string;
  synthesizedSkillName: string;
  executionStatus: 'drafted' | 'validation_failed';
  draftNotes: string[];
  verificationStatus: 'draft_unverified' | 'deterministic_validation_passed' | 'deterministic_validation_failed';
  timestamp: string;
}
```

In `src/components/MemoryDashboard.tsx`, change:

```ts
import { AgentFramework, MemoryItem, UserProfile, AgentSkill, AgentProviderConfig, ImprovementActivity } from '../types';
```

to:

```ts
import { AgentFramework, MemoryItem, UserProfile, AgentSkill, AgentProviderConfig, ProviderName, SkillDraftActivity } from '../types';
```

- [ ] **Step 2: Replace provider defaults**

In `MemoryDashboard.tsx`, replace the provider default array with:

```ts
  const defaultProviders: AgentProviderConfig[] = [
      { provider: 'gemini', modelName: 'gemini-3.5-flash', isEnabled: true, credentialMode: 'server_env' },
      { provider: 'openai', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
      { provider: 'deepseek', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
      { provider: 'openrouter', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
      { provider: 'glm', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
      { provider: 'aws', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' }
    ];

  const [providers, setProviders] = useState<AgentProviderConfig[]>(() =>
    readJsonFromStorage(STORAGE_KEYS.providers, defaultProviders, isAgentProviderConfigArray)
  );
```

Replace the selected provider state with:

```ts
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>('gemini');
```

Add these imports from persistence:

```ts
import {
  isAgentProviderConfigArray,
  readJsonFromStorage,
  STORAGE_KEYS,
  writeJsonToStorage,
} from '../lib/persistence';
```

Replace provider persistence with:

```ts
  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.providers, providers);
  }, [providers]);
```

- [ ] **Step 3: Remove client-side API key storage**

Delete `handleUpdateProviderKey`.

Replace the credential input block:

```tsx
                {selectedProvider !== 'gemini' && (
                  <div>
                    <label className="block text-[8px] font-mono text-slate-500 mb-0.5 uppercase font-bold">Secure Access API Token (Required):</label>
                    <input
                      type="password"
                      value={providers.find(p => p.provider === selectedProvider)?.apiKey || ''}
                      onChange={(e) => handleUpdateProviderKey(selectedProvider, e.target.value)}
                      className="w-full text-xs font-mono bg-[#0B0C0E] text-[#2DD4BF] border border-slate-850 rounded px-2 py-1 focus:outline-none focus:border-amber-500"
                      placeholder="sk-..."
                    />
                  </div>
                )}
```

with:

```tsx
                <div className="bg-[#0B0C0E]/60 border border-slate-850 rounded-lg px-2 py-1.5">
                  <div className="text-[8px] font-mono text-slate-500 uppercase font-bold">Credential Source</div>
                  <div className="text-[10px] font-mono text-slate-300 mt-0.5">
                    {providers.find(p => p.provider === selectedProvider)?.credentialMode === 'server_env'
                      ? 'Server environment variable'
                      : 'Not connected in this prototype'}
                  </div>
                </div>
```

- [ ] **Step 4: Rename improvement logs to skill draft logs**

Replace:

```ts
  const [improvementLogs, setImprovementLogs] = useState<ImprovementActivity[]>(() => {
    const saved = localStorage.getItem('agent_improvement_activities');
    return saved ? JSON.parse(saved) : [];
  });
```

with:

```ts
  const isSkillDraftActivityArray = (value: unknown): value is SkillDraftActivity[] => {
    return Array.isArray(value) && value.every((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record.id === 'string' &&
        typeof record.taskTitle === 'string' &&
        typeof record.deficitIdentified === 'string' &&
        typeof record.synthesizedSkillName === 'string' &&
        (record.executionStatus === 'drafted' || record.executionStatus === 'validation_failed') &&
        Array.isArray(record.draftNotes) &&
        record.draftNotes.every((note) => typeof note === 'string') &&
        (
          record.verificationStatus === 'draft_unverified' ||
          record.verificationStatus === 'deterministic_validation_passed' ||
          record.verificationStatus === 'deterministic_validation_failed'
        ) &&
        typeof record.timestamp === 'string'
      );
    });
  };

  const [skillDraftLogs, setSkillDraftLogs] = useState<SkillDraftActivity[]>(() => {
    return readJsonFromStorage(STORAGE_KEYS.skillDrafts, [], isSkillDraftActivityArray);
  });
```

Replace the persistence effect:

```ts
  useEffect(() => {
    localStorage.setItem('agent_improvement_activities', JSON.stringify(improvementLogs));
  }, [improvementLogs]);
```

with:

```ts
  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.skillDrafts, skillDraftLogs);
  }, [skillDraftLogs]);
```

- [ ] **Step 5: Remove accuracy trend data**

Replace `skillTrendData` with:

```ts
  const skillDraftTrendData = skillDraftLogs.map((log, index) => ({
    label: `Draft #${index + 1}`,
    validation: log.verificationStatus === 'deterministic_validation_passed' ? 1 : 0,
    skillsCount: autonomousSkills.length,
  }));
```

Remove rendered wording that says "accuracy score increments" and replace the chart caption with:

```tsx
                  Draft validation history. A value of 1 means deterministic local validation passed.
```

Replace the chart references:

```tsx
{improvementLogs.length > 0 && (
```

with:

```tsx
{skillDraftLogs.length > 0 && (
```

Replace:

```tsx
data={skillTrendData}
```

with:

```tsx
data={skillDraftTrendData}
```

Replace:

```tsx
dataKey="accuracy"
```

with:

```tsx
dataKey="validation"
```

Replace:

```tsx
domain={[60, 100]}
```

with:

```tsx
domain={[0, 1]}
```

- [ ] **Step 6: Replace generated self-improvement success messages**

Inside `executeSelfImprovementLoop`, replace the boot logs with:

```ts
    const bootLogs = [
      `[DRAFT_INIT]: Requesting a candidate skill draft from the server-side Gemini adapter.`,
      `[ROUTER]: Active provider label - ${selectedProvider.toUpperCase()} (${providers.find(p=>p.provider===selectedProvider)?.modelName || 'not-configured'})`,
      `[SKILL_GAP]: Draft requested for: "${targetImprovementTask}"`,
      `[VALIDATION_POLICY]: Generated code will remain a draft until deterministic local validation passes.`
    ];
```

Replace the response handling from `const result = await response.json();` through `setTargetImprovementTask('');` with:

```ts
      const result = await response.json();

      const newSkill: AgentSkill = {
        id: `skill_${Date.now()}`,
        name: result.synthesizedSkillName,
        description: result.synthesizedSkillDescription,
        codeSnippet: result.codeSnippet,
        capabilities: result.capabilities,
        successCount: 0,
        failureCount: 0,
        lastRunStatus: 'untested',
        createdAt: new Date().toISOString()
      };

      const validationPreview = withValidationResult(newSkill);

      for (const note of result.draftNotes) {
        await new Promise(r => setTimeout(r, 200));
        setCurrentTerminalLogs(prev => [...prev, `[DRAFT_NOTE]: ${note}`]);
      }

      setCurrentTerminalLogs(prev => [
        ...prev,
        `[DRAFT_READY]: Candidate skill stored as a local draft.`,
        `[VALIDATION]: Deterministic validation status: ${validationPreview.lastRunStatus.toUpperCase()}`
      ]);

      setAutonomousSkills(prev => [validationPreview, ...prev]);
      setSelectedSkillId(validationPreview.id);

      const newLog: SkillDraftActivity = {
        id: `draft_${Date.now()}`,
        taskTitle: targetImprovementTask,
        deficitIdentified: result.deficitIdentified,
        synthesizedSkillName: result.synthesizedSkillName,
        executionStatus: validationPreview.lastRunStatus === 'failed' ? 'validation_failed' : 'drafted',
        draftNotes: result.draftNotes,
        verificationStatus: validationPreview.lastRunStatus === 'passed'
          ? 'deterministic_validation_passed'
          : 'deterministic_validation_failed',
        timestamp: new Date().toISOString()
      };

      setSkillDraftLogs(prev => [newLog, ...prev]);

      onAddMemory(
        `Drafted local skill candidate: ${result.synthesizedSkillName}. Validation status: ${newLog.verificationStatus}.`,
        'technical',
        3
      );

      setTargetImprovementTask('');
```

- [ ] **Step 7: Rename UI copy for autonomy and security**

Replace the autonomous intro paragraph with:

```tsx
                Draft candidate skills from the server-side Gemini adapter and validate them locally with deterministic checks. This prototype does not update its own core, does not store provider secrets in the browser, and does not treat generated logs as proof of success.
```

Replace `"Secure Client Sandbox"` with:

```tsx
Server-side credentials only
```

Replace button text `"Compile"` with:

```tsx
Draft
```

Replace `"AUTONOMOUS TERMINAL CONSOLE"` with:

```tsx
SKILL DRAFT CONSOLE
```

- [ ] **Step 8: Update server endpoint response contract**

In `server.ts`, replace the `/api/self-improve` endpoint comment with:

```ts
// API Endpoint: /api/self-improve
// Drafts a candidate skill. The response is not proof that the skill works.
```

Inside the self-improvement endpoint, replace instruction items 3 through 6 with:

```ts
3. Provide a concise list of draft notes that explain assumptions, risks, and how the code should be tested.
4. Do not claim that code was compiled, executed, installed, or verified.
5. Return your output strictly adhering to the requested JSON schema.
```

Replace the response schema fields:

```ts
            terminalLogs: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Dense, prestigious step-by-step logs simulating self-improvement [DIAGNOSING], [SYNTHESIZING], [COMPILING], [LINTING], [UNIT-TEST-1], [MUTATING-CORRECTION], [ALL-PASS].'
            },
            accuracyScore: { type: Type.INTEGER, description: 'A rigorous benchmark score representing mathematical confidence, from 85 to 100.' }
```

with:

```ts
            draftNotes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Concise notes describing assumptions, risks, and suggested deterministic tests.'
            }
```

Replace the required fields array with:

```ts
          required: ['deficitIdentified', 'synthesizedSkillName', 'synthesizedSkillDescription', 'codeSnippet', 'capabilities', 'draftNotes']
```

- [ ] **Step 9: Run targeted scans**

Run:

```powershell
rg -n "accuracyScore|Math\\.random|apiKey|Secure Access API Token|AES-256|AES_GCM|CORE_UPDATE|verified benchmark|updates its core|self-update" src server.ts
```

Expected: no matches in `src` or `server.ts`.

- [ ] **Step 10: Run verification**

Run:

```powershell
npx vitest run src/lib/skillValidation.test.ts
npm run lint
npm run build
```

Expected: all commands exit with code 0.

- [ ] **Step 11: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/types.ts src/components/MemoryDashboard.tsx server.ts
git commit -m "fix: make skill drafting honest"
```

---

### Task 7: Make Demo Data And App Labels Honest

**Files:**
- Modify: `src/lib/demoData.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/MemoryDashboard.tsx`

- [ ] **Step 1: Replace personalized demo profile**

In `src/lib/demoData.ts`, replace `INITIAL_PROFILE` with:

```ts
export const INITIAL_PROFILE: UserProfile = {
  bio: "Local demo profile. Add real facts manually or through chat extraction before relying on personalization.",
  extractedName: "Demo User",
  lastSummaryUpdate: new Date().toISOString()
};
```

- [ ] **Step 2: Replace demo memories**

Replace `INITIAL_MEMORIES` with:

```ts
export const INITIAL_MEMORIES: MemoryItem[] = [
  {
    id: "mem_1",
    content: "Prefers local-first software with inspectable state",
    category: "preferences",
    source: "Demo Knowledgebase Entry",
    createdAt: new Date(Date.now() - 4 * 3600000).toISOString(),
    importance: 5
  },
  {
    id: "mem_2",
    content: "Evaluates agents by verified task completion, recovery, and evidence quality",
    category: "technical",
    source: "Demo Knowledgebase Entry",
    createdAt: new Date(Date.now() - 3.5 * 3600000).toISOString(),
    importance: 5
  },
  {
    id: "mem_3",
    content: "Wants security claims to match the actual storage and runtime model",
    category: "preferences",
    source: "Demo Knowledgebase Entry",
    createdAt: new Date(Date.now() - 2.5 * 3600000).toISOString(),
    importance: 4
  }
];
```

- [ ] **Step 3: Replace footer security text in App**

In `src/App.tsx`, replace:

```tsx
                  AES-256 Memory Lock
```

with:

```tsx
                  Browser local storage
```

Replace:

```tsx
                <span>Dual graph extraction active</span>
```

with:

```tsx
                <span>Gemini extraction when server key is configured</span>
```

- [ ] **Step 4: Replace dashboard security badges**

In `src/components/MemoryDashboard.tsx`, replace:

```tsx
AES-256 SYNCED
```

with:

```tsx
LOCAL STORAGE
```

Replace:

```tsx
v2.1.0-stable • AES_GCM
```

with:

```tsx
phase-0 prototype • local state
```

- [ ] **Step 5: Run claim scan**

Run:

```powershell
rg -n "AES|encrypted|secure|stable|verified benchmark|updates its core|self-update|self-improving|surpasses|surpass" src README.md server.ts
```

Expected: no unsupported claims remain in user-facing UI or README. Mentions in the design spec are allowed because the spec describes future architecture.

- [ ] **Step 6: Run verification**

Run:

```powershell
npm run lint
npm run build
```

Expected: both commands exit with code 0.

- [ ] **Step 7: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add src/lib/demoData.ts src/App.tsx src/components/MemoryDashboard.tsx
git commit -m "fix: align prototype labels with actual behavior"
```

---

### Task 8: Update Documentation And Ignore Local Brainstorming Artifacts

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Update `.gitignore`**

Add this line to `.gitignore`:

```gitignore
.superpowers/
```

- [ ] **Step 2: Replace README**

Replace `README.md` with:

```md
# Agent Memory Knowledgebase

A local-first prototype for an agent memory dashboard and chat workspace.

## Current Status

This is a Phase 0 prototype. It demonstrates:

- Local browser persistence for chat sessions, memories, profile summary, provider labels, and draft skills.
- Gemini-backed chat, extraction, mutation, and skill-draft endpoints when `GEMINI_API_KEY` is configured on the server.
- A memory dashboard for manual memory editing and inspection.
- Branchable chat sessions.
- Deterministic draft-skill validation checks.

It does not yet provide:

- Encrypted local database storage.
- OS secret vault integration.
- A trusted local kernel.
- Desktop automation.
- Real multi-provider execution.
- Autonomous core updates.
- Verified skill installation.

## Setup

Install dependencies:

```bash
npm ci
```

Create `.env` from `.env.example` and set:

```bash
GEMINI_API_KEY="your_server_side_key"
```

Run development server:

```bash
npm run dev
```

Build production assets:

```bash
npm run build
```

Run the compiled server:

```bash
npm start
```

## Verification

Run type checking:

```bash
npm run lint
```

Run tests:

```bash
npm test
```

Run a production build:

```bash
npm run build
```

## Architecture Direction

The approved target design is documented in:

- `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md`

Phase 0 keeps the current UI honest and testable. Later phases introduce the trusted kernel, evidence ledger, capability tokens, provider router, skill foundry, and desktop/browser automation.
```

- [ ] **Step 3: Run documentation claim scan**

Run:

```powershell
rg -n "AES|encrypted|secure|stable|verified benchmark|updates its core|self-update|self-improving|surpasses|surpass" README.md src server.ts
```

Expected: no unsupported claims remain.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm test
npm run lint
npm run build
```

Expected: all commands exit with code 0.

- [ ] **Step 5: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git add README.md .gitignore
git commit -m "docs: document phase 0 prototype limits"
```

---

## Final Verification Gate

- [ ] Run unit tests:

```powershell
npm test
```

Expected: all tests pass.

- [ ] Run type checking:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] Run production build:

```powershell
npm run build
```

Expected: exit code 0. The existing Vite chunk-size warning is acceptable for Phase 0 unless the build fails.

- [ ] Run unsupported-claim scan:

```powershell
rg -n "AES|encrypted|secure|stable|verified benchmark|updates its core|self-update|self-improving|surpasses|surpass|Math\\.random|accuracyScore|apiKey|CORE_UPDATE" src server.ts README.md
```

Expected: no matches.

- [ ] Run repo-state check:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`. If git has been initialized, run:

```powershell
git status --short
```

Expected with git initialized: only the planned Phase 0 files are changed.

## Handoff Criteria

Phase 0 is complete when:

- Chat responses no longer drop the optimistic user message.
- Corrupt localStorage cannot crash app initialization.
- The UI no longer claims AES encryption, client-side secure key storage, verified benchmarks, or core self-updates.
- Provider credentials are not stored in browser state.
- Skill drafting is labeled as drafting, and local validation is deterministic.
- README describes the actual prototype and its limits.
- `npm test`, `npm run lint`, and `npm run build` all pass.
