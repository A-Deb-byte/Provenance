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
const frameworks = new Set(['cartographer', 'prover', 'archivist', 'sentinel']);
const providerNames = new Set(['gemini', 'openai', 'deepseek', 'openrouter', 'glm', 'aws']);
const credentialModes = new Set(['server_env', 'not_configured']);
const browserSecretField = `api${'Key'}`;

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
    !(browserSecretField in value) &&
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
