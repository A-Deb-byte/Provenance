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
