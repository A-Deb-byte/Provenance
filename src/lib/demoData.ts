/**
 * @license
 * SPDX-License-Identifier: BUSL-1.1
 */

import { UserProfile, ChatSession } from '../types';

export const INITIAL_PROFILE: UserProfile = {
  bio: 'No authoritative user profile is configured. Personalization comes only from promoted kernel memory.',
  extractedName: 'Presentation context',
};

export const INITIAL_SESSIONS: ChatSession[] = [
  {
    id: "session_1",
    title: "System Architecture Exploration",
    messages: [
      {
        id: "msg_1",
        role: "user",
        content: "Hi! I want to explore how local memory should be structured for an AI assistant. What should I inspect first?",
        timestamp: new Date(Date.now() - 10 * 60000).toISOString()
      },
      {
        id: "msg_2",
        role: "assistant",
        content: "A practical agent knowledgebase starts with atomic, provenance-aware records. In this cockpit, only promoted kernel memory is used for personalization; the browser conversation is presentation state.",
        timestamp: new Date(Date.now() - 9 * 60000).toISOString(),
      }
    ],
    updatedAt: new Date(Date.now() - 9 * 60000).toISOString()
  }
];

export const EXAMPLE_SUGGESTIONS = [
  "Explain how this local memory dashboard works.",
  "Submit a memory candidate that I prefer inspectable local state.",
  "What does this prototype currently store in the browser?",
  "Let's explore designing an associative retrieval framework."
];
