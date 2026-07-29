/**
 * @license
 * SPDX-License-Identifier: BUSL-1.1
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
import {
  authenticatedFetch,
  clearAuthSession,
  fetchAuthStatus,
  getAuthSession,
  subscribeAuth,
} from './lib/auth';
import MemoryDashboard from './components/MemoryDashboard';
import { AuthPanel } from './components/AuthPanel';
import { KernelPanel } from './components/KernelPanel';
import { LearningPanel } from './components/LearningPanel';
import { ProviderPanel } from './components/ProviderPanel';
import { RecurringResearchPanel } from './components/RecurringResearchPanel';
import { ResearchMissionPanel } from './components/ResearchMissionPanel';
import { RuntimePanel } from './components/RuntimePanel';
import { DesktopPanel } from './components/DesktopPanel';
import { AgentObservatory } from './components/AgentObservatory';
import { 
  Plus, MessageSquare, Trash2, Database, Brain, Sparkles, 
  ArrowRight, ShieldCheck, HelpCircle, HardDrive, RefreshCw, Send,
  Cpu, AlertCircle, FileText, CheckCircle, GitBranch, GitCommit, GitMerge,
  Zap, Compass, ChevronLeft, ChevronRight, Scale, Beaker, Layers, Network, BookOpen, CalendarClock, MonitorCog,
  Activity, LayoutDashboard, Menu, X
} from 'lucide-react';

type PanelTab = 'overview' | 'chat' | 'missions' | 'schedules' | 'desktop' | 'knowledge' | 'tree' | 'mutator';
type PresentationScope = 'unresolved' | 'open' | 'protected';
type RequestFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AuthWorkflow {
  controller: AbortController;
  epoch: number;
  token?: string;
}

const DEFAULT_MUTATION_SOURCE =
  'Explore the convergence profile of non-Lipschitz neural operators mapping infinite-dimensional Hilbert states.';

const createDefaultSessions = (): ChatSession[] => INITIAL_SESSIONS.map((session) => {
  const activeLeaf = session.messages[session.messages.length - 1]?.id || '';
  return {
    ...session,
    messages: session.messages.map((message, index) => ({
      ...message,
      parentId: index > 0 ? session.messages[index - 1].id : null,
      childrenIds: index < session.messages.length - 1 ? [session.messages[index + 1].id] : [],
    })),
    activeLeafId: activeLeaf,
  };
});

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === 'AbortError'
);

const workflowAbortError = (): DOMException => new DOMException(
  'The authenticated workflow was cancelled.',
  'AbortError',
);

const KernelAccessNotice: React.FC = () => (
  <section
    className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4"
    aria-label="Kernel access required"
  >
    <div className="flex items-start gap-3">
      <AlertCircle size={17} className="mt-0.5 shrink-0 text-amber-300" />
      <div>
        <p className="text-xs font-semibold text-amber-200">Sign in to load protected runtime data</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          Authentication is handled above. Kernel state, mutations, and execution controls stay unmounted until access is
          available.
        </p>
      </div>
    </div>
  </section>
);

const trapDrawerFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )) as HTMLElement[];
  const visibleFocusable = focusable.filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
  if (visibleFocusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = visibleFocusable[0];
  const last = visibleFocusable[visibleFocusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

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

const fetchPromotedKernelMemories = async (
  fetcher: RequestFetcher = authenticatedFetch,
): Promise<MemoryItem[]> => {
  const response = await fetcher('/api/kernel/memories?status=promoted');
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
  // Protected-session conversations stay process-local and are reset on principal changes.
  const [sessions, setSessions] = useState<ChatSession[]>(createDefaultSessions);

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const profile = INITIAL_PROFILE;

  const [activeSessionId, setActiveSessionId] = useState<string>(() => INITIAL_SESSIONS[0]?.id || '');

  // UI state variables
  const [inputText, setInputText] = useState('');
  const [isCochatting, setIsCochatting] = useState(false);
  const [isConsolidating, setIsConsolidating] = useState(false);
  const [chatStage, setChatStage] = useState<'idle' | 'routing' | 'recording' | 'extracting'>('idle');
  const [searchQuery, setSearchQuery] = useState('');
  const [systemAlert, setSystemAlert] = useState<{message: string; type: 'success' | 'warning' | 'error'} | null>(null);

  // Active agentic framework state
  const [agentFramework, setAgentFramework] = useState<AgentFramework>('cartographer');

  // Active branching / creation state
  const [targetBranchParentId, setTargetBranchParentId] = useState<string | null>(null);

  // Tree vs List toggle view
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('overview');
  const [missionFocusId, setMissionFocusId] = useState<string | null>(null);
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [kernelAccessReady, setKernelAccessReady] = useState(false);
  const [presentationScope, setPresentationScope] = useState<PresentationScope>('unresolved');
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);
  const navigationCloseRef = useRef<HTMLButtonElement>(null);
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  const activityCloseRef = useRef<HTMLButtonElement>(null);
  const authEpochRef = useRef(0);
  const authGenerationRef = useRef(0);
  const workflowControllersRef = useRef(new Set<AbortController>());
  const alertTimeoutRef = useRef<number | null>(null);
  const isSubmittingMutationRef = useRef(false);

  // Mathematical Mutation Workspace States
  const [mutationOperator, setMutationOperator] = useState<'heuristic_leap' | 'axiomatic_friction' | 'combinatorial' | 'priority_shock'>('heuristic_leap');
  const [mutationSourceText, setMutationSourceText] = useState(DEFAULT_MUTATION_SOURCE);
  const [isMutating, setIsMutating] = useState(false);
  const [isSubmittingMutation, setIsSubmittingMutation] = useState(false);
  const [activeMutation, setActiveMutation] = useState<ResearchMutation | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const abortAuthenticatedWorkflows = () => {
    for (const controller of workflowControllersRef.current) controller.abort();
    workflowControllersRef.current.clear();
  };

  const resetPrincipalPresentation = () => {
    const defaults = createDefaultSessions();
    setSessions(defaults);
    setActiveSessionId(defaults[0]?.id ?? '');
    setMemories([]);
    setInputText('');
    setSearchQuery('');
    setAgentFramework('cartographer');
    setTargetBranchParentId(null);
    setActivePanelTab('overview');
    setMissionFocusId(null);
    setIsNavigationOpen(false);
    setIsActivityOpen(false);
    setIsCochatting(false);
    setIsConsolidating(false);
    setChatStage('idle');
    setMutationOperator('heuristic_leap');
    setMutationSourceText(DEFAULT_MUTATION_SOURCE);
    setIsMutating(false);
    isSubmittingMutationRef.current = false;
    setIsSubmittingMutation(false);
    setActiveMutation(null);
    setSystemAlert(null);
    if (alertTimeoutRef.current !== null) {
      window.clearTimeout(alertTimeoutRef.current);
      alertTimeoutRef.current = null;
    }
  };

  const beginAuthWorkflow = (): AuthWorkflow => {
    const controller = new AbortController();
    workflowControllersRef.current.add(controller);
    return {
      controller,
      epoch: authEpochRef.current,
      token: getAuthSession()?.token,
    };
  };

  const isCurrentAuthWorkflow = (workflow: AuthWorkflow): boolean => (
    !workflow.controller.signal.aborted && workflow.epoch === authEpochRef.current
  );

  const assertCurrentAuthWorkflow = (workflow: AuthWorkflow): void => {
    if (!isCurrentAuthWorkflow(workflow)) throw workflowAbortError();
  };

  const finishAuthWorkflow = (workflow: AuthWorkflow): void => {
    workflowControllersRef.current.delete(workflow.controller);
  };

  const fetchForAuthWorkflow = async (
    workflow: AuthWorkflow,
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    assertCurrentAuthWorkflow(workflow);
    const headers = new Headers(init.headers);
    if (workflow.token) headers.set('authorization', `Bearer ${workflow.token}`);
    else headers.delete('authorization');
    const response = await fetch(input, {
      credentials: 'same-origin',
      ...init,
      headers,
      signal: workflow.controller.signal,
    });
    if (
      response.status === 401 &&
      isCurrentAuthWorkflow(workflow) &&
      getAuthSession()?.token === workflow.token
    ) {
      clearAuthSession();
    }
    assertCurrentAuthWorkflow(workflow);
    return response;
  };

  useEffect(() => {
    purgeLegacyAuthoritativeStorage();
    // These former presentation keys could contain a previous principal's local
    // conversation state. The app never reads them after this migration.
    for (const key of ['agent_kb_sessions_v2', 'agent_kb_active_sid_v2', 'agent_kb_framework']) {
      localStorage.removeItem(key);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const applyAccess = async (generation: number) => {
      const session = getAuthSession();
      if (session) {
        if (!disposed && generation === authGenerationRef.current) {
          setPresentationScope('protected');
          setKernelAccessReady(true);
        }
        return;
      }
      try {
        const status = await fetchAuthStatus();
        if (disposed || generation !== authGenerationRef.current) return;
        if (status.mode === 'open') {
          const defaults = createDefaultSessions();
          const openSessions = readJsonFromStorage(STORAGE_KEYS.sessions, defaults, isChatSessionArray);
          const requestedActiveId = readStringFromStorage(
            STORAGE_KEYS.activeSessionId,
            openSessions[0]?.id ?? '',
          );
          setSessions(openSessions);
          setActiveSessionId(
            openSessions.some((sessionCandidate) => sessionCandidate.id === requestedActiveId)
              ? requestedActiveId
              : openSessions[0]?.id ?? '',
          );
          setAgentFramework(readJsonFromStorage(
            STORAGE_KEYS.framework,
            'cartographer',
            isAgentFramework,
          ));
          setPresentationScope('open');
          setKernelAccessReady(true);
        } else {
          setPresentationScope('protected');
          setKernelAccessReady(false);
        }
      } catch {
        if (!disposed && generation === authGenerationRef.current) {
          setPresentationScope('protected');
          setKernelAccessReady(false);
        }
      }
    };

    const refreshAccess = (principalChanged: boolean) => {
      const generation = authGenerationRef.current + 1;
      authGenerationRef.current = generation;
      setKernelAccessReady(false);
      setPresentationScope('unresolved');
      if (principalChanged) {
        authEpochRef.current += 1;
        abortAuthenticatedWorkflows();
        resetPrincipalPresentation();
      }
      void applyAccess(generation);
    };

    refreshAccess(false);
    const unsubscribe = subscribeAuth(() => refreshAccess(true));
    return () => {
      disposed = true;
      authGenerationRef.current += 1;
      authEpochRef.current += 1;
      abortAuthenticatedWorkflows();
      if (alertTimeoutRef.current !== null) window.clearTimeout(alertTimeoutRef.current);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (activePanelTab === 'chat') {
      scrollToBottom();
    }
  }, [sessions, activeSessionId, activePanelTab]);

  useEffect(() => {
    if (!isNavigationOpen && !isActivityOpen) return;
    const navigationIsActive = isNavigationOpen;
    const closeButton = navigationIsActive ? navigationCloseRef : activityCloseRef;
    const triggerButton = navigationIsActive ? navigationTriggerRef : activityTriggerRef;
    const focusTimer = window.setTimeout(() => closeButton.current?.focus(), 0);
    const closeDrawer = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (navigationIsActive) setIsNavigationOpen(false);
      else setIsActivityOpen(false);
    };
    window.addEventListener('keydown', closeDrawer);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', closeDrawer);
      triggerButton.current?.focus();
    };
  }, [isActivityOpen, isNavigationOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const navigationWide = window.matchMedia('(min-width: 1024px)');
    const activityWide = window.matchMedia('(min-width: 1536px)');
    const closeNavigationAtWideBreakpoint = () => {
      if (navigationWide.matches) setIsNavigationOpen(false);
    };
    const closeActivityAtWideBreakpoint = () => {
      if (activityWide.matches) setIsActivityOpen(false);
    };
    closeNavigationAtWideBreakpoint();
    closeActivityAtWideBreakpoint();
    navigationWide.addEventListener('change', closeNavigationAtWideBreakpoint);
    activityWide.addEventListener('change', closeActivityAtWideBreakpoint);
    return () => {
      navigationWide.removeEventListener('change', closeNavigationAtWideBreakpoint);
      activityWide.removeEventListener('change', closeActivityAtWideBreakpoint);
    };
  }, []);

  // Only anonymous open mode persists local presentation state. Protected
  // principals receive a fresh in-memory workspace for each auth epoch.
  useEffect(() => {
    if (presentationScope === 'open') writeJsonToStorage(STORAGE_KEYS.sessions, sessions);
  }, [presentationScope, sessions]);

  useEffect(() => {
    if (presentationScope === 'open') writeJsonToStorage(STORAGE_KEYS.framework, agentFramework);
  }, [agentFramework, presentationScope]);

  useEffect(() => {
    if (presentationScope === 'open') {
      localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
    }
  }, [activeSessionId, presentationScope]);

  useEffect(() => {
    if (!kernelAccessReady) {
      setMemories([]);
      return;
    }
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
  }, [kernelAccessReady]);

  // Retrieve current active session
  const activeSessionIndex = Math.max(0, sessions.findIndex(s => s.id === activeSessionId));
  const activeSession = sessions[activeSessionIndex] || sessions[0];

  // Utility alerts
  const showAlert = (message: string, type: 'success' | 'warning' | 'error' = 'success') => {
    if (alertTimeoutRef.current !== null) window.clearTimeout(alertTimeoutRef.current);
    setSystemAlert({ message, type });
    alertTimeoutRef.current = window.setTimeout(() => {
      setSystemAlert(null);
      alertTimeoutRef.current = null;
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
      title: `Research Stream ${sessions.length + 1}`,
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
    setActivePanelTab('chat');
    setIsNavigationOpen(false);
    showAlert("New local conversation created", "success");
  };

  const handleDeleteSession = (sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remains = sessions.filter(s => s.id !== sid);
    if (remains.length === 0) {
      const defaults = createDefaultSessions();
      setSessions(defaults);
      setActiveSessionId(defaults[0]?.id ?? '');
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
    if (!kernelAccessReady) {
      showAlert('Sign in from Overview before sending a protected agent request.', 'warning');
      return;
    }
    const workflow = beginAuthWorkflow();
    const workflowFetcher: RequestFetcher = (input, init) => fetchForAuthWorkflow(
      workflow,
      input,
      init,
    );

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
    setChatStage('routing');

    try {
      const chatMemories = await fetchPromotedKernelMemories(workflowFetcher);
      assertCurrentAuthWorkflow(workflow);
      const response = await workflowFetcher('/api/chat', {
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
        const message = await response.text();
        assertCurrentAuthWorkflow(workflow);
        throw new Error(message || 'Agent service failure');
      }

      const payload = await response.json();
      assertCurrentAuthWorkflow(workflow);
      setChatStage('recording');
      const matchedMems = chatMemories.filter(m => payload.retrievedMemoryIds?.includes(m.id));

      const assistantMsg: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: payload.responseContent,
        timestamp: new Date().toISOString(),
        parentId: userMsgId,
        childrenIds: [],
        retrievedMemories: matchedMems,
        provenance: (
          typeof payload.servedBy === 'string' &&
          typeof payload.model === 'string' &&
          typeof payload.evidenceEventId === 'string'
        ) ? {
          provider: payload.servedBy,
          model: payload.model,
          evidenceEventId: payload.evidenceEventId,
        } : undefined,
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
      setChatStage('extracting');
      const extractRes = await workflowFetcher('/api/extract', {
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
        assertCurrentAuthWorkflow(workflow);
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
            return workflowFetcher('/api/kernel/memories/candidates', {
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
          assertCurrentAuthWorkflow(workflow);
          createdCandidates = candidateResponses.filter((candidateResponse) => candidateResponse.ok).length;
        }
        if (createdCandidates > 0) {
          showAlert(`${createdCandidates} memory candidate${createdCandidates === 1 ? '' : 's'} awaiting review.`, 'success');
        }
      }

    } catch (error: unknown) {
      if (!isCurrentAuthWorkflow(workflow) || isAbortError(error)) return;
      console.error(error);
      showAlert(
        `Memory network error: ${error instanceof Error ? error.message : 'unknown error'}`,
        'error',
      );
    } finally {
      const current = isCurrentAuthWorkflow(workflow);
      finishAuthWorkflow(workflow);
      if (current) {
        setIsCochatting(false);
        setIsConsolidating(false);
        setChatStage('idle');
      }
    }
  };

  /**
   * MUTATE NOVEL RESEARCH INSIGHT
   */
  const handlePerformMutation = async () => {
    if (!mutationSourceText.trim() || isMutating) return;
    if (!kernelAccessReady) {
      showAlert('Sign in from Overview before requesting a provider research draft.', 'warning');
      return;
    }
    const workflow = beginAuthWorkflow();
    const workflowFetcher: RequestFetcher = (input, init) => fetchForAuthWorkflow(
      workflow,
      input,
      init,
    );
    setIsMutating(true);
    showAlert('Requesting a provider-generated research draft...', 'success');

    try {
      const contextMemories = await fetchPromotedKernelMemories(workflowFetcher);
      assertCurrentAuthWorkflow(workflow);
      const res = await workflowFetcher('/api/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: mutationSourceText.trim(),
          operator: mutationOperator,
          contextMemories
        })
      });

      if (!res.ok) {
        const message = await res.text();
        assertCurrentAuthWorkflow(workflow);
        throw new Error(message || 'Research draft request failed');
      }

      const data = await res.json();
      assertCurrentAuthWorkflow(workflow);
      
      const novelMutation: ResearchMutation = {
        id: `mutation_${Date.now()}`,
        title: data.title || 'Provider Research Draft',
        parentIdeaId: 'Research Lab',
        operator: mutationOperator,
        novelInsight: data.novelInsight || 'No conjecture was returned.',
        mathematicalBounds: data.mathematicalBounds || 'No proposed bounds were returned.',
        suggestedActionItems: data.suggestedActionItems || [],
        evidenceEventId: typeof data.evidenceEventId === 'string' ? data.evidenceEventId : '',
        createdAt: new Date().toISOString()
      };

      setActiveMutation(novelMutation);
      showAlert('Provider research draft recorded for operator review.', 'success');
    } catch (error: unknown) {
      if (!isCurrentAuthWorkflow(workflow) || isAbortError(error)) return;
      console.error(error);
      showAlert(
        `Research lab request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        'error',
      );
    } finally {
      const current = isCurrentAuthWorkflow(workflow);
      finishAuthWorkflow(workflow);
      if (current) setIsMutating(false);
    }
  };

  const commitMutationToMemory = async () => {
    if (!activeMutation || isSubmittingMutationRef.current) return;
    if (!kernelAccessReady) {
      showAlert('Sign in from Overview before submitting a memory candidate.', 'warning');
      return;
    }
    if (!activeMutation.evidenceEventId) {
      showAlert('Provider draft has no returned ledger reference and cannot be submitted.', 'error');
      return;
    }

    const workflow = beginAuthWorkflow();
    const mutation = activeMutation;
    const content = `[Provider Research Draft - ${mutation.title}]: ${mutation.novelInsight}. Proposed bounds: ${mutation.mathematicalBounds}`;
    isSubmittingMutationRef.current = true;
    setIsSubmittingMutation(true);
    try {
      const response = await fetchForAuthWorkflow(workflow, '/api/kernel/memories/candidates', {
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
            sourceId: mutation.evidenceEventId,
            actor: 'provider',
            observedAt: new Date().toISOString(),
          },
          evidenceRefs: [{ eventId: mutation.evidenceEventId }],
          contradictionIds: [],
          supersedesIds: [],
        }),
      });
      if (!response.ok) {
        const message = await response.text();
        assertCurrentAuthWorkflow(workflow);
        throw new Error(message || 'Candidate submission failed.');
      }
      assertCurrentAuthWorkflow(workflow);
      showAlert('Provider draft submitted as a memory candidate for evidence review.', 'success');
    } catch (error) {
      if (!isCurrentAuthWorkflow(workflow) || isAbortError(error)) return;
      showAlert(`Candidate submission failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    } finally {
      const current = isCurrentAuthWorkflow(workflow);
      finishAuthWorkflow(workflow);
      if (current) {
        isSubmittingMutationRef.current = false;
        setIsSubmittingMutation(false);
      }
    }
  };

  const handleRestoreDefaults = () => {
    if (window.confirm("Reset the local conversation workspace? Kernel state and authentication are preserved.")) {
      authEpochRef.current += 1;
      abortAuthenticatedWorkflows();
      localStorage.removeItem(STORAGE_KEYS.sessions);
      localStorage.removeItem(STORAGE_KEYS.activeSessionId);
      localStorage.removeItem(STORAGE_KEYS.framework);
      const defaults = createDefaultSessions();
      setSessions(defaults);
      setActiveSessionId(defaults[0]?.id ?? '');
      setAgentFramework('cartographer');
      setTargetBranchParentId(null);
      setMutationSourceText(DEFAULT_MUTATION_SOURCE);
      setIsMutating(false);
      isSubmittingMutationRef.current = false;
      setIsSubmittingMutation(false);
      setActiveMutation(null);
      showAlert("Local conversation workspace reset. Kernel state was not changed.", "success");
    }
  };

  const navigationItems: Array<{
    id: PanelTab;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={14} /> },
    { id: 'chat', label: 'Agent Chat', icon: <MessageSquare size={14} /> },
    { id: 'missions', label: 'Missions', icon: <Compass size={14} /> },
    { id: 'schedules', label: 'Schedules', icon: <CalendarClock size={14} /> },
    { id: 'desktop', label: 'Desktop', icon: <MonitorCog size={14} /> },
    { id: 'knowledge', label: 'Knowledge', icon: <BookOpen size={14} /> },
    { id: 'tree', label: 'Dialogue Map', icon: <Network size={14} /> },
    { id: 'mutator', label: 'Research Lab', icon: <Zap size={14} /> },
  ];
  const activeNavigationItem = navigationItems.find((item) => item.id === activePanelTab);

  return (
    <div
      className="relative flex h-dvh min-h-[640px] w-full overflow-hidden bg-[#080b10] font-sans text-slate-300"
      id="provenance_operator_cockpit"
    >
      
      {/* Alert Overlay Popup */}
      {systemAlert && (
        <div
          role={systemAlert.type === 'success' ? 'status' : 'alert'}
          aria-live={systemAlert.type === 'success' ? 'polite' : 'assertive'}
          className="absolute top-4 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-3.5 py-2.5 rounded-lg border shadow-2xl text-xs font-mono font-bold animate-fade-in bg-[#16181D]"
          style={{
          borderColor: systemAlert.type === 'success' ? '#0D9488' : systemAlert.type === 'warning' ? '#F59E0B' : '#EF4444',
          color: systemAlert.type === 'success' ? '#2DD4BF' : systemAlert.type === 'warning' ? '#FBBF24' : '#FCA5A5'
        }}>
          <Sparkles size={14} className="animate-spin text-teal-400" />
          <span>{systemAlert.message}</span>
        </div>
      )}

      {isNavigationOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/65 backdrop-blur-sm lg:hidden"
          onClick={() => setIsNavigationOpen(false)}
        />
      )}
      {isActivityOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm 2xl:hidden"
          onClick={() => setIsActivityOpen(false)}
        />
      )}

      {/* LEFT SIDEBAR (Stream list, storage diagnostics) */}
      <aside
        id="primary-navigation"
        aria-label="Conversation navigation"
        role={isNavigationOpen ? 'dialog' : undefined}
        aria-modal={isNavigationOpen || undefined}
        aria-hidden={isActivityOpen || undefined}
        inert={isActivityOpen || undefined}
        onKeyDown={isNavigationOpen ? trapDrawerFocus : undefined}
        className={`${isNavigationOpen ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-[min(18rem,88vw)] flex-col justify-between border-r border-slate-800 bg-[#0d1117] shadow-2xl lg:static lg:flex lg:w-64 lg:shrink-0 lg:shadow-none`}
      >
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Logo Branding */}
          <div className="flex items-center gap-3 border-b border-slate-800 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500 to-blue-700 shadow-lg shadow-cyan-500/10">
              <Network className="h-[18px] w-[18px] text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-bold tracking-tight text-white">Provenance</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400">Operator Cockpit</span>
            </div>
            <button
              ref={navigationCloseRef}
              type="button"
              onClick={() => setIsNavigationOpen(false)}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
              aria-label="Close conversation navigation"
            >
              <X size={16} />
            </button>
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
                  className={`group flex items-center justify-between rounded-lg border transition-all ${
                    isActive 
                      ? 'bg-[#16181D] border-slate-800 text-teal-400' 
                      : 'border-transparent text-slate-400 hover:bg-slate-800/20 hover:text-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setTargetBranchParentId(null);
                      setActivePanelTab('chat');
                      setIsNavigationOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-start gap-1.5 px-2.5 py-2.5 text-left"
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <GitBranch size={13} className={`mt-0.5 shrink-0 ${isActive ? 'text-teal-400' : 'text-slate-500'}`} />
                    <div className="min-w-0 overflow-hidden">
                      <span className="block truncate font-sans text-xs font-semibold leading-tight">
                        {session.title}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 font-mono text-[9.5px] text-slate-500">
                        {nodeCount} nodes
                      </span>
                    </div>
                  </button>
                  
                  <button
                    onClick={(e) => handleDeleteSession(session.id, e)}
                    className="mr-2 shrink-0 rounded p-1 text-slate-500 opacity-0 transition duration-200 hover:bg-slate-800 hover:text-rose-500 focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Delete ${session.title}`}
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
      <main
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[#080b10]"
        aria-label="Provenance workspace"
        aria-hidden={(isNavigationOpen || isActivityOpen) || undefined}
        inert={(isNavigationOpen || isActivityOpen) || undefined}
      >
        
        {/* Workspace Tab Navigation bar */}
        <header className="z-20 shrink-0 border-b border-slate-800 bg-[#0d1117]/95 backdrop-blur">
          <div className="flex min-h-16 items-center gap-3 px-3 sm:px-4">
            <button
              ref={navigationTriggerRef}
              type="button"
              onClick={() => setIsNavigationOpen(true)}
              className="rounded-lg border border-slate-800 bg-slate-900/70 p-2 text-slate-300 hover:border-slate-700 hover:text-white lg:hidden"
              aria-label="Open conversation navigation"
              aria-expanded={isNavigationOpen}
              aria-controls="primary-navigation"
            >
              <Menu size={17} />
            </button>

            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400">
                Trusted agent workspace
              </p>
              <h1 className="truncate text-sm font-bold text-white">{activeNavigationItem?.label ?? 'Overview'}</h1>
            </div>

            <button
              ref={activityTriggerRef}
              type="button"
              onClick={() => setIsActivityOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 2xl:hidden"
              aria-label="Open live agent activity"
              aria-expanded={isActivityOpen}
              aria-controls="agent-activity-inspector"
            >
              <Activity size={15} />
              <span className="hidden sm:inline">Live Activity</span>
            </button>
          </div>

          <nav
            className="overflow-x-auto border-t border-slate-800/70 px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-3"
            aria-label="Primary workspaces"
          >
            <div className="flex min-w-max gap-1">
              {navigationItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={activePanelTab === item.id ? 'page' : undefined}
                  onClick={() => {
                    if (item.id === 'missions') setMissionFocusId(null);
                    setActivePanelTab(item.id);
                    setTargetBranchParentId(null);
                  }}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    activePanelTab === item.id
                      ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-inset ring-cyan-500/30'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        </header>

        {activePanelTab === 'overview' && (
          <div className="flex-1 overflow-y-auto p-3 sm:p-6" role="region" aria-label="Overview">
            <div className="mx-auto max-w-6xl space-y-4">
              <section className="overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.08] via-[#10161f] to-blue-500/[0.05] p-5 sm:p-7">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div className="max-w-3xl">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">
                      Operations Overview
                    </p>
                    <h2 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
                      See what the agent is doing, what is blocked, and what evidence it produced.
                    </h2>
                    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
                      The Live Operations inspector is derived from authenticated kernel state. Browser and desktop cards show
                      the latest recorded target and action, not a fabricated video feed or private chain of thought.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsActivityOpen(true)}
                    className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/15 px-4 py-3 text-sm font-bold text-cyan-100 hover:bg-cyan-500/25 2xl:hidden"
                  >
                    <Activity size={17} />
                    Open Live Operations
                  </button>
                </div>
              </section>
              <AuthPanel />
              {kernelAccessReady ? (
                <>
                  <KernelPanel />
                  <RuntimePanel />
                  <ProviderPanel />
                  <LearningPanel />
                </>
              ) : (
                <KernelAccessNotice />
              )}
            </div>
          </div>
        )}

        {/* PANEL VIEW: 1. THE ARENA CHAT SYSTEM */}
        {activePanelTab === 'chat' && (
          <div className="flex-1 flex flex-col justify-between overflow-hidden" role="region" aria-label="Agent Chat">
            
            {/* Thread timeline scroll Area */}
            <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-4">
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
                        Branch from any response to explore an alternate conversation path. Each new assistant response shows its provider and the ledger reference returned by the server; this browser view does not independently reverify that reference.
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
                          disabled={isCochatting || !kernelAccessReady}
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
                        <span className="font-semibold text-slate-400">{isUser ? 'YOU' : 'PROVENANCE'}</span>
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
                      <div className="absolute right-3 top-3 opacity-0 transition-opacity duration-200 group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 flex items-center gap-1.5 bg-[#0B0C0E]/90 p-1 rounded border border-slate-800 shadow-xl z-10">
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
                            showAlert("Dialogue context transferred to Research Lab", "success");
                          }}
                          className="px-1.5 py-0.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded text-[9.5px] font-mono font-bold flex items-center gap-1 cursor-pointer transition"
                          title="Extract concept for math mutation"
                        >
                          <Zap size={9} />
                          Mutate
                        </button>
                      </div>

                      <p className="whitespace-pre-wrap font-sans leading-relaxed">{m.content}</p>

                      {!isUser && m.provenance && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-2.5 text-[10px]">
                          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-1 font-semibold text-violet-300">
                            Response record: {m.provenance.provider} / {m.provenance.model}
                          </span>
                          <span
                            className="font-mono text-slate-600"
                            title={`Server-returned ledger reference: ${m.provenance.evidenceEventId}. Not reverified in this browser view.`}
                          >
                            Ledger ref {m.provenance.evidenceEventId.slice(0, 12)} (not reverified)
                          </span>
                        </div>
                      )}

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
                    <span>OPERATIONAL STATUS</span>
                    <span>•</span>
                    <span className="text-teal-400 font-bold">Kernel-supervised request</span>
                  </div>
                  <div className="p-4 rounded-xl bg-[#16181D] border border-slate-850 text-xs text-slate-500 space-y-2 w-72">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 bg-teal-400 rounded-full animate-ping"></div>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400">
                        {chatStage === 'routing'
                          ? 'Routing through the provider policy'
                          : chatStage === 'recording'
                            ? 'Recording response evidence'
                            : chatStage === 'extracting'
                              ? 'Checking source-backed memory candidates'
                              : 'Waiting for kernel state'}
                      </span>
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
                  placeholder={!kernelAccessReady
                    ? 'Sign in from Overview to use the agent'
                    : isCochatting
                      ? 'Wait until pipeline resolves...'
                      : 'Interact with agent (e.g., "challenge my previous math theorem")'}
                  disabled={isCochatting || !kernelAccessReady}
                  className="w-full bg-[#0B0C0E] border border-slate-800 rounded-xl pl-4 pr-12 py-3.5 text-xs placeholder-slate-650 text-slate-200 focus:outline-[#1F232B] focus:border-teal-500 focus:outline-none transition-all focus:ring-1 focus:ring-teal-500"
                  id="chat_input_arena"
                />

                <button
                  onClick={() => handleSendMessage()}
                  disabled={isCochatting || !kernelAccessReady || !inputText.trim()}
                  className={`absolute right-2 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white font-bold transition rounded-lg flex items-center justify-center cursor-pointer ${
                    isCochatting || !kernelAccessReady || !inputText.trim()
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

        {/* PANEL VIEW: RESEARCH TO VERIFIED REPORT MISSIONS */}
        {activePanelTab === 'missions' && (
          <div className="flex-1 overflow-y-auto p-3 sm:p-6" role="region" aria-label="Research Missions">
            <div className="max-w-5xl mx-auto space-y-4">
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] px-4 py-3">
                <p className="text-xs font-semibold text-cyan-200">Mission Authority</p>
                <p className="mt-1 text-[11px] text-slate-500">Kernel-owned tasks, budgets, sources, and verification evidence.</p>
              </div>
              <AuthPanel />
              {kernelAccessReady
                ? <ResearchMissionPanel initialMissionId={missionFocusId} />
                : <KernelAccessNotice />}
            </div>
          </div>
        )}

        {/* PANEL VIEW: DURABLE RECURRING RESEARCH */}
        {activePanelTab === 'schedules' && (
          <div className="flex-1 overflow-y-auto p-3 sm:p-6" role="region" aria-label="Schedules">
            <div className="max-w-6xl mx-auto space-y-4">
              <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] px-4 py-3">
                <p className="text-xs font-semibold text-violet-200">Schedule Authority</p>
                <p className="mt-1 text-[11px] text-slate-500">Durable kernel timer, bounded occurrences, and explicit recovery controls.</p>
              </div>
              <AuthPanel />
              {kernelAccessReady ? (
                <RecurringResearchPanel onOpenMission={(missionId) => {
                  setMissionFocusId(missionId);
                  setActivePanelTab('missions');
                }} />
              ) : (
                <KernelAccessNotice />
              )}
            </div>
          </div>
        )}

        {/* PANEL VIEW: NATIVE WINDOWS UI AUTOMATION */}
        {activePanelTab === 'desktop' && (
          <div className="flex-1 overflow-y-auto p-3 sm:p-6" role="region" aria-label="Desktop">
            <div className="max-w-6xl mx-auto space-y-4">
              <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] px-4 py-3">
                <p className="text-xs font-semibold text-sky-200">Desktop Authority</p>
                <p className="mt-1 text-[11px] text-slate-500">Approval-gated native worker with authenticated UI Automation control maps.</p>
              </div>
              <AuthPanel />
              {kernelAccessReady ? <DesktopPanel /> : <KernelAccessNotice />}
            </div>
          </div>
        )}

        {activePanelTab === 'knowledge' && (
          <div className="min-h-0 flex-1 overflow-hidden" role="region" aria-label="Knowledge">
            <MemoryDashboard
              memories={memories}
              profile={profile}
              isConsolidating={isConsolidating}
              agentFramework={agentFramework}
              onSetAgentFramework={setAgentFramework}
            />
          </div>
        )}

        {/* PANEL VIEW: 2. INTERACTIVE DIALOGUE TREE & MIND MAP VISUALIZER */}
        {activePanelTab === 'tree' && (
          <div className="flex-1 p-3 sm:p-6 overflow-y-auto space-y-4" role="region" aria-label="Dialogue Map">
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
                              <button
                                key={child.id}
                                type="button"
                                onClick={() => handleJumpToNode(child.id)}
                                className={`w-full p-3.5 rounded-lg border text-left transition-all cursor-pointer relative group/node focus:outline-none focus:ring-2 focus:ring-teal-500/60 ${
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
                              </button>
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
          <div className="flex-1 p-3 sm:p-6 overflow-y-auto space-y-4" role="region" aria-label="Research Lab">
            {!kernelAccessReady && <KernelAccessNotice />}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Controls Column */}
              <div className="lg:col-span-5 space-y-4">
                <div className="bg-[#16181D] border border-slate-800 p-4.5 rounded-xl space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                    <Zap size={15} />
                    <span>Provider Research Draft</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed font-sans">
                    Apply a heuristic prompt transform to a premise and ask the configured provider for a speculative draft. The output is not an independently verified calculation, proof, or research finding.
                  </p>
                </div>

                {/* Input Premise form */}
                <div className="bg-[#16181D] border border-slate-800 rounded-xl p-4.5 space-y-3.5">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2 font-bold select-none">Source Conjecture / Premise:</label>
                    <textarea
                      value={mutationSourceText}
                      onChange={(e) => setMutationSourceText(e.target.value)}
                      disabled={!kernelAccessReady || isMutating}
                      className="w-full text-xs bg-[#0B0C0E] border border-slate-800 rounded-lg p-3 text-slate-200 focus:outline-none focus:border-amber-500 min-h-[140px] leading-relaxed font-sans"
                      placeholder="e.g. Non-Abelian Gauge theories with scalar lattices..."
                    />
                  </div>

                  {/* Operator grid */}
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2 font-bold select-none">Drafting Operator:</label>
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
                          disabled={!kernelAccessReady || isMutating}
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
                    disabled={!kernelAccessReady || isMutating || !mutationSourceText.trim()}
                    className={`w-full py-2.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                      !kernelAccessReady || isMutating || !mutationSourceText.trim()
                        ? 'bg-slate-800/20 text-slate-650'
                        : 'bg-amber-500 hover:bg-amber-600 active:scale-95 text-black font-black font-mono shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20'
                    }`}
                  >
                    <Zap size={13} className={isMutating ? 'animate-spin' : ''} />
                    {isMutating ? 'REQUESTING PROVIDER DRAFT...' : 'GENERATE PROVIDER DRAFT'}
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
                        <div className="text-[8px] text-slate-500 font-mono mt-1.5">DRAFT ID: {activeMutation.id}</div>
                      </div>
                      
                      <button
                        onClick={() => void commitMutationToMemory()}
                        disabled={!kernelAccessReady || isSubmittingMutation}
                        className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded text-xs font-semibold flex items-center gap-1 select-none transition cursor-pointer disabled:cursor-not-allowed"
                      >
                        <HardDrive size={12} />
                        {isSubmittingMutation ? 'Submitting Candidate...' : 'Submit Review Candidate'}
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
                        <span className="text-[9px] font-mono text-amber-400 uppercase tracking-wider block font-bold">MODEL-GENERATED CONJECTURE (UNVERIFIED)</span>
                        <p className="text-slate-300 text-xs leading-relaxed font-sans">{activeMutation.novelInsight}</p>
                      </div>

                      {/* Analytical bounds section */}
                      <div className="bg-[#0B0C0E]/40 border border-slate-850 p-3.5 rounded-lg space-y-1">
                        <span className="text-[9px] font-mono text-teal-400 uppercase tracking-wider block font-bold">MODEL-PROPOSED BOUNDS (NOT VERIFIED)</span>
                        <p className="text-slate-400 text-xs font-mono leading-relaxed">{activeMutation.mathematicalBounds}</p>
                      </div>

                      {/* Action item tracks */}
                      <div className="space-y-2">
                        <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block font-bold">Suggested Validation Directions:</span>
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

                      <p className="border-t border-slate-800/80 pt-3 text-[10px] leading-relaxed text-slate-500">
                        Local response record. Ledger ref{' '}
                        <span className="font-mono text-slate-400">
                          {activeMutation.evidenceEventId
                            ? activeMutation.evidenceEventId.slice(0, 16)
                            : 'not returned'}
                        </span>{' '}
                        was returned by the server and is not reverified in this browser view.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="border border-dashed border-slate-800 rounded-xl p-16 text-center bg-[#16181D]/30 flex flex-col items-center justify-center min-h-[450px]">
                    <Layers size={36} className="text-slate-650 mb-3" />
                    <span className="text-xs text-slate-400 font-bold block">No provider draft yet</span>
                    <span className="text-[11px] text-slate-550 font-sans block max-w-sm mx-auto leading-normal mt-1.5">
                      Generate a provider draft from a premise and heuristic operator. Review it as a hypothesis, not a calculation or proof.
                    </span>
                  </div>
                )}
              </div>
            </div>

          </div>
        )}

      </main>

      <AgentObservatory
        className={`${isActivityOpen ? 'flex' : 'hidden'} fixed inset-y-0 right-0 z-50 w-[min(24rem,100vw)] border-l border-slate-800 shadow-2xl 2xl:static 2xl:flex 2xl:w-[23rem] 2xl:shrink-0 2xl:shadow-none`}
        closeButtonRef={activityCloseRef}
        drawerOpen={isActivityOpen}
        enabled={kernelAccessReady}
        onClose={() => setIsActivityOpen(false)}
      />

    </div>
  );
}
