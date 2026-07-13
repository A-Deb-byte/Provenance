/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type AgentFramework = 'cartographer' | 'prover' | 'archivist' | 'sentinel';

export type ProviderName = 'gemini' | 'openai' | 'deepseek' | 'openrouter' | 'glm' | 'aws';

export interface MemoryItem {
  id: string;
  content: string;
  category: 'personal' | 'technical' | 'work' | 'preferences' | 'general';
  source: string; // "Manual Input" or snippet from conversation: "I live in San Francisco"
  createdAt: string;
  importance: number; // 1-5 scale
}

export interface UserProfile {
  bio: string;
  extractedName?: string;
  lastSummaryUpdate?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  retrievedMemories?: MemoryItem[]; // The memories that were injected as context during this turn
  parentId?: string | null;           // For building branched conversation trees
  childrenIds?: string[];
}

export interface ResearchMutation {
  id: string;
  title: string;
  parentIdeaId: string; // Memory ID or Message ID
  operator: 'heuristic_leap' | 'axiomatic_friction' | 'combinatorial' | 'priority_shock';
  novelInsight: string;
  mathematicalBounds: string;
  suggestedActionItems: string[];
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  activeLeafId?: string; // Tracks which path is currently loaded/active in the tree navigation
  updatedAt: string;
}

export interface LocalKnowledgebase {
  memories: MemoryItem[];
  profile: UserProfile;
}

export type SkillValidationStatus = 'untested' | 'passed' | 'failed';

export interface SkillValidationResult {
  status: SkillValidationStatus;
  messages: string[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  codeSnippet: string;
  capabilities: string[];
  successCount: number;
  failureCount: number;
  lastRunStatus: SkillValidationStatus;
  createdAt: string;
}

export interface AgentProviderConfig {
  provider: ProviderName;
  modelName: string;
  endpointUrl?: string;
  isEnabled: boolean;
  credentialMode: 'server_env' | 'not_configured';
}

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
