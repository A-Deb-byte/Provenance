/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  AgentFramework,
  MemoryItem,
  UserProfile,
  AgentSkill,
  AgentProviderConfig,
  ProviderName,
  SkillDraftActivity,
} from '../types';
import { withValidationResult } from '../lib/skillValidation';
import {
  isAgentProviderConfigArray,
  readJsonFromStorage,
  STORAGE_KEYS,
  writeJsonToStorage,
} from '../lib/persistence';
import { 
  Brain, Search, Plus, Trash2, Edit3, User, Check, X, 
  Sparkles, ShieldCheck, Tag, AlertCircle, Info, BarChart3,
  Flame, Cpu, Command, Settings, Activity, GraduationCap, CheckCircle2,
  ChevronRight, Terminal, Key, Play, RefreshCw, Award, Code
} from 'lucide-react';
import { 
  ResponsiveContainer, PieChart, Pie, Cell, 
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid 
} from 'recharts';

interface MemoryDashboardProps {
  memories: MemoryItem[];
  profile: UserProfile;
  onAddMemory: (content: string, category: MemoryItem['category'], importance: number) => void;
  onDeleteMemory: (id: string) => void;
  onEditMemory: (id: string, updatedContent: string, importance: number) => void;
  onUpdateBio: (newBio: string) => void;
  isConsolidating: boolean;
  agentFramework: AgentFramework;
  onSetAgentFramework: (framework: AgentFramework) => void;
}

const defaultProviders: AgentProviderConfig[] = [
  { provider: 'gemini', modelName: 'gemini-3.5-flash', isEnabled: true, credentialMode: 'server_env' },
  { provider: 'openai', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
  { provider: 'deepseek', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
  { provider: 'openrouter', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
  { provider: 'glm', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
  { provider: 'aws', modelName: 'not-configured', isEnabled: false, credentialMode: 'not_configured' },
];

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

export default function MemoryDashboard({
  memories,
  profile,
  onAddMemory,
  onDeleteMemory,
  onEditMemory,
  onUpdateBio,
  isConsolidating,
  agentFramework,
  onSetAgentFramework
}: MemoryDashboardProps) {
  // Navigation panel tab layout state
  const [panelTab, setPanelTab] = useState<'fragments' | 'analytics' | 'framework' | 'autonomous'>('fragments');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [bioInput, setBioInput] = useState(profile.bio);

  // New Memory input controls
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MemoryItem['category']>('preferences');
  const [newImportance, setNewImportance] = useState(3);

  // In-line memory editing state
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editImportance, setEditImportance] = useState(3);

  // ==========================================
  // AUTONOMOUS AI AGENT STATES
  // ==========================================
  const [autonomousSkills, setAutonomousSkills] = useState<AgentSkill[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.skills);
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved) as AgentSkill[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((skill) => skill.id !== 'skill_homology' && skill.id !== 'skill_bounds');
    } catch {
      return [];
    }
  });

  const [providers, setProviders] = useState<AgentProviderConfig[]>(() =>
    readJsonFromStorage(STORAGE_KEYS.providers, defaultProviders, isAgentProviderConfigArray)
  );

  const [selectedProvider, setSelectedProvider] = useState<ProviderName>('gemini');
  const [targetImprovementTask, setTargetImprovementTask] = useState('');
  const [isImproving, setIsImproving] = useState(false);
  const [currentTerminalLogs, setCurrentTerminalLogs] = useState<string[]>([]);
  const [skillDraftLogs, setSkillDraftLogs] = useState<SkillDraftActivity[]>(() =>
    readJsonFromStorage(STORAGE_KEYS.skillDrafts, [], isSkillDraftActivityArray)
  );
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [isExecutingLocalTest, setIsExecutingLocalTest] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Persistence triggers
  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.skills, autonomousSkills);
  }, [autonomousSkills]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.providers, providers);
  }, [providers]);

  useEffect(() => {
    writeJsonToStorage(STORAGE_KEYS.skillDrafts, skillDraftLogs);
  }, [skillDraftLogs]);

  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentTerminalLogs]);

  const handleSaveBio = () => {
    onUpdateBio(bioInput);
    setIsEditingBio(false);
  };

  const handleCreateMemory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;
    onAddMemory(newContent.trim(), newCategory, newImportance);
    setNewContent('');
    setNewImportance(3);
    setShowAddForm(false);
  };

  const startEditMemory = (m: MemoryItem) => {
    setEditingMemoryId(m.id);
    setEditContent(m.content);
    setEditImportance(m.importance);
  };

  const saveEditMemory = (id: string) => {
    if (!editContent.trim()) return;
    onEditMemory(id, editContent, editImportance);
    setEditingMemoryId(null);
  };

  const filteredMemories = memories.filter(m => {
    const matchesSearch = m.content.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          m.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          m.source.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || m.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getCategoryTheme = (cat: MemoryItem['category']) => {
    switch (cat) {
      case 'personal':
        return { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/25', hex: '#F59E0B' };
      case 'technical':
        return { badge: 'bg-blue-500/10 text-blue-400 border-blue-500/25', hex: '#3B82F6' };
      case 'work':
        return { badge: 'bg-purple-500/10 text-purple-400 border-purple-500/25', hex: '#A855F7' };
      case 'preferences':
        return { badge: 'bg-teal-500/10 text-teal-400 border-teal-500/25', hex: '#14B8A6' };
      default:
        return { badge: 'bg-slate-700/30 text-slate-400 border-slate-700/30', hex: '#64748B' };
    }
  };

  // Recharts Category Distribution Data
  const categories: MemoryItem['category'][] = ['preferences', 'technical', 'personal', 'work', 'general'];
  const chartCategoryData = categories.map(cat => ({
    name: cat.toUpperCase(),
    value: memories.filter(m => m.category === cat).length,
    color: getCategoryTheme(cat).hex
  })).filter(item => item.value > 0);

  // Recharts Importance Scores Over Time Data (Sorted chronologically)
  const chartTimelineData = [...memories]
    .filter(m => m.createdAt)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((m, index) => {
      const dt = new Date(m.createdAt);
      const timeStr = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + 
                      ' ' + dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      return {
        sequence: index + 1,
        timeLabel: timeStr,
        importance: m.importance,
        name: m.content.length > 25 ? m.content.substring(0, 25) + '...' : m.content,
        category: m.category.toUpperCase()
      };
    });

  // Recharts draft validation history over time
  const skillDraftTrendData = skillDraftLogs.map((log, index) => ({
    label: `Draft #${index + 1}`,
    validation: log.verificationStatus === 'deterministic_validation_passed' ? 1 : 0,
    skillsCount: autonomousSkills.length,
  }));

  // Helper to trigger candidate skill drafting
  const executeSelfImprovementLoop = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetImprovementTask.trim() || isImproving) return;

    setIsImproving(true);
    setCurrentTerminalLogs([]);

    const bootLogs = [
      `[DRAFT_INIT]: Requesting a candidate skill draft from the server-side Gemini adapter.`,
      `[ROUTER]: Active provider label - ${selectedProvider.toUpperCase()} (${providers.find(p=>p.provider===selectedProvider)?.modelName || 'not-configured'})`,
      `[SKILL_GAP]: Draft requested for: "${targetImprovementTask}"`,
      `[VALIDATION_POLICY]: Generated code will remain a draft until deterministic local validation passes.`
    ];

    for (let i = 0; i < bootLogs.length; i++) {
      await new Promise(r => setTimeout(r, 600));
      setCurrentTerminalLogs(prev => [...prev, bootLogs[i]]);
    }

    try {
      const selectedProvObj = providers.find(p => p.provider === selectedProvider);
      
      const response = await fetch('/api/self-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: targetImprovementTask,
          activeSkills: autonomousSkills,
          provider: selectedProvider,
          providerConfig: selectedProvObj || {}
        })
      });

      if (!response.ok) {
        throw new Error(`Execution error: Received status ${response.status}`);
      }

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
    } catch (err: any) {
      console.error(err);
      setCurrentTerminalLogs(prev => [
        ...prev,
        `[FATAL_ERROR]: Pipeline execution failed: ${err.message || 'Check connection context.'}`,
        `[ROLLBACK]: Draft workspace state preserved.`
      ]);
    } finally {
      setIsImproving(false);
    }
  };

  // Run dynamic unit testing assert triggers
  const executeLocalSkillTest = async (skill: AgentSkill) => {
    if (isExecutingLocalTest) return;
    setIsExecutingLocalTest(true);
    
    await new Promise(r => setTimeout(r, 300));

    setAutonomousSkills(prev =>
      prev.map(s => (s.id === skill.id ? withValidationResult(s) : s))
    );

    setIsExecutingLocalTest(false);
  };

  const handleToggleProvider = (prov: ProviderName) => {
    setProviders(prev => 
      prev.map(p => ({
        ...p,
        isEnabled: p.provider === prov
      }))
    );
    setSelectedProvider(prov);
  };

  const activeSkill = autonomousSkills.find(s => s.id === selectedSkillId) || autonomousSkills[0];

  const frameworksMetadata = {
    cartographer: {
      title: 'Cartographer Memory Mapper',
      description: 'High structural density parsing and vector mapping. Emphasizes category theory, relational hierarchies, lattice models, and graph analogies.',
      temperature: '0.12 (Sober Structure)',
      contextWindow: 'Dual-Pass 128k',
      planningStages: 'Categorical Alignment Cycle',
      badge: 'border-teal-500/35 text-teal-300 bg-teal-500/10'
    },
    prover: {
      title: 'Prover Stepwise Reasoner',
      description: 'Chain-of-evidence mathematical derivation. Dynamically constructs detailed step-by-step reasoning traces and logical formulas.',
      temperature: '0.28 (Step-wise Explore)',
      contextWindow: 'Continuous Feed 64k',
      planningStages: 'Axiomatic Decomposition',
      badge: 'border-blue-500/35 text-blue-300 bg-blue-500/10'
    },
    archivist: {
      title: 'Archivist Evidence Synthesizer',
      description: 'Rapid hypothesis synthesis and robust source citations. Focuses on dense academic taxonomies and precise conceptual definitions.',
      temperature: '0.05 (Rigid Citation)',
      contextWindow: 'Dynamic Retrieval 32k',
      planningStages: 'Grounding Verification Loop',
      badge: 'border-purple-500/35 text-purple-300 bg-purple-500/10'
    },
    sentinel: {
      title: 'Sentinel Adversarial Verifier',
      description: 'Deep physical and mathematical stress-testing. Challenges basic user and model assumptions, searching for edge cases and design bounds.',
      temperature: '0.45 (Boundary Pressure)',
      contextWindow: 'Adversarial 64k',
      planningStages: 'Counter-Example Synthesis',
      badge: 'border-amber-500/35 text-amber-300 bg-amber-500/10'
    }
  };

  const activeMetadata = frameworksMetadata[agentFramework] || frameworksMetadata.cartographer;

  return (
    <div className="flex flex-col h-full bg-[#0F1115] border-l border-slate-800" id="memory_dashboard">
      {/* Dashboard Header */}
      <div className="p-4 border-b border-slate-800 bg-[#0B0C0E]/90 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="bg-teal-600/20 text-teal-400 p-2 rounded-lg border border-teal-500/20 shadow-inner">
            <Brain size={18} />
          </div>
          <div>
            <h2 className="font-sans font-semibold text-slate-100 tracking-tight text-sm">Cognitive Control Hub</h2>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse"></span>
              {agentFramework.toUpperCase()} ENGINE LIVE
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 text-teal-400 px-2 py-0.5 rounded text-[9px] font-mono leading-none">
          <ShieldCheck size={10} />
          <span>Local Index</span>
        </div>
      </div>

      {/* Primary Tabs Navigation */}
      <div className="grid grid-cols-4 border-b border-slate-800/80 bg-[#0B0C0E]/40 p-1 select-none shrink-0" id="dashboard_tabs">
        <button
          onClick={() => setPanelTab('fragments')}
          className={`py-1.5 text-center rounded-md font-mono text-[9px] uppercase font-bold tracking-tight transition ${
            panelTab === 'fragments'
              ? 'bg-[#16181D] text-teal-400 shadow border border-slate-800'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#16181D]/30'
          }`}
        >
          Frag ({memories.length})
        </button>
        <button
          onClick={() => setPanelTab('analytics')}
          className={`py-1.5 text-center rounded-md font-mono text-[9px] uppercase font-bold tracking-tight transition ${
            panelTab === 'analytics'
              ? 'bg-[#16181D] text-teal-400 shadow border border-slate-800'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#16181D]/30'
          }`}
        >
          Stats
        </button>
        <button
          onClick={() => setPanelTab('framework')}
          className={`py-1.5 text-center rounded-md font-mono text-[9px] uppercase font-bold tracking-tight transition ${
            panelTab === 'framework'
              ? 'bg-[#16181D] text-teal-400 shadow border border-slate-800'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#16181D]/30'
          }`}
        >
          Frame
        </button>
        <button
          onClick={() => setPanelTab('autonomous')}
          className={`py-1.5 text-center rounded-md font-mono text-[9px] uppercase font-bold tracking-tight transition ${
            panelTab === 'autonomous'
              ? 'bg-[#16181D] text-amber-400 shadow border border-amber-900/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#16181D]/30'
          }`}
        >
          Auto AI
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ========================================================
            TAB 1: FRAGMENTS VAULT VIEW
            ======================================================== */}
        {panelTab === 'fragments' && (
          <div className="space-y-4 animate-fade-in text-xs">
            {/* Bio Summary Card */}
            <div className="bg-[#16181D] rounded-xl border border-slate-800 p-4 shadow-xl relative overflow-hidden" id="user-profile-bio">
              <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-teal-500/5 to-transparent -mr-6 -mt-6 rounded-full pointer-events-none" />
              
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-800/60">
                <div className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider text-slate-500">
                  <User size={12} className="text-teal-500" />
                  <span>Synthesized User Profile</span>
                </div>
                
                {!isEditingBio && (
                  <button 
                    onClick={() => { setBioInput(profile.bio); setIsEditingBio(true); }}
                    className="text-[10px] font-mono text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-colors"
                  >
                    <Edit3 size={10} />
                    Edit Bio
                  </button>
                )}
              </div>

              {isEditingBio ? (
                <div className="space-y-2 mt-2">
                  <textarea
                    value={bioInput}
                    onChange={(e) => setBioInput(e.target.value)}
                    className="w-full text-xs font-sans text-slate-200 border border-slate-700 bg-[#0B0C0E] rounded-lg p-2 focus:ring-1 focus:ring-teal-500 focus:border-teal-500 focus:outline-none min-h-[80px]"
                    placeholder="Write a custom user core identity trace..."
                  />
                  <div className="flex justify-end gap-1.5">
                    <button 
                      onClick={() => setIsEditingBio(false)}
                      className="px-2 py-0.5 rounded text-[10px] border border-slate-805 text-slate-400 hover:bg-slate-850 transition"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleSaveBio}
                      className="px-2 py-0.5 bg-teal-600 hover:bg-teal-700 text-white rounded text-[10px] font-medium transition"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  <p className="text-xs text-slate-300 leading-relaxed font-sans font-medium italic">
                    {profile.bio || "No overarching dynamic profile synthesized yet. Begin detailing facts or chat with the memory loop agent."}
                  </p>
                  {profile.lastSummaryUpdate && (
                    <div className="flex items-center gap-1 text-[9px] text-[#2DD4BF] font-mono mt-3 bg-teal-500/5 border border-teal-500/10 w-fit px-2 py-0.5 rounded">
                      <Sparkles size={8} className="animate-pulse" />
                      <span>Gemini extraction active</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Consolidation Spinner */}
            {isConsolidating && (
              <div className="p-3 bg-teal-950/20 border border-teal-500/30 rounded-xl flex items-center gap-3 animate-fade-in shadow-inner">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500"></span>
                </span>
                <div className="text-[11px] text-teal-300 font-sans">
                  <span className="font-semibold">Memory Consolidation Loop:</span> Synthesizing user facts.
                </div>
              </div>
            )}

            {/* Knowledge Explorer Toolbar */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={13} />
                  <input
                    type="text"
                    placeholder="Search memory vault indexes..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1 text-xs border border-slate-880 bg-[#0B0C0E]/95 placeholder-slate-650 rounded-lg text-slate-200 focus:outline-none focus:border-teal-500 transition-colors"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                      <X size={11} />
                    </button>
                  )}
                </div>
                
                <button
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="px-2 py-1 bg-teal-600/90 hover:bg-teal-600 text-white text-xs font-bold rounded-lg flex items-center gap-0.5 transition-all active:scale-95 cursor-pointer shrink-0"
                >
                  <Plus size={13} />
                  Add
                </button>
              </div>

              {/* Category Filter Chips */}
              <div className="flex flex-wrap gap-1">
                {['all', 'preferences', 'technical', 'personal', 'work'].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider border transition cursor-pointer select-none ${
                      selectedCategory === cat 
                        ? 'bg-teal-600/20 text-[#2DD4BF] border-teal-500/40 font-bold'
                        : 'bg-[#16181D]/40 hover:bg-[#16181D] text-slate-400 border-slate-800/80 hover:text-slate-250'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Manual ADD memory form */}
            {showAddForm && (
              <form onSubmit={handleCreateMemory} className="bg-[#16181D] border-l-2 border-amber-500 border-y border-r border-slate-850 rounded-xl p-3 space-y-3 shadow-2xl animate-fade-in text-xs">
                <div className="flex items-center justify-between border-b border-slate-850 pb-1.5">
                  <div className="flex items-center gap-1 text-[10px] font-bold text-amber-400 font-mono">
                    <Sparkles size={11} className="text-amber-500" />
                    <span>MUTATE CORE: ADD EXPLICIT FACT</span>
                  </div>
                  <button type="button" onClick={() => setShowAddForm(false)} className="text-slate-500 hover:text-slate-300">
                    <X size={11} />
                  </button>
                </div>

                <div className="space-y-2">
                  <div>
                    <label className="block text-[9px] font-mono uppercase text-slate-500 mb-0.5 font-bold">Explicit Fact Statement:</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Prefers functional programming over class paradigms..."
                      value={newContent}
                      onChange={(e) => setNewContent(e.target.value)}
                      className="w-full text-xs bg-[#0B0C0E] text-slate-200 border border-slate-850 rounded-md p-1.5 focus:outline-none focus:border-amber-550"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[9px] font-mono uppercase text-slate-500 mb-0.5 font-bold">Category:</label>
                      <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value as MemoryItem['category'])}
                        className="w-full text-xs bg-[#0B0C0E] text-slate-305 border border-slate-850 rounded-md p-1 focus:outline-none"
                      >
                        <option value="preferences">Preferences</option>
                        <option value="technical">Technical</option>
                        <option value="personal">Personal</option>
                        <option value="work">Work</option>
                        <option value="general">General</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[9px] font-mono uppercase text-slate-500 mb-0.5 font-bold">Importance (1-5):</label>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((val) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => setNewImportance(val)}
                            className={`w-5.5 h-5.5 text-[10px] rounded font-mono font-bold transition flex items-center justify-center ${
                              newImportance === val 
                                ? 'bg-amber-500 text-[#0F1115]' 
                                : 'bg-[#0B0C0E] hover:bg-slate-805 text-amber-500/70 border border-slate-850'
                            }`}
                          >
                            {val}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAddForm(false)}
                      className="px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-2.5 py-0.5 bg-amber-500 hover:bg-amber-600 text-black rounded text-[10px] font-bold transition shadow-md"
                    >
                      Record
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* Local memories list */}
            <div className="space-y-2">
              <div className="text-[9px] font-bold font-mono text-slate-500 uppercase tracking-widest mb-1 pb-1 border-b border-slate-850 flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Tag size={11} className="text-teal-500" />
                  <span>Vault Fragments ({filteredMemories.length})</span>
                </span>
                <span className="font-mono text-[80%] text-teal-500/80">LOCAL STORAGE</span>
              </div>

              {filteredMemories.length === 0 ? (
                <div className="bg-[#16181D]/40 border border-dashed border-slate-800 rounded-xl p-6 text-center">
                  <Info className="mx-auto text-slate-600 mb-1" size={16} />
                  <p className="text-xs text-slate-550">No matching indexed fragments.</p>
                  <p className="text-[9px] text-slate-650 mt-0.5 font-mono">Category: {selectedCategory}</p>
                </div>
              ) : (
                filteredMemories.map((m) => {
                  const isEditing = editingMemoryId === m.id;
                  const catTheme = getCategoryTheme(m.category);
                  
                  return (
                    <div 
                      key={m.id} 
                      className={`bg-[#16181D] rounded-xl border p-3.5 transition-all relative group shadow-sm hover:border-slate-700/80 ${
                        isEditing ? 'border-teal-500 ring-1 ring-teal-500/30 bg-[#0F1115]' : 'border-slate-850/80'
                      }`}
                    >
                      {isEditing ? (
                        /* Inline Edit view */
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center justify-between border-b border-slate-850 pb-1">
                            <span className="text-[8.5px] font-bold text-teal-400 uppercase font-mono">EDIT CHRONO INDEX</span>
                            <div className="flex gap-1">
                              <button 
                                onClick={() => saveEditMemory(m.id)}
                                className="bg-teal-500/10 text-teal-400 border border-teal-500/20 p-0.5 rounded hover:bg-teal-500/20"
                              >
                                <Check size={11} />
                              </button>
                              <button 
                                onClick={() => setEditingMemoryId(null)}
                                className="bg-rose-500/10 text-rose-400 border border-rose-500/20 p-0.5 rounded hover:bg-rose-500/20"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              className="w-full text-xs font-sans border border-slate-850 rounded p-1.5 focus:outline-none focus:border-teal-500 bg-[#0B0C0E] text-slate-200 min-h-[45px]"
                            />
                            
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] text-slate-400 font-mono">Importance Rank:</span>
                              <div className="flex gap-1">
                                {[1, 2, 3, 4, 5].map((val) => (
                                  <button
                                    key={val}
                                    type="button"
                                    onClick={() => setEditImportance(val)}
                                    className={`w-5 h-5 text-[9px] rounded font-mono font-bold flex items-center justify-center transition ${
                                      editImportance === val ? 'bg-teal-500 text-[#0F1115]' : 'bg-[#0B0C0E] text-slate-400 border border-slate-850'
                                    }`}
                                  >
                                    {val}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Standard View */
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold font-mono tracking-wider uppercase border ${catTheme.badge}`}>
                              {m.category}
                            </span>
                            
                            <div className="flex items-center gap-1.5 shrink-0">
                              <div className="flex gap-0.5" title={`Importance Rank: ${m.importance}`}>
                                {[1, 2, 3, 4, 5].map((s) => (
                                  <span 
                                    key={s} 
                                    className={`w-1 h-1 rounded-full ${
                                      s <= m.importance ? 'bg-teal-400' : 'bg-slate-800'
                                    }`}
                                  />
                                ))}
                              </div>

                              <div className="md:opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-150">
                                <button 
                                  onClick={() => startEditMemory(m)}
                                  className="text-slate-500 hover:text-teal-400 p-0.5 hover:bg-[#0B0C0E] rounded transition"
                                  title="Edit Block"
                                >
                                  <Edit3 size={10} />
                                </button>
                                <button 
                                  onClick={() => onDeleteMemory(m.id)}
                                  className="text-slate-550 hover:text-rose-400 p-0.5 hover:bg-[#0B0C0E] rounded transition"
                                  title="Wipe Fragment"
                                >
                                  <Trash2 size={10} />
                                </button>
                              </div>
                            </div>
                          </div>

                          <p className="text-slate-200 font-sans leading-relaxed break-words pr-2 font-normal text-xs">
                            {m.content}
                          </p>

                          {m.source && (
                            <div className="mt-1.5 pt-1.5 border-t border-slate-850/60 flex items-start gap-1 font-mono text-[8.5px] text-slate-500">
                              <AlertCircle size={9} className="mt-0.5 shrink-0 text-teal-600" />
                              <span className="italic truncate text-slate-500/90" title={m.source}>{m.source}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ========================================================
            TAB 2: COGNITIVE ANALYTICS VIEW (RECHARTS)
            ======================================================== */}
        {panelTab === 'analytics' && (
          <div className="space-y-4 animate-fade-in">
            {memories.length === 0 ? (
              <div className="bg-[#16181D]/40 border border-dashed border-slate-800 rounded-xl p-8 text-center text-xs">
                <BarChart3 className="mx-auto text-slate-600 mb-2" size={24} />
                <p className="text-slate-400 font-medium font-sans">Analytics Pipeline Ready</p>
                <p className="text-slate-550 mt-1 font-mono text-[10px] leading-relaxed max-w-xs mx-auto">
                  Analytics will activate as soon as fragments are committed. Feed facts or send chat logs.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                
                {/* Metric Summary Rings */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-[#14161D] border border-slate-850 p-3 rounded-xl">
                    <span className="text-[8.5px] font-mono text-slate-500 uppercase tracking-wider block">Cognitive Volume</span>
                    <span className="text-xl font-bold text-slate-100 font-mono tracking-tight block mt-0.5">{memories.length}</span>
                    <span className="text-[8px] font-mono text-[#2DD4BF] block mt-1">Fragments Indexed</span>
                  </div>
                  <div className="bg-[#14161D] border border-slate-850 p-3 rounded-xl">
                    <span className="text-[8.5px] font-mono text-slate-500 uppercase tracking-wider block">Average Weight</span>
                    <span className="text-xl font-bold text-slate-100 font-mono tracking-tight block mt-0.5">
                      {(memories.reduce((acc, m) => acc + m.importance, 0) / memories.length).toFixed(1)}/5.0
                    </span>
                    <span className="text-[8px] font-mono text-amber-400 block mt-1">Fact Persistence Rank</span>
                  </div>
                </div>

                {/* CHART A: Category Distribution Pie Chart */}
                <div className="bg-[#16181D] border border-slate-850 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center gap-1 border-b border-slate-850 pb-1.5 mb-1 bg-no-repeat">
                    <Tag size={12} className="text-teal-400" />
                    <span className="text-[9.5px] font-bold font-mono text-slate-300 uppercase tracking-wider">CATEGORY TAXONOMY</span>
                  </div>
                  
                  <div className="h-44 w-full flex items-center justify-center relative">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={chartCategoryData}
                          cx="50%"
                          cy="50%"
                          innerRadius={38}
                          outerRadius={56}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {chartCategoryData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: '#0F1115', 
                            border: '1px solid #1F2937',
                            borderRadius: '8px',
                            fontSize: '9px',
                            fontFamily: 'monospace',
                            color: '#F3F4F6',
                            padding: '6px'
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    
                    {/* Ring Label overlay */}
                    <div className="absolute flex flex-col items-center justify-center select-none pointer-events-none">
                      <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider">Active</span>
                      <span className="text-sm font-bold text-slate-200 font-mono mt-0.5">{chartCategoryData.length}</span>
                    </div>
                  </div>

                  {/* Legend representation */}
                  <div className="grid grid-cols-2 gap-1.5 pt-1.5 text-[8.5px] font-mono border-t border-slate-800/40">
                    {chartCategoryData.map((entry) => (
                      <div key={entry.name} className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                        <span className="text-slate-400 capitalize">{entry.name.toLowerCase()}:</span>
                        <span className="text-slate-200 font-bold ml-auto">{entry.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* CHART B: Importance Scores Chronogenetic Trend Area Chart */}
                <div className="bg-[#16181D] border border-[#1E2129] rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between border-b border-slate-850 pb-1.5 mb-1">
                    <div className="flex items-center gap-1">
                      <Activity size={12} className="text-rose-400" />
                      <span className="text-[9.5px] font-bold font-mono text-slate-300 uppercase tracking-wider">IMPORTANCE CHRONO PROFILE</span>
                    </div>
                    <span className="text-[8px] text-slate-500 font-mono tracking-tighter">TIME SERIES</span>
                  </div>

                  <div className="h-44 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartTimelineData}
                        margin={{ top: 5, right: 5, left: -25, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient id="colorImportance" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#2DD4BF" stopOpacity={0.25}/>
                            <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0.0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" vertical={false} />
                        <XAxis 
                          dataKey="sequence" 
                          stroke="#4B5563" 
                          fontSize={8} 
                          fontFamily="monospace"
                          tickLine={false}
                        />
                        <YAxis 
                          domain={[1, 5]} 
                          tickCount={5} 
                          stroke="#4B5563" 
                          fontSize={8} 
                          fontFamily="monospace"
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              const curr = payload[0].payload;
                              return (
                                <div className="bg-[#0F1115] border border-slate-800 p-2 rounded-lg text-[8px] font-mono shadow-2xl max-w-xs space-y-0.5 text-slate-200">
                                  <div className="text-slate-550 flex justify-between gap-2.5">
                                    <span>#{curr.sequence}</span>
                                    <span>{curr.timeLabel}</span>
                                  </div>
                                  <div className="text-teal-400 font-bold">Category: {curr.category}</div>
                                  <div className="text-amber-400 font-bold">Importance: {curr.importance}/5</div>
                                  <div className="text-slate-350 italic truncate border-t border-slate-800 pt-1 mt-1 leading-normal max-w-[140px] whitespace-normal">
                                    {curr.name}
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Area 
                          type="monotone" 
                          dataKey="importance" 
                          stroke="#0D9488" 
                          strokeWidth={1.5}
                          fillOpacity={1} 
                          fill="url(#colorImportance)" 
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="text-center font-mono text-[8px] text-slate-500 pt-1">
                    Index sequence order of committed memory events over time
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* ========================================================
            TAB 3: AGENTIC FRAMEWORK SWITCHER VIEW
            ======================================================== */}
        {panelTab === 'framework' && (
          <div className="space-y-4 animate-fade-in text-xs">
            <div className="bg-[#14161D] border border-slate-850 p-4.5 rounded-xl space-y-2">
              <div className="flex items-center gap-1 text-teal-400">
                <Cpu size={14} className="animate-spin duration-3000" />
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider">Cognitive Pipeline Router</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed font-sans font-medium">
                Exchange the active cognitive framework beneath the memory indexes. Each framework changes how the Gemini API queries your memory and stylizes its logical deductions.
              </p>
            </div>

            {/* Framework Selectors Ring */}
            <div className="space-y-2">
              {[
                { id: 'cartographer', title: 'Cartographer Memory Mapper', label: 'TAXONOMIC DEPTH', color: 'border-teal-500/25 text-teal-400' },
                { id: 'prover', title: 'Prover Stepwise Reasoner', label: 'PROOFS & TRACES', color: 'border-blue-500/25 text-blue-400' },
                { id: 'archivist', title: 'Archivist Evidence Synthesizer', label: 'GROUNDED INTEGRATION', color: 'border-purple-500/25 text-purple-400' },
                { id: 'sentinel', title: 'Sentinel Adversarial Verifier', label: 'SKEPTICAL PRESSURE', color: 'border-amber-500/25 text-amber-400' }
              ].map((fw) => (
                <button
                  key={fw.id}
                  onClick={() => onSetAgentFramework(fw.id as any)}
                  className={`w-full text-left p-3.5 rounded-xl border transition select-none flex items-start gap-3 cursor-pointer ${
                    agentFramework === fw.id
                      ? 'bg-slate-900 border-teal-500'
                      : 'bg-[#16181D]/60 border-slate-850 hover:bg-[#16181D]'
                  }`}
                >
                  <span className={`w-3.5 h-3.5 rounded-full mt-1 border flex items-center justify-center shrink-0 ${
                    agentFramework === fw.id ? 'border-teal-400' : 'border-slate-700'
                  }`}>
                    {agentFramework === fw.id && <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />}
                  </span>

                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-sans font-bold text-slate-100">{fw.title}</span>
                      <span className="text-[7.5px] font-mono uppercase bg-slate-950 px-1.5 py-0.5 rounded tracking-widest text-[#64748B] font-bold border border-slate-800">
                        {fw.id}
                      </span>
                    </div>
                    <span className="text-[9px] font-mono tracking-wider block" style={{ color: agentFramework === fw.id ? '#14B8A6' : '#64748B' }}>
                      {fw.label}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Active Framework Detailed Technical Specs Card */}
            <div className={`border rounded-xl p-4.5 bg-[#16181D] space-y-3 shadow-2xl relative overflow-hidden transition-all duration-300 border-slate-805`}>
              <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-teal-500/5 to-transparent pointer-events-none -mr-4 -mt-4 rounded-full" />
              
              <div className="flex items-center gap-1.5 border-b border-slate-800/80 pb-2 mb-1.5">
                <Settings size={12} className="text-slate-400" />
                <span className="text-[9.5px] font-bold font-mono text-slate-300 uppercase tracking-wider">ACTIVE PIPELINE CHARACTERISTICS</span>
              </div>

              <div className="space-y-2">
                <div>
                  <span className="text-[8.5px] font-mono text-slate-500 uppercase tracking-widest block font-bold">Architectural Directives:</span>
                  <p className="text-xs text-slate-350 leading-relaxed font-sans mt-0.5 font-medium">
                    {activeMetadata.description}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="bg-[#0B0C0E]/60 border border-slate-850 p-2 rounded-lg">
                    <span className="text-[8px] font-mono text-slate-500 uppercase block font-bold">COGNITIVE TEMPERATURE</span>
                    <span className="text-[10px] font-mono text-slate-200 block mt-0.5 font-bold">{activeMetadata.temperature}</span>
                  </div>
                  <div className="bg-[#0B0C0E]/60 border border-slate-850 p-2 rounded-lg">
                    <span className="text-[8px] font-mono text-slate-500 uppercase block font-bold">CONTEXT HORIZON</span>
                    <span className="text-[10px] font-mono text-slate-200 block mt-0.5 font-bold">{activeMetadata.contextWindow}</span>
                  </div>
                </div>

                <div className="bg-[#0B0C0E]/60 border border-slate-850 p-2 rounded-lg">
                  <span className="text-[8px] font-mono text-slate-500 uppercase block font-bold">REASONING PIPELINE STAGE</span>
                  <span className="text-[10px] font-mono text-teal-400 block mt-0.5 font-semibold flex items-center gap-1">
                    <CheckCircle2 size={10} className="text-teal-400" />
                    {activeMetadata.planningStages}
                  </span>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ========================================================
            TAB 4: AUTONOMOUS AGENTIC CORE VIEW
            ======================================================== */}
        {panelTab === 'autonomous' && (
          <div className="space-y-4 animate-fade-in text-xs">
            
            {/* Introductory framework banner */}
            <div className="bg-gradient-to-r from-amber-950/20 to-[#16181D] border border-amber-900/35 p-4 rounded-xl space-y-2">
              <div className="flex items-center gap-1.5 text-amber-400">
                <Flame size={14} className="animate-pulse" />
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-wider">Draft Skill Workspace</span>
              </div>
              <p className="text-xs text-slate-350 leading-relaxed font-sans font-medium">
                Draft candidate skills from the server-side Gemini adapter and validate them locally with deterministic checks. This prototype keeps core changes manual, keeps provider secrets on the server, and treats generated notes as unverified drafts.
              </p>
            </div>

            {/* Provider Configuration Section */}
            <div className="bg-[#14161D] border border-slate-850 rounded-xl p-3.5 space-y-3 shadow-md">
              <div className="flex items-center gap-1.5 border-b border-slate-850 pb-2">
                <Key size={12} className="text-amber-400" />
                <span className="text-[9px] font-mono font-bold uppercase text-slate-300 tracking-wider">AI Provider Labels</span>
              </div>

              <div className="grid grid-cols-3 gap-1">
                {providers.map((p) => (
                  <button
                    key={p.provider}
                    onClick={() => handleToggleProvider(p.provider)}
                    className={`py-1.5 rounded text-[9.5px] font-mono font-bold uppercase tracking-wide border cursor-pointer select-none transition ${
                      selectedProvider === p.provider
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                        : 'bg-slate-900/40 border-slate-850 text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {p.provider}
                  </button>
                ))}
              </div>

              {/* Advanced inline config */}
              <div className="space-y-2 pt-1">
                <div>
                  <div className="flex justify-between text-[8px] font-mono text-slate-500 mb-0.5 uppercase font-bold">
                    <span>Active Deployment Model:</span>
                    <span className="text-amber-500">Server-side credentials only</span>
                  </div>
                  <input
                    type="text"
                    value={providers.find(p => p.provider === selectedProvider)?.modelName || ''}
                    onChange={(e) => {
                      const updated = e.target.value;
                      setProviders(prev => prev.map(p => p.provider === selectedProvider ? { ...p, modelName: updated } : p));
                    }}
                    className="w-full text-[10.5px] font-mono bg-[#0B0C0E] text-slate-300 border border-slate-850 rounded px-2 py-1 focus:outline-none focus:border-amber-500"
                    placeholder="Model identifier (e.g. gpt-4o, deepseek-reasoner)"
                  />
                </div>

                <div className="bg-[#0B0C0E]/60 border border-slate-850 rounded-lg px-2 py-1.5">
                  <div className="text-[8px] font-mono text-slate-500 uppercase font-bold">Credential Source</div>
                  <div className="text-[10px] font-mono text-slate-300 mt-0.5">
                    {providers.find(p => p.provider === selectedProvider)?.credentialMode === 'server_env'
                      ? 'Server environment variable'
                      : 'Not connected in this prototype'}
                  </div>
                </div>
              </div>
            </div>

            {/* Executor Input Loop Console */}
            <div className="bg-[#14161D] border border-slate-850 rounded-xl p-3.5 space-y-3 shadow-md" id="executor-synthesis">
              <div className="flex items-center gap-1.5 border-b border-slate-850 pb-2">
                <Command size={12} className="text-amber-400 animate-spin-slow" />
                <span className="text-[9px] font-mono font-bold uppercase text-slate-300 tracking-wider">Execute Skill Synthesis Loop</span>
              </div>

              <form onSubmit={executeSelfImprovementLoop} className="space-y-2">
                <div>
                  <label className="block text-[8px] font-mono text-slate-500 mb-0.5 uppercase font-bold">Synthesizer Direct Target Task:</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      required
                      disabled={isImproving}
                      value={targetImprovementTask}
                      onChange={(e) => setTargetImprovementTask(e.target.value)}
                      className="flex-1 text-xs bg-[#0B0C0E] text-slate-200 border border-slate-850 rounded-lg p-2 focus:outline-none focus:border-amber-400 placeholder-slate-700 font-sans"
                      placeholder="e.g. Optimize topological persistent homology lattices..."
                    />
                    <button
                      type="submit"
                      disabled={isImproving}
                      className="px-3 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-black font-bold uppercase font-mono text-[10px] rounded-lg tracking-wider flex items-center justify-center gap-1 shadow-md transition"
                    >
                      {isImproving ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} />}
                      <span>Draft</span>
                    </button>
                  </div>
                </div>

                {/* Preconfigured prompt ideas */}
                <div className="space-y-1">
                  <span className="block text-[8px] font-mono text-slate-550 uppercase font-bold">Preconfigured Synthesis Directives:</span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      'MatrixExponentialEulerStateSolver',
                      'FourierLaplacianFilter',
                      'StatisticalChaosMapPredictor'
                    ].map((ide) => (
                      <button
                        key={ide}
                        type="button"
                        disabled={isImproving}
                        onClick={() => setTargetImprovementTask(`Create dynamic engine to: ${ide}`)}
                        className="bg-slate-900 border border-slate-850 text-slate-400 hover:text-amber-400 hover:border-amber-550 text-[8.5px] font-mono px-2 py-0.5 rounded cursor-pointer select-none"
                      >
                        +{ide}
                      </button>
                    ))}
                  </div>
                </div>
              </form>

              {/* Active CLI terminal output */}
              {(isImproving || currentTerminalLogs.length > 0) && (
                <div className="bg-[#07080B] rounded-xl border border-slate-850 overflow-hidden" id="agent-compiler-logs">
                  <div className="bg-[#0E1015] border-b border-slate-850 p-2 flex items-center justify-between text-[8px] font-mono text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <Terminal size={10} className="text-amber-400" />
                      <span>SKILL DRAFT CONSOLE ({selectedProvider.toUpperCase()})</span>
                    </div>
                    {isImproving ? (
                      <span className="text-amber-400 animate-pulse font-bold">[SYNTHESIZING...]</span>
                    ) : (
                      <span className="text-[#2DD4BF] font-bold">[OFFLINE IDLE]</span>
                    )}
                  </div>
                  
                  <div className="p-3 text-[9px] font-mono h-[140px] overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                    {currentTerminalLogs.length === 0 ? (
                      <div className="text-slate-600 italic">Initializing draft workspace...</div>
                    ) : (
                      currentTerminalLogs.map((log, index) => {
                        let color = 'text-slate-400';
                        if (log.includes('[DRAFT_INIT]') || log.includes('[ROUTER]')) color = 'text-[#A855F7]';
                        if (log.includes('[SKILL_GAP]') || log.includes('[VALIDATION_POLICY]')) color = 'text-amber-400';
                        if (log.includes('[DRAFT_NOTE]')) color = 'text-blue-400';
                        if (log.includes('[DRAFT_READY]') || log.includes('[VALIDATION]')) color = 'text-[#2DD4BF] font-semibold';
                        if (log.includes('[FATAL_ERROR]')) color = 'text-red-400 font-bold bg-red-950/25 px-1';
                        
                        return (
                          <div key={index} className={`leading-relaxed whitespace-pre-wrap ${color}`}>
                            {log}
                          </div>
                        );
                      })
                    )}
                    <div ref={consoleEndRef} />
                  </div>
                </div>
              )}
            </div>

            {/* Draft Skills Registry */}
            <div className="bg-[#14161D] border border-slate-850 rounded-xl p-3.5 space-y-3.5 shadow-md">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2">
                <div className="flex items-center gap-1.5">
                  <GraduationCap size={13} className="text-amber-400" />
                  <span className="text-[9px] font-mono font-bold uppercase text-slate-300 tracking-wider">Draft Skills Registry</span>
                </div>
                <span className="text-[8px] bg-amber-500/10 text-amber-500 border border-amber-500/25 px-1.5 py-0.5 rounded font-mono font-bold">
                  {autonomousSkills.length} Draft Skills Stored
                </span>
              </div>

              {/* Grid Selector */}
              <div className="grid grid-cols-2 gap-1.5">
                {autonomousSkills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedSkillId(s.id)}
                    className={`p-2.5 rounded-lg border text-left transition select-none flex flex-col justify-between h-[68px] cursor-pointer ${
                      selectedSkillId === s.id
                        ? 'bg-[#181C26] border-amber-500/60 shadow-inner'
                        : 'bg-slate-900/40 border-slate-850 hover:bg-slate-900'
                    }`}
                  >
                    <span className="font-sans font-bold text-slate-200 truncate block text-xs">{s.name}</span>
                    <div className="flex items-center justify-between w-full font-mono text-[8px] text-slate-500 mt-2.5">
                      <span className="flex items-center gap-0.5 text-slate-500 capitalize">
                        <Code size={8} /> JS Draft
                      </span>
                      <span className="text-[#2DD4BF] font-semibold font-mono" title="Local validation run count">
                        {s.successCount} Runs
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Viewer of active dynamic skill details */}
              {activeSkill && (
                <div className="bg-[#0B0C0E]/90 border border-slate-850 rounded-xl p-3 space-y-3 animate-fade-in relative overflow-hidden">
                  <div className="flex items-center justify-between border-b border-slate-850 pb-2">
                    <span className="text-[9px] font-mono font-bold text-amber-400 uppercase tracking-widest flex items-center gap-1">
                      <Settings size={11} className="text-amber-500" />
                      <span>Draft Code Inspector</span>
                    </span>
                    
                    <button
                      onClick={() => executeLocalSkillTest(activeSkill)}
                      className="px-2 py-0.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded font-mono text-[9px] uppercase font-bold transition flex items-center gap-1"
                    >
                      <Play size={10} />
                      {isExecutingLocalTest ? 'Testing...' : 'Validate Draft'}
                    </button>
                  </div>

                  <div className="space-y-1.5 text-xs">
                    <p className="text-slate-350 leading-relaxed font-sans font-medium italic text-[11px]">
                      {activeSkill.description}
                    </p>

                    <div className="pt-1.5">
                      <span className="text-[8px] font-mono text-slate-500 uppercase tracking-wider block font-bold mb-1">Functional Exports:</span>
                      <div className="flex flex-wrap gap-1">
                        {activeSkill.capabilities.map((c, idx) => (
                          <span key={idx} className="bg-slate-900 border border-slate-805 text-slate-400 font-mono text-[8.5px] px-2 py-0.5 rounded shadow-sm">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="pt-2">
                      <span className="text-[8px] font-mono text-slate-500 uppercase tracking-wider block font-bold mb-1">Draft JavaScript Snippet</span>
                      <pre className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg font-mono text-[8.5px] text-teal-400 overflow-x-auto whitespace-pre leading-relaxed select-all">
                        {activeSkill.codeSnippet}
                      </pre>
                    </div>

                    <div className="pt-2 border-t border-slate-850/60 flex items-center justify-between text-[8.5px] font-mono text-slate-500">
                      <span>Created: {new Date(activeSkill.createdAt).toLocaleDateString()}</span>
                      <span className="flex items-center gap-1 text-[#2DD4BF] font-semibold">
                        <CheckCircle2 size={10} className="text-teal-400" />
                        Status: Draft Validation {activeSkill.lastRunStatus.toUpperCase()}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Recharts chart showing draft validation history */}
            {skillDraftLogs.length > 0 && (
              <div className="bg-[#14161D] border border-slate-850 rounded-xl p-3.5 space-y-2">
                <div className="flex items-center justify-between border-b border-slate-850 pb-1.5 mb-1">
                  <div className="flex items-center gap-1">
                    <Award size={12} className="text-amber-400" />
                    <span className="text-[9.5px] font-bold font-mono text-slate-300 uppercase tracking-wider">DRAFT VALIDATION HISTORY</span>
                  </div>
                  <span className="text-[8px] text-slate-500 font-mono tracking-tighter">LOCAL CHECK TRACE</span>
                </div>

                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={skillDraftTrendData}
                      margin={{ top: 5, right: 5, left: -25, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="colorAccuracy" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.25}/>
                          <stop offset="95%" stopColor="#F59E0B" stopOpacity={0.0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2D3748" vertical={false} />
                      <XAxis 
                        dataKey="label" 
                        stroke="#718096" 
                        fontSize={8} 
                        fontFamily="monospace"
                        tickLine={false}
                      />
                      <YAxis 
                        domain={[0, 1]} 
                        tickCount={5} 
                        stroke="#718096" 
                        fontSize={8} 
                        fontFamily="monospace"
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{ 
                          backgroundColor: '#0F1115', 
                          border: '1px solid #2D3748',
                          borderRadius: '8px',
                          fontSize: '9px',
                          fontFamily: 'monospace',
                          color: '#F3F4F6',
                          padding: '6px'
                        }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="validation" 
                        stroke="#F59E0B" 
                        strokeWidth={1.5}
                        fillOpacity={1} 
                        fill="url(#colorAccuracy)" 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-center font-mono text-[8px] text-slate-500 pt-1">
                  Draft validation history. A value of 1 means deterministic local validation passed.
                </div>
              </div>
            )}

          </div>
        )}

      </div>

      {/* Footer information */}
      <div className="p-3 border-t border-slate-800 bg-[#0B0C0E]/90 text-[10px] text-slate-500 font-mono text-center flex justify-between items-center px-4 shrink-0">
        <span>© Cogito Memory Core</span>
        <span>phase-0 prototype • local state</span>
      </div>
    </div>
  );
}
