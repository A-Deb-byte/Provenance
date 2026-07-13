/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MemoryItem, UserProfile, ChatSession } from '../types';

export const INITIAL_PROFILE: UserProfile = {
  bio: "Local demo profile. Add real facts manually or through chat extraction before relying on personalization.",
  extractedName: "Demo User",
  lastSummaryUpdate: new Date().toISOString()
};

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
        content: "A practical agent knowledgebase starts with a small profile summary plus atomic memory records. Keep each memory inspectable, timestamped, and editable before relying on it for personalization.",
        timestamp: new Date(Date.now() - 9 * 60000).toISOString(),
        retrievedMemories: [
          {
            id: "mem_1",
            content: "Prefers local-first software with inspectable state",
            category: "preferences",
            source: "Demo Knowledgebase Entry",
            createdAt: new Date().toISOString(),
            importance: 5
          }
        ]
      }
    ],
    updatedAt: new Date(Date.now() - 9 * 60000).toISOString()
  }
];

export const EXAMPLE_SUGGESTIONS = [
  "Explain how this local memory dashboard works.",
  "Add a memory that I prefer inspectable local state.",
  "What does this prototype currently store in the browser?",
  "Let's explore designing an associative retrieval framework."
];
