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
