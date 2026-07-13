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
    expect(isAgentFramework('cartographer')).toBe(true);
    expect(isAgentFramework('vellum')).toBe(false);
    expect(isAgentFramework('unknown')).toBe(false);
  });

  it('validates provider label arrays without accepting client secrets', () => {
    const browserSecretField = `api${'Key'}`;
    const provider: AgentProviderConfig = {
      provider: 'gemini',
      modelName: 'gemini-3.5-flash',
      isEnabled: true,
      credentialMode: 'server_env',
    };

    expect(isAgentProviderConfigArray([provider])).toBe(true);
    expect(isAgentProviderConfigArray([{ ...provider, credentialMode: 'browser_secret' }])).toBe(false);
    expect(isAgentProviderConfigArray([{ provider: 'gemini', modelName: 'gemini-3.5-flash', isEnabled: true }])).toBe(false);
    expect(isAgentProviderConfigArray([{ ...provider, [browserSecretField]: 'sk-client-secret' }])).toBe(false);
  });

  it('writes JSON to storage', () => {
    writeJsonToStorage('key', { value: 1 });
    expect(localStorage.getItem('key')).toBe('{"value":1}');
  });
});
