/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { AgentFramework, MemoryItem, ChatSession, Message, ResearchMutation } from './types';
import type { KernelMemoryRecord, MemoryKind } from './kernel/types';
import { 
  INITIAL_PROFILE, 
  INITIAL_SESSIONS, 
  EXAMPLE_SUGGESTIONS 
} from './lib/demoData';
import { addAssistantMessageToSession, addUserMessageToSession } from './lib/chatSession';
import {
  isAgentFramework,
  isChatSessionArray,
  readJsonFromStorage,
  readStringFromStorage,
  STORAGE_KEYS,
  purgeLegacyAuthoritativeStorage,
  writeJsonToStorage,
} from './lib/persistence';
import { authenticatedFetch } from './lib/auth';
import MemoryDashboard from './components/MemoryDashboard';
import { AuthPanel } from './components/AuthPanel';
import { KernelPanel } from './components/KernelPanel';
import { LearningPanel } from './components/LearningPanel';
import { ProviderPanel } from './components/ProviderPanel';
import { RuntimePanel } from './components/RuntimePanel';
import { 
  Plus, MessageSquare, Trash2, Database, Brain, Sparkles, 
  ArrowRight, ShieldCheck, HelpCircle, HardDrive, RefreshCw, Send,
  Cpu, AlertCircle, FileText, CheckCircle, GitBranch, GitCommit, GitMerge,
  Zap, Compass, ChevronLeft, ChevronRight, Scale, Beaker, Layers, Network, BookOpen
} from 'lucide-react';

const memoryKindToCategory = (kind: MemoryKind): MemoryItem['category'] => {
  if (kind === 'intent') return 'preferences';
  if (kind === 'episodic') return 'work';
  if (kind === 'procedural' || kind === 'semantic') return 'technical';
  return 'general';
};

const categoryToMemoryKind = (category: unknown): MemoryKind => {
  if (category === 'preferences') return 'intent';
  if (category === 'work') return 'episodic';
  if (category === 'technical') return 'procedural';
  return 'semantic';
};

const sha256Text = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const fetchPromotedKernelMemories = async (): Promise<MemoryItem[]> => {
  const response = await authenticatedFetch('/api/kernel/memories?status=promoted');
  if (!response.ok) throw new Error('Promoted kernel memory is unavailable.');
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { memories?: unknown }).memories)) {
    throw new Error('Kernel memory response is invalid.');
  }
  return (payload as { memories: KernelMemoryRecord[] }).memories.map((memory) => ({
    id: memory.id,
    content: memory.content,
    category: memoryKindToCategory(memory.kind),
    source: `${memory.provenance.sourceType}:${memory.provenance.sourceId}`,
    createdAt: memory.createdAt,
    importance: Math.max(1, Math.min(5, Math.round(memory.confidence * 5))),
  }));
};

export default function App() {
  // Conversation sessions are presentation state. Kernel memory is always read from the server.
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

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const profile = INITIAL_PROFILE;

  const [activeSessionId, setActiveSessionId] = useState<string>(() =>
    readStringFromStorage(STORAGE_KEYS.activeSessionId, sessions[0]?.id || '')
  );

  // UI state variables
  const [inputText, setInputText] = useState('');
  const [isCochatting, setIsCochatting] = useState(false);
  const [isConsolidating, setIsConsolidating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [systemAlert, setSystemAlert] = useState<{message: string; type: 'success' | 'warning' | 'error'} | null>(null);

  // Active agentic framework state
  const [agentFramework, setAgentFramework] = useState<AgentFramework>(() =>
    readJsonFromStorage(STORAGE_KEYS.framework, 'cartographer', isAgentFramework)
  );

  // Active branching / creation state
  const [targetBranchParentId, setTargetBranchParentId] = useState<string | null>(null);

  // Tree vs List toggle view
  const [activePanelTab, setActivePanelTab] = useState<'chat' | 'tree' | 'mutator'>('chat');

  // Mathematical Mutation Workspace States
  const [mutationOperator, setMutationOperator] = useState<'heuristic_leap' | 'axiomatic_friction' | 'combinatorial' | 'priority_shock'>('heuristic_leap');
  const [mutationSourceText, setMutationSourceText] = useState('Explore the convergence profile of non-Lipschitz neural operators mapping infinite-dimensional Hilbert states.');
  const [isMutating, setIsMutating] = useState(false);
  const [activeMutation, setActiveMutation] = useState<ResearchMutation | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    purgeLegacyAuthoritativeStorage();
  }, []);

  useEffect(() => {
    if (activePanelTab === 'chat') {
      scrollToBottom();
    }
  }, [sessions, activeSessionId, activePanelTab]);

  // Persist only local conversation presentation preferences.
  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.sessions, sessions);
  }, [sessions]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.framework, agentFramework);
  }, [agentFramework]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    let disposed = false;
    const loadPromotedMemory = async () => {
      try {
        const promoted = await fetchPromotedKernelMemories();
        if (!disposed) setMemories(promoted);
      } catch {
        if (!disposed) setMemories([]);
      }
    };
    void loadPromotedMemory();
    const interval = window.setInterval(() => void loadPromotedMemory(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  // Retrieve current active session
  const activeSessionIndex = Math.max(0, sessions.findIndex(s => s.id === activeSessionId));
  const activeSession = sessions[activeSessionIndex] || sessions[0];

  // Utility alerts
  const showAlert = (message: string, type: 'success' | 'warning' | 'error' = 'success') => {
    setSystemAlert({ message, type });
    setTimeout(() => {
      setSystemAlert(null);
    }, 4500);
  };

  /**
   * RECONSTRUCT CURRENT CHAT PATH (Linear sequence backtraced from active leaf node to root)
   */
  const getTimelinePath = (): Message[] => {
    if (!activeSession || activeSession.messages.length === 0) return [];
    
    // Find active leaf or locate fallback leaf node
    let leafId = activeSession.activeLeafId;
    let leaf = activeSession.messages.find(m => m.id === leafId);
    
    if (!leaf) {
      // Find a leaf (any message that is not listed as parent of any other message in the session)
      const parentIds = new Set(activeSession.messages.map(m => m.parentId).filter(Boolean));
      const leaves = activeSession.messages.filter(m => !parentIds.has(m.id));
      leaf = leaves[leaves.length - 1] || activeSession.messages[activeSession.messages.length - 1];
    }

    if (!leaf) return [];

    const path: Message[] = [];
    let current: Message | undefined = leaf;
    const visited = new Set<string>();

    while (current && !visited.has(current.id)) {
      path.push(current);
      visited.add(current.id);
      const parentId = current.parentId;
      current = parentId ? activeSession.messages.find(m => m.id === parentId) : undefined;
    }

    return path.reverse();
  };

  const activePath = getTimelinePath();

  /**
   * SIBLING BRANCH DISCOVERY HELPERS
   */
  const getSiblings = (msg: Message): Message[] => {
    if (!activeSession) return [];
    const parentId = msg.parentId;
    return activeSession.messages.filter(m => m.parentId === parentId);
  };

  const changeBranch = (currentMsg: Message, direction: 'prev' | 'next') => {
    if (!activeSession) return;
    const siblings = getSiblings(currentMsg);
    if (siblings.length <= 1) return;

    const currentIndex = siblings.findIndex(s => s.id === currentMsg.id);
    let newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
    
    // Wrap index bound borders
    if (newIndex < 0) newIndex = siblings.length - 1;
    if (newIndex >= siblings.length) newIndex = 0;

    const targetSibling = siblings[newIndex];

    // Find the deep leaf node from targetSibling to select as active path
    let leafNode: Message = targetSibling;
    while (true) {
      const children = activeSession.messages.filter(m => m.parentId === leafNode.id);
      if (children.length === 0) break;
      leafNode = children[0]; // just grab first branch available down the line
    }

    const updatedSessions = sessions.map(s => {
      if (s.id === activeSession.id) {
        return {
          ...s,
          activeLeafId: leafNode.id
        };
      }
      return s;
    });

    setSessions(updatedSessions);
    showAlert(`Switched to alternate dialogue branch: ${newIndex + 1}/${siblings.length}`, 'success');
  };

  // Jump explicitly to a specfic node in the conversation tree
  const handleJumpToNode = (nodeId: string) => {
    if (!activeSession) return;
    
    // Project leaf from this node
    let leafNode = activeSession.messages.find(m => m.id === nodeId);
    if (!leafNode) return;

    while (true) {
      const children = activeSession.messages.filter(m => m.parentId === leafNode!.id);
      if (children.length === 0) break;
      leafNode = children[0];
    }

    const updatedSessions = sessions.map(s => {
      if (s.id === activeSession.id) {
        return {
          ...s,
          activeLeafId: leafNode!.id
        };
      }
      return s;
    });

    setSessions(updatedSessions);
    setTargetBranchParentId(null);
    setActivePanelTab('chat');
    showAlert("Recalibrated active dialogue thread straight to target node", "success");
  };

  // Instantiate isolation session
  const handleNewSession = () => {
    const sId = `session_${Date.now()}`;
    const firstMsgId = `msg_init_${Date.now()}`;
    const newSess: ChatSession = {
      id: sId,
      title: `🧠 Theoretical Stream ${sessions.length + 1}`,
      activeLeafId: firstMsgId,
      messages: [
        {
          id: firstMsgId,
          role: 'system',
          content: 'Initialize stream. Tree brancher active. Math mutations & priority selectors successfully established.',
          timestamp: new Date().toISOString(),
          parentId: null,
          childrenIds: []
        }
      ],
      updatedAt: new Date().toISOString()
    };

    setSessions([newSess, ...sessions]);
    setActiveSessionId(sId);
    setTargetBranchParentId(null);
    showAlert("New independent theoretical stream provisioned", "success");
  };

  const handleDeleteSession = (sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remains = sessions.filter(s => s.id !== sid);
    if (remains.length === 0) {
      // Factory state clear reset
      setSessions(INITIAL_SESSIONS.map(s => {
        let activeLeaf = s.messages[s.messages.length - 1]?.id || '';
        return {
          ...s,
          messages: s.messages.map((m, i) => ({ ...m, parentId: i > 0 ? s.messages[i-1].id : null })),
          activeLeafId: activeLeaf
        };
      }));
    } else {
      setSessions(remains);
      if (activeSessionId === sid) {
        setActiveSessionId(remains[0].id);
      }
    }
    setTargetBranchParentId(null);
    showAlert("Dialogue isolation thread discarded", "warning");
  };

  const handleSendMessage = async (customText?: string) => {
    const query = customText ? customText.trim() : inputText.trim();
    if (!query || isCochatting || !activeSession) return;

    if (!customText) {
      setInputText('');
    }

    const userMsgId = `msg_user_${Date.now()}`;
    const assistantMsgId = `msg_agent_${Date.now()}`;

    // Determine the logical parent node this path hangs on
    // If targetBranchParentId is loaded, we fork/branch from that node. Otherwise, we continue from the active leaf node.
    const determineParentId = targetBranchParentId ? targetBranchParentId : activeSession.activeLeafId || null;

    const userMsg: Message = {
      id: userMsgId,
      role: 'user',
      content: query,
      timestamp: new Date().toISOString(),
      parentId: determineParentId,
      childrenIds: [assistantMsgId]
    };

    // Calculate prompt history path up until the specified parent for API context
    let messagesForApi: Message[] = [];
    if (determineParentId) {
      let current: Message | undefined = activeSession.messages.find(m => m.id === determineParentId);
      const tempPath: Message[] = [];
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        if (current.role !== 'system') {
          tempPath.push(current);
        }
        visited.add(current.id);
        const pid = current.parentId;
        current = pid ? activeSession.messages.find(m => m.id === pid) : undefined;
      }
      messagesForApi = tempPath.reverse();
    }
    messagesForApi.push(userMsg);

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
    setTargetBranchParentId(null); // wipe active branch target
    setIsCochatting(true);

    try {
      const chatMemories = await fetchPromotedKernelMemories();
      const response = await authenticatedFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messagesForApi,
          memories: chatMemories,
          userProfile: profile,
          agentFramework: agentFramework
        })
      });

      if (!response.ok) {
        throw new Error(await response.text() || "Agent service failure");
      }

      const payload = await response.json();
      const matchedMems = chatMemories.filter(m => payload.retrievedMemoryIds?.includes(m.id));

      const assistantMsg: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: payload.responseContent,
        timestamp: new Date().toISOString(),
        parentId: userMsgId,
        childrenIds: [],
        retrievedMemories: matchedMems
      };

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

      // Perform background fact/priority extraction log
      setIsConsolidating(true);
      const extractRes = await authenticatedFetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messagesForApi, assistantMsg],
          currentMemories: chatMemories,
          userProfile: profile
        })
      });

      if (extractRes.ok) {
        const extraction = await extractRes.json();
        let createdCandidates = 0;
        if (
          extraction.newMemories &&
          extraction.newMemories.length > 0 &&
          typeof extraction.evidenceEventId === 'string'
        ) {
          const contradictionIds = Array.isArray(extraction.deletedMemoryIds)
            ? extraction.deletedMemoryIds.filter((id: unknown) => typeof id === 'string' && chatMemories.some((memory) => memory.id === id))
            : [];
          const userSources = messagesForApi
            .filter((message) => message.role === 'user')
            .map((message) => message.content);
          const groundedMemories = extraction.newMemories.filter((raw: any) => (
            typeof raw.sourceSnippet === 'string' &&
            raw.sourceSnippet.trim().length > 0 &&
            userSources.some((source) => source.includes(raw.sourceSnippet))
          ));
          const candidateResponses = await Promise.all(groundedMemories.map(async (raw: any) => {
            const importance = Number.isFinite(raw.importance) ? Number(raw.importance) : 3;
            const sourceSnippet = raw.sourceSnippet.trim();
            return authenticatedFetch('/api/kernel/memories/candidates', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kind: categoryToMemoryKind(raw.category),
                content: typeof raw.content === 'string' ? raw.content : '',
                confidence: Math.max(0.5, Math.min(0.95, importance / 5)),
                scope: { kind: 'global' },
                sensitivity: 'internal',
                retention: { kind: 'durable' },
                provenance: {
                  sourceType: 'provider_candidate',
                  sourceId: extraction.evidenceEventId,
                  actor: 'provider',
                  observedAt: new Date().toISOString(),
                  excerptHash: await sha256Text(sourceSnippet),
                },
                evidenceRefs: [{ eventId: extraction.evidenceEventId }],
                contradictionIds,
                supersedesIds: [],
              }),
            });
          }));
          createdCandidates = candidateResponses.filter((candidateResponse) => candidateResponse.ok).length;
        }
        if (createdCandidates > 0) {
          showAlert(`${createdCandidates} memory candidate${createdCandidates === 1 ? '' : 's'} awaiting review.`, 'success');
        }
      }

    } catch (err: any) {
      console.error(err);
      showAlert(`Memory network error: ${err.message}`, 'error');
    } finally {
      setIsCochatting(false);
      setIsConsolidating(false);
    }
  };

  /**
   * MUTATE NOVEL RESEARCH INSIGHT
   */
  const handlePerformMutation = async () => {
    if (!mutationSourceText.trim() || isMutating) return;
    setIsMutating(true);
    showAlert("Starting cognitive mutation cycle...", "success");

    try {
      const contextMemories = await fetchPromotedKernelMemories();
      const res = await authenticatedFetch('/api/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: mutationSourceText.trim(),
          operator: mutationOperator,
          contextMemories
        })
      });

      if (!res.ok) {
        throw new Error(await res.text() || 'Mutation failed');
      }

      const data = await res.json();
      
      const novelMutation: ResearchMutation = {
        id: `mutation_${Date.now()}`,
        title: data.title || "Mutated Thesis Index",
        parentIdeaId: "Aether Brain Map",
        operator: mutationOperator,
        novelInsight: data.novelInsight || "Insight calculation error",
        mathematicalBounds: data.mathematicalBounds || "O(1) Bounds undefined",
        suggestedActionItems: data.suggestedActionItems || [],
        evidenceEventId: typeof data.evidenceEventId === 'string' ? data.evidenceEventId : '',
        createdAt: new Date().toISOString()
      };

      setActiveMutation(novelMutation);
      showAlert("Novel research priority card generated!", "success");
    } catch (err: any) {
      console.error(err);
      showAlert(`Cognitive block offline: ${err.message}`, 'error');
    } finally {
      setIsMutating(false);
    }
  };

  const commitMutationToMemory = async () => {
    if (!activeMutation) return;
    if (!activeMutation.evidenceEventId) {
      showAlert('Mutation has no provider ledger evidence and cannot be submitted.', 'error');
      return;
    }

    const content = `[Math Mutation - ${activeMutation.title}]: ${activeMutation.novelInsight}. Bounds: ${activeMutation.mathematicalBounds}`;
    try {
      const response = await authenticatedFetch('/api/kernel/memories/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'semantic',
          content,
          confidence: 0.8,
          scope: { kind: 'global' },
          sensitivity: 'internal',
          retention: { kind: 'durable' },
          provenance: {
            sourceType: 'provider_candidate',
            sourceId: activeMutation.evidenceEventId,
            actor: 'provider',
            observedAt: new Date().toISOString(),
          },
          evidenceRefs: [{ eventId: activeMutation.evidenceEventId }],
          contradictionIds: [],
          supersedesIds: [],
        }),
      });
      if (!response.ok) throw new Error(await response.text() || 'Candidate submission failed.');
      showAlert('Mutation submitted as a kernel memory candidate for evidence review.', 'success');
    } catch (error) {
      showAlert(`Candidate submission failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  };

  const handleRestoreDefaults = () => {
    if (window.confirm("Reset the local conversation workspace? Kernel state and authentication are preserved.")) {
      localStorage.removeItem(STORAGE_KEYS.sessions);
      localStorage.removeItem(STORAGE_KEYS.activeSessionId);
      localStorage.removeItem(STORAGE_KEYS.framework);
      setSessions(INITIAL_SESSIONS.map(s => {
        let activeLeaf = s.messages[s.messages.length - 1]?.id || '';
        return {
          ...s,
          messages: s.messages.map((m, i) => ({ ...m, parentId: i > 0 ? s.messages[i-1].id : null })),
          activeLeafId: activeLeaf
        };
      }));
      setActiveSessionId(INITIAL_SESSIONS[0].id);
      setTargetBranchParentId(null);
      setActiveMutation(null);
      showAlert("Local conversation workspace reset. Kernel state was not changed.", "success");
    }
  };

  return (
    <div className="bg-[#0B0C0E] w-full h-[768px] flex overflow-hidden font-sans text-slate-300 select-none max-w-[1400px] mx-auto rounded-none md:rounded-2xl border border-slate-800 shadow-2xl relative" id="elegant_dark_app_frame">
      
      {/* Alert Overlay Popup */}
      {systemAlert && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-55 flex items-center gap-2 px-3.5 py-2.5 rounded-lg border shadow-2xl text-xs font-mono font-bold animate-fade-in bg-[#16181D]" style={{
          borderColor: systemAlert.type === 'success' ? '#0D9488' : systemAlert.type === 'warning' ? '#F59E0B' : '#EF4444',
          color: systemAlert.type === 'success' ? '#2DD4BF' : systemAlert.type === 'warning' ? '#FBBF24' : '#FCA5A5'
        }}>
          <Sparkles size={14} className="animate-spin text-teal-400" />
          <span>{systemAlert.message}</span>
        </div>
      )}

      {/* LEFT SIDEBAR (Stream list, storage diagnostics) */}
      <aside className="w-64 bg-[#0F1115] border-r border-slate-800 flex flex-col justify-between shrink-0 h-full">
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Logo Branding */}
          <div className="p-5 flex items-center space-x-2.5 border-b border-slate-800">
            <div className="w-8 h-8 rounded bg-teal-600 flex items-center justify-center border border-teal-500/20 shadow-lg shadow-teal-500/10">
              <Network className="w-4.5 h-4.5 text-white animate-pulse" />
            </div>
            <div>
              <span className="font-bold text-slate-100 text-sm tracking-tight block">LocalContext</span>
              <span className="text-[10px] font-mono tracking-wider text-[#0D9488] uppercase font-bold">Research Vault</span>
            </div>
          </div>

          <div className="p-3">
            <button
              onClick={handleNewSession}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-800/40 hover:bg-slate-800/70 text-slate-200 hover:text-white border border-slate-800 hover:border-slate-700/80 transition-all rounded-lg text-xs font-medium cursor-pointer"
            >
              <Plus size={14} className="text-teal-400 font-bold" />
              New Stream Tree
            </button>
          </div>

          {/* Search channel */}
          <div className="px-3 pb-2.5">
            <input 
              type="text" 
              placeholder="Search streams..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-[11px] bg-slate-900/60 border border-slate-850 rounded px-2.5 py-1 t-slate-300 focus:outline-none focus:border-slate-700 transition font-mono"
            />
          </div>

          {/* Nav scroll stream tree elements */}
          <div className="flex-1 overflow-y-auto px-2 space-y-1">
            <div className="px-2.5 py-1 text-[9px] font-mono tracking-widest text-slate-500 uppercase">Interactive Streams</div>
            
            {sessions.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase())).map((session) => {
              const isActive = session.id === activeSessionId;
              const nodeCount = session.messages.length;
              
              return (
                <div
                  key={session.id}
                  onClick={() => { setActiveSessionId(session.id); setTargetBranchParentId(null); }}
                  className={`group flex items-center justify-between px-2.5 py-2.5 rounded-lg border transition-all cursor-pointer ${
                    isActive 
                      ? 'bg-[#16181D] border-slate-800 text-teal-400' 
                      : 'border-transparent text-slate-400 hover:bg-slate-800/20 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-start gap-1.5 overflow-hidden flex-1">
                    <GitBranch size={13} className={`mt-0.5 shrink-0 ${isActive ? 'text-teal-400' : 'text-slate-500'}`} />
                    <div className="overflow-hidden">
                      <span className="text-xs font-semibold block truncate leading-tight font-sans">
                        {session.title}
                      </span>
                      <span className="text-[9.5px] font-mono text-slate-500 flex items-center gap-1 mt-0.5">
                        {nodeCount} Nodes
                      </span>
                    </div>
                  </div>
                  
                  <button
                    onClick={(e) => handleDeleteSession(session.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-800 hover:text-rose-455 hover:text-rose-500 rounded transition duration-200 ml-1 shrink-0 cursor-pointer"
                    title="Delete Thread"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Diagnostic info & restore actions */}
        <div className="p-4 border-t border-slate-800 flex flex-col gap-3">
          <div className="bg-[#16181D]/60 rounded-lg p-3 border border-slate-800/50">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[9px] uppercase font-mono text-slate-500 tracking-wider flex items-center gap-1 font-bold">
                <HardDrive size={10} className="text-teal-400" />
                <span>PROMOTED KERNEL MEMORY</span>
              </span>
              <span className="text-[9px] font-mono text-teal-400">
                {memories.length} active
              </span>
            </div>
            <p className="text-[9px] font-mono text-slate-600">Read-only projection from the kernel API</p>
          </div>

          <button
            onClick={handleRestoreDefaults}
            className="w-full flex items-center justify-center gap-1.5 text-[9.5px] uppercase font-mono tracking-widest py-1.5 bg-slate-900 border border-slate-800 text-rose-400 hover:bg-rose-950/10 hover:border-rose-900/60 transition-colors rounded-md cursor-pointer"
          >
            <RefreshCw size={11} className="shrink-0" />
            Reset Local Chat
          </button>
        </div>
      </aside>

      {/* CENTER WORKSPACE PANE */}
      <main className="flex-1 flex flex-col bg-[#0B0C0E] h-full overflow-hidden">
        
        {/* Workspace Tab Navigation bar */}
        <header className="h-16 border-b border-slate-800 bg-[#0F1115]/50 backdrop-blur-sm flex items-center px-6 justify-between shrink-0 z-10">
          <div className="flex items-center gap-2">
            <div className="flex bg-[#0B0C0E] border border-slate-800 p-0.5 rounded-lg">
              <button
                onClick={() => { setActivePanelTab('chat'); setTargetBranchParentId(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                  activePanelTab === 'chat' 
                    ? 'bg-teal-600 text-white font-bold' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MessageSquare size={13} />
                Arena Chat
              </button>
              
              <button
                onClick={() => setActivePanelTab('tree')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                  activePanelTab === 'tree' 
                    ? 'bg-teal-600 text-white font-bold' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Network size={13} />
                Theory Tree
              </button>

              <button
                onClick={() => setActivePanelTab('mutator')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                  activePanelTab === 'mutator' 
                    ? 'bg-teal-600 text-white font-bold animate-pulse' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap size={13} className="text-amber-400" />
                Math Mutator
              </button>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <div className="text-right">
              <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest block">Active Leaf Address</span>
              <span className="text-[10px] font-mono text-teal-400">{activeSession?.activeLeafId ? activeSession.activeLeafId.substring(0, 15) + "..." : "none"}</span>
            </div>
          </div>
        </header>

        {/* PANEL VIEW: 1. THE ARENA CHAT SYSTEM */}
        {activePanelTab === 'chat' && (
          <div className="flex-1 flex flex-col justify-between overflow-hidden">
            
            {/* Thread timeline scroll Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="max-w-4xl mx-auto space-y-4">
                <AuthPanel />
                <KernelPanel />
                <LearningPanel />
                <ProviderPanel />
                <RuntimePanel />
              </div>
              
              {/* Branch off system alerts */}
              {targetBranchParentId && (
                <div className="bg-[#16181D] border border-yellow-500/20 text-yellow-500 p-3 rounded-xl flex items-center justify-between z-10 animate-fade-in mb-2">
                  <span className="text-xs flex items-center gap-1.5">
                    <GitBranch size={14} className="animate-pulse shrink-0" />
                    Branching Node Locked inside timeline! Next query triggers Alternate Path child.
                  </span>
                  <button 
                    onClick={() => setTargetBranchParentId(null)}
                    className="text-xs bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded text-white"
                  >
                    Cancel Fork
                  </button>
                </div>
              )}

              {activePath.length <= 1 && (
                <div className="max-w-2xl mx-auto bg-[#16181D] border border-slate-800 rounded-xl p-5 shadow-2xl relative overflow-hidden mt-2" id="arena_greeting">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-teal-500/10 to-transparent -mr-10 -mt-10 rounded-full" />
                  <div className="flex items-start gap-3">
                    <div className="bg-teal-600/10 text-teal-400 p-2 rounded-lg border border-teal-500/20 shrink-0">
                      <Network size={18} />
                    </div>
                    <div>
                      <h4 className="text-slate-100 font-bold text-xs uppercase tracking-wider mb-1">CONVERSATIONAL RECOGNITIVE GRAPH</h4>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        To fork alternate trajectories, hover over any response bubble and select the <span className="text-teal-400 font-bold font-mono">[Branch Dialog]</span> operator. The system supports full traversal up and down parallel branches, and mutations representing novel priorities can be engineered inside the Mutator tab.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-800/80">
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-2 font-bold tracking-wider">Example Dialogue Prompts:</span>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {EXAMPLE_SUGGESTIONS.map((str, i) => (
                        <button
                          key={i}
                          onClick={() => handleSendMessage(str)}
                          disabled={isCochatting}
                          className="text-left px-3 py-2 bg-slate-900 border border-slate-800/80 text-xs text-slate-400 rounded-lg hover:text-teal-400 hover:border-teal-500/20 transition-all cursor-pointer truncate"
                        >
                          {str}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Message loop render */}
              {activePath.map((m) => {
                if (m.role === 'system') return null;
                const isUser = m.role === 'user';
                const siblings = getSiblings(m);
                const isBranched = siblings.length > 1;
                const branchIndex = siblings.findIndex(s => s.id === m.id);

                return (
                  <div key={m.id} className={`flex flex-col max-w-2xl mx-auto animate-fade-in group/bubble ${isUser ? 'items-end' : 'items-start'}`}>
                    
                    {/* Meta tags with Branch sibling switches */}
                    <div className="flex items-center gap-2.5 mb-1 text-[10px] font-mono text-slate-500 w-full justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-slate-400">{isUser ? 'HUMAN EXPERIMENTER' : 'RECOGNITIVE COGNIZANT'}</span>
                        <span>•</span>
                        <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>

                      {/* Display branch arrows if dialogue fork is active */}
                      {isBranched && (
                        <div className="flex items-center gap-1 bg-[#16181D] px-1.5 py-0.5 rounded border border-slate-800">
                          <button 
                            onClick={() => changeBranch(m, 'prev')}
                            className="hover:text-teal-400 cursor-pointer text-slate-400 transition"
                            title="Previous dialogue node branch"
                          >
                            <ChevronLeft size={11} />
                          </button>
                          <span className="text-[9.5px] text-teal-400 font-bold px-1 uppercase tracking-wide">
                            Branch {branchIndex + 1}/{siblings.length}
                          </span>
                          <button 
                            onClick={() => changeBranch(m, 'next')}
                            className="hover:text-teal-400 cursor-pointer text-slate-400 transition"
                            title="Next dialogue node branch"
                          >
                            <ChevronRight size={11} />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Chat Bubble card */}
                    <div className={`p-4 rounded-xl border text-xs leading-relaxed w-full max-w-[95%] relative transition-all ${
                      isUser 
                        ? 'bg-[#1F232B] border-slate-800/80 text-slate-100 hover:border-slate-700/60'
                        : 'bg-[#16181D] border-slate-800/80 text-slate-200 hover:border-slate-800'
                    }`}>
                      
                      {/* Branch & Mutator overlay tags visible on bubble hover */}
                      <div className="absolute right-3 top-3 opacity-0 group-hover/bubble:opacity-100 transition-opacity duration-200 flex items-center gap-1.5 bg-[#0B0C0E]/90 p-1 rounded border border-slate-800 shadow-xl z-10">
                        <button
                          onClick={() => {
                            setTargetBranchParentId(m.id);
                            showAlert("Branch fork anchor locked. Submit input to spawn parallel track.", "success");
                          }}
                          className="px-1.5 py-0.5 bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 rounded text-[9.5px] font-mono font-bold flex items-center gap-1 cursor-pointer transition"
                          title="Branch out conversation path from here"
                        >
                          <GitBranch size={9} />
                          Branch Graph
                        </button>
                        <button
                          onClick={() => {
                            setMutationSourceText(m.content);
                            setActivePanelTab('mutator');
                            showAlert("Dialogue context transferred to Mathematics Mutator!", "success");
                          }}
                          className="px-1.5 py-0.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded text-[9.5px] font-mono font-bold flex items-center gap-1 cursor-pointer transition"
                          title="Extract concept for math mutation"
                        >
                          <Zap size={9} />
                          Mutate
                        </button>
                      </div>

                      <p className="whitespace-pre-wrap font-sans leading-relaxed">{m.content}</p>

                      {/* Decoded memory context block tracers */}
                      {!isUser && m.retrievedMemories && m.retrievedMemories.length > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-slate-800/80">
                          <div className="flex items-center gap-1 text-[9px] font-mono tracking-wider text-teal-400 uppercase font-bold">
                            <span className="relative flex h-1.5 w-1.5 mr-1 pt-0.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-teal-500"></span>
                            </span>
                            <span>Activated Memory Core Maps ({m.retrievedMemories.length}):</span>
                          </div>
                          
                          <div className="mt-1.5 grid grid-cols-1 gap-1">
                            {m.retrievedMemories.map((rm) => (
                              <div key={rm.id} className="p-1 px-2 border border-slate-850 bg-[#0B0C0E]/40 rounded text-[9px] font-mono flex items-center justify-between text-slate-500 hover:text-slate-400">
                                <span className="truncate max-w-[80%]">{rm.content}</span>
                                <span className="text-[#0D9488] shrink-0">[{rm.category}]</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Copilot generative placeholder */}
              {isCochatting && (
                <div className="flex flex-col items-start max-w-2xl mx-auto">
                  <div className="flex items-center gap-1 text-[10px] font-mono text-slate-500 mb-1">
                    <span>RECOGNITIVE ACTIVE WEIGHTS</span>
                    <span>•</span>
                    <span className="text-teal-400 animate-pulse font-bold">Injecting Context maps...</span>
                  </div>
                  <div className="p-4 rounded-xl bg-[#16181D] border border-slate-850 text-xs text-slate-500 space-y-2 w-72">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 bg-teal-400 rounded-full animate-ping"></div>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400">Resolving tree convergence...</span>
                    </div>
                    <div className="space-y-1">
                      <div className="h-1 bg-slate-800 rounded w-full animate-pulse"></div>
                      <div className="h-1 bg-slate-800 rounded w-4/5 animate-pulse"></div>
                      <div className="h-1 bg-slate-800 rounded w-2/3 animate-pulse"></div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Bottom text typing form */}
            <div className="p-4 border-t border-slate-800 bg-[#0F1115]/50 shrink-0">
              <div className="max-w-2xl mx-auto relative flex items-center">
                
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSendMessage(); }}
                  placeholder={isCochatting ? 'Wait until pipeline resolves...' : 'Interact with agent (e.g., "challenge my previous math theorem")'}
                  disabled={isCochatting}
                  className="w-full bg-[#0B0C0E] border border-slate-800 rounded-xl pl-4 pr-12 py-3.5 text-xs placeholder-slate-650 text-slate-200 focus:outline-[#1F232B] focus:border-teal-500 focus:outline-none transition-all focus:ring-1 focus:ring-teal-500"
                  id="chat_input_arena"
                />

                <button
                  onClick={() => handleSendMessage()}
                  disabled={isCochatting || !inputText.trim()}
                  className={`absolute right-2 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white font-bold transition rounded-lg flex items-center justify-center cursor-pointer ${
                    isCochatting || !inputText.trim() 
                      ? 'bg-slate-800/10 text-slate-550 border border-slate-800' 
                      : 'hover:scale-105 active:scale-95 shadow-lg shadow-teal-500/10'
                  }`}
                >
                  <Send size={12} className="mr-1" />
                  <span className="text-[10px] font-mono leading-none font-bold">SUBMIT</span>
                </button>

              </div>
              
              <div className="text-[9px] text-center font-mono text-slate-650 mt-2 flex justify-center gap-4">
                <span className="flex items-center gap-1 select-none">
                  <ShieldCheck size={11} className="text-teal-600" />
                  Local chat presentation only
                </span>
                <span>•</span>
                <span>Provider-routed extraction with kernel evidence</span>
              </div>
            </div>

          </div>
        )}

        {/* PANEL VIEW: 2. INTERACTIVE DIALOGUE TREE & MIND MAP VISUALIZER */}
        {activePanelTab === 'tree' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4">
            <div className="bg-[#16181D] border border-slate-800 p-4.5 rounded-xl">
              <h3 className="text-slate-100 font-bold text-xs uppercase tracking-wider mb-1 flex items-center gap-1 px-1">
                <Network size={14} className="text-teal-400" />
                <span>Conversational Tree Flowchart Topology</span>
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed px-1">
                A visual mapping of all parallel messages in this stream. The highlighted column defines the current chronologically active dialogue branch path. Click any node block to jump straight into its history.
              </p>
            </div>

            {/* Active Nodes flowchart mapping rendering */}
            <div className="p-4 border border-slate-800 bg-[#0F1115]/50 rounded-xl min-h-[400px] flex flex-col space-y-3 justify-center relative">
              {(!activeSession || activeSession.messages.length === 0) ? (
                <div className="text-center font-mono text-xs text-slate-500">No logical nodes initialized yet. Welcome prompt is empty.</div>
              ) : (
                <div className="space-y-6">
                  {/* Visual flowchart graph layout */}
                  {Array.from(new Set(activeSession.messages.map(m => m.parentId || 'root'))).map((parentKey) => {
                    const childrenArr = activeSession.messages.filter(m => (m.parentId || 'root') === parentKey);
                    const parentNode = activeSession.messages.find(m => m.id === parentKey);

                    return (
                      <div key={parentKey} className="border-l border-teal-500/25 pl-4 ml-2 space-y-2 animate-fade-in relative">
                        <div className="text-[9px] font-mono text-[#0D9488] mb-1 uppercase tracking-widest flex items-center gap-1 select-none">
                          <GitCommit size={10} />
                          <span>Branch Family: {parentKey === 'root' ? 'System Base' : `Anchor Target: ${String(parentKey).substring(0, 8)}`}</span>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {childrenArr.map((child) => {
                            const isCurrentlyActiveInTimeline = activePath.some(pathNode => pathNode.id === child.id);
                            
                            return (
                              <div
                                key={child.id}
                                onClick={() => handleJumpToNode(child.id)}
                                className={`p-3.5 rounded-lg border text-left transition-all cursor-pointer relative group/node ${
                                  isCurrentlyActiveInTimeline
                                    ? 'bg-[#16181D] border-teal-500/60 shadow-lg shadow-teal-500/5'
                                    : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-900/80'
                                }`}
                              >
                                {isCurrentlyActiveInTimeline && (
                                  <span className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-teal-500 rounded-full border border-black animate-pulse" title="Active on conversational runway" />
                                )}

                                <div className="flex items-center justify-between mb-1.5 border-b border-slate-850 pb-1 flex-wrap">
                                  <span className="text-[8.5px] font-mono uppercase tracking-wider text-slate-500 font-bold block">
                                    {child.role === 'user' ? '👤 Subject Input' : '🤖 Agent Response'}
                                  </span>
                                  <span className="text-[8px] font-mono text-slate-650 group-hover/node:text-teal-400">
                                    ID: {child.id.substring(0, 10)}
                                  </span>
                                </div>
                                <p className="text-xs line-clamp-3 leading-relaxed break-words font-sans">{child.content}</p>

                                <div className="mt-2.5 pt-1.5 border-t border-slate-850 flex items-center justify-between text-[9px] font-mono text-slate-650">
                                  <span>{new Date(child.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                  {child.childrenIds && child.childrenIds.length > 0 && (
                                    <span className="text-[#0D9488] font-bold">{child.childrenIds.length} Child links</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* PANEL VIEW: 3. MATHEMATICAL MUTATOR & ADVANCED INSIGHT WORKSPACE */}
        {activePanelTab === 'mutator' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4">
            
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Controls Column */}
              <div className="lg:col-span-5 space-y-4">
                <div className="bg-[#16181D] border border-slate-800 p-4.5 rounded-xl space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                    <Zap size={15} />
                    <span>Aether Mutation Operators</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed font-sans">
                    Take high-signal inputs (mathematical assumptions, formulas, or dialog nodes), apply heuristic stress operators, and mutate them into speculative academic insights.
                  </p>
                </div>

                {/* Input Premise form */}
                <div className="bg-[#16181D] border border-slate-800 rounded-xl p-4.5 space-y-3.5">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2 font-bold select-none">Source Conjecture / Premise:</label>
                    <textarea
                      value={mutationSourceText}
                      onChange={(e) => setMutationSourceText(e.target.value)}
                      className="w-full text-xs bg-[#0B0C0E] border border-slate-800 rounded-lg p-3 text-slate-200 focus:outline-none focus:border-amber-500 min-h-[140px] leading-relaxed font-sans"
                      placeholder="e.g. Non-Abelian Gauge theories with scalar lattices..."
                    />
                  </div>

                  {/* Operator grid */}
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2 font-bold select-none">Mutation Operator:</label>
                    <div className="grid grid-cols-1 gap-1.5">
                      {[
                        { id: 'heuristic_leap', label: 'Heuristic Leap (Analogical Transfer)', desc: 'Port abstract structures from geometry & physics to breed novel isomorphisms.' },
                        { id: 'axiomatic_friction', label: 'Axiomatic Friction', desc: 'Stress-test basic assumptions by relaxing, scaling or collapsing foundational boundaries.' },
                        { id: 'combinatorial', label: 'Combinatorial Synthesizer', desc: 'Synthesize formal linkage intersections with scalable transformers & category theory.' },
                        { id: 'priority_shock', label: 'Priority Shock (Boundary Shift)', desc: 'Adjust constraints of physical limits or computational load limits.' }
                      ].map((op) => (
                        <button
                          key={op.id}
                          type="button"
                          onClick={() => setMutationOperator(op.id as any)}
                          className={`p-2.5 rounded-lg border text-left flex items-start gap-2.5 transition cursor-pointer select-none ${
                            mutationOperator === op.id
                              ? 'bg-[#1F232B] border-amber-500/60 text-amber-400'
                              : 'bg-[#0B0C0E]/60 border-slate-850 hover:bg-[#16181D] hover:border-slate-800'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${mutationOperator === op.id ? 'bg-amber-400' : 'bg-slate-700'}`} />
                          <div>
                            <span className="text-[11px] font-bold block">{op.label}</span>
                            <span className="text-[10px] text-slate-500 font-sans block leading-normal mt-0.5">{op.desc}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Seed Mutator Button */}
                  <button
                    onClick={handlePerformMutation}
                    disabled={isMutating || !mutationSourceText.trim()}
                    className={`w-full py-2.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                      isMutating || !mutationSourceText.trim()
                        ? 'bg-slate-800/20 text-slate-650'
                        : 'bg-amber-500 hover:bg-amber-600 active:scale-95 text-black font-black font-mono shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20'
                    }`}
                  >
                    <Zap size={13} className={isMutating ? 'animate-spin' : ''} />
                    {isMutating ? 'ENGINEERING INSIGHT...' : 'MUTATE COGNITIVE SYSTEM'}
                  </button>
                </div>
              </div>

              {/* Outputs display Column */}
              <div className="lg:col-span-7">
                {activeMutation ? (
                  <div className="bg-[#16181D] border border-slate-800 rounded-xl p-5 space-y-4 animate-fade-in relative shadow-2xl">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-amber-500/10 to-transparent -mr-10 -mt-10 rounded-full select-none" />
                    
                    <div className="flex items-center justify-between border-b border-amber-500/20 pb-3">
                      <div>
                        <span className="text-[9.5px] font-mono uppercase tracking-wider bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2.5 py-1 rounded">
                          {activeMutation.operator.replace('_', ' ')} Applied
                        </span>
                        <div className="text-[8px] text-slate-500 font-mono mt-1.5">BRED INDEX: {activeMutation.id}</div>
                      </div>
                      
                      <button
                        onClick={() => void commitMutationToMemory()}
                        className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded text-xs font-semibold flex items-center gap-1 select-none transition cursor-pointer"
                      >
                        <HardDrive size={12} />
                        Submit Candidate
                      </button>
                    </div>

                    <div className="space-y-4">
                      {/* Title section */}
                      <div>
                        <h2 className="text-slate-100 font-bold font-sans tracking-tight text-sm leading-snug flex items-start gap-1">
                          <BookOpen size={14} className="text-amber-400 shrink-0 mt-0.5" />
                          <span>{activeMutation.title}</span>
                        </h2>
                      </div>

                      {/* Thesis Section */}
                      <div className="bg-[#0B0C0E]/80 border border-slate-850 p-3.5 rounded-lg space-y-1">
                        <span className="text-[9px] font-mono text-amber-400 uppercase tracking-wider block font-bold">MUTATED CONJECTURE INSIGHT</span>
                        <p className="text-slate-300 text-xs leading-relaxed font-sans">{activeMutation.novelInsight}</p>
                      </div>

                      {/* Analytical bounds section */}
                      <div className="bg-[#0B0C0E]/40 border border-slate-850 p-3.5 rounded-lg space-y-1">
                        <span className="text-[9px] font-mono text-teal-400 uppercase tracking-wider block font-bold">FORMAL MATHEMATICAL BOUNDS</span>
                        <p className="text-slate-400 text-xs font-mono leading-relaxed">{activeMutation.mathematicalBounds}</p>
                      </div>

                      {/* Action item tracks */}
                      <div className="space-y-2">
                        <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block font-bold">Priority Research Directions:</span>
                        <div className="space-y-1">
                          {activeMutation.suggestedActionItems.map((item, id) => (
                            <div key={id} className="flex items-start gap-2 text-xs text-slate-400 hover:text-slate-200 leading-normal bg-slate-900/40 p-2 rounded border border-slate-850">
                              <span className="w-4 h-4 rounded-full bg-slate-850 text-[10px] font-mono flex items-center justify-center text-teal-400 shrink-0 mt-0.5">
                                {id + 1}
                              </span>
                              <span>{item}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="border border-dashed border-slate-800 rounded-xl p-16 text-center bg-[#16181D]/30 flex flex-col items-center justify-center min-h-[450px]">
                    <Layers size={36} className="text-slate-650 mb-3" />
                    <span className="text-xs text-slate-400 font-bold block">Conjecture Reactor Offline</span>
                    <span className="text-[11px] text-slate-550 font-sans block max-w-sm mx-auto leading-normal mt-1.5">
                      Input theoretical premises on the left controls, select the heuristic mutation criteria operator, and trigger calculations to display novel insights here.
                    </span>
                  </div>
                )}
              </div>
            </div>

          </div>
        )}

      </main>

      {/* RIGHT SIDEBAR PANEL - The Local Agent Knowledgebase */}
      <aside className="w-80 border-l border-slate-800 shrink-0 h-full overflow-hidden block">
        <MemoryDashboard
          memories={memories}
          profile={profile}
          isConsolidating={isConsolidating}
          agentFramework={agentFramework}
          onSetAgentFramework={setAgentFramework}
        />
      </aside>

    </div>
  );
}
