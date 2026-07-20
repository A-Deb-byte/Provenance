/**
 * @license
 * SPDX-License-Identifier: BUSL-1.1
 */

import React, { useMemo, useState } from 'react';
import { Brain, Database, Info, Search, ShieldCheck, SlidersHorizontal, User } from 'lucide-react';
import type { AgentFramework, MemoryItem, UserProfile } from '../types';

interface MemoryDashboardProps {
  memories: MemoryItem[];
  profile: UserProfile;
  isConsolidating: boolean;
  agentFramework: AgentFramework;
  onSetAgentFramework: (framework: AgentFramework) => void;
}

const frameworkDescriptions: Record<AgentFramework, string> = {
  cartographer: 'Organizes the conversation around structures, relationships, and maps.',
  prover: 'Emphasizes explicit evidence and stepwise derivation in the conversation.',
  archivist: 'Emphasizes provenance, chronology, and source-aware summaries.',
  sentinel: 'Emphasizes constraints, risk, and claim discipline.',
};

const categoryClass: Record<MemoryItem['category'], string> = {
  personal: 'border-amber-800/60 text-amber-300',
  technical: 'border-blue-800/60 text-blue-300',
  work: 'border-violet-800/60 text-violet-300',
  preferences: 'border-teal-800/60 text-teal-300',
  general: 'border-slate-700 text-slate-300',
};

export default function MemoryDashboard({
  memories,
  profile,
  isConsolidating,
  agentFramework,
  onSetAgentFramework,
}: MemoryDashboardProps) {
  const [tab, setTab] = useState<'memory' | 'profile' | 'lens'>('memory');
  const [query, setQuery] = useState('');

  const filteredMemories = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return memories;
    return memories.filter((memory) => (
      memory.content.toLowerCase().includes(normalized) ||
      memory.category.toLowerCase().includes(normalized) ||
      memory.source.toLowerCase().includes(normalized)
    ));
  }, [memories, query]);

  return (
    <div className="flex h-full flex-col bg-[#101114] text-slate-300">
      <header className="border-b border-slate-800 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.28em] text-teal-400">Knowledge Projection</p>
            <h2 className="mt-1 text-sm font-black text-white">Kernel Memory</h2>
          </div>
          <span className="rounded-full border border-emerald-800/60 bg-emerald-950/20 px-2 py-1 font-mono text-[8px] uppercase text-emerald-300">
            Server authoritative
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          This sidebar never creates, edits, or persists memory, skills, providers, or credentials in browser storage.
        </p>
      </header>

      <nav aria-label="Knowledge sidebar" className="grid grid-cols-3 border-b border-slate-800 p-2">
        {([
          ['memory', 'Memory', Database],
          ['profile', 'Profile', User],
          ['lens', 'Chat lens', SlidersHorizontal],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`flex items-center justify-center gap-1 rounded-md px-1 py-2 text-[9px] font-bold uppercase tracking-wider ${
              tab === id ? 'bg-slate-800 text-teal-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'memory' && (
          <div className="space-y-3">
            <label className="relative block">
              <span className="sr-only">Search promoted kernel memory</span>
              <Search size={12} className="absolute left-2.5 top-2.5 text-slate-600" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search promoted memory"
                className="w-full rounded-lg border border-slate-800 bg-[#0B0C0E] py-2 pl-8 pr-2 text-[10px] text-slate-200 outline-none focus:border-teal-800"
              />
            </label>

            {isConsolidating && (
              <p role="status" className="rounded-lg border border-cyan-900/50 bg-cyan-950/20 p-2 text-[10px] text-cyan-300">
                Provider candidates are being submitted to the kernel for review.
              </p>
            )}

            {filteredMemories.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center">
                <Brain size={22} className="mx-auto text-slate-700" />
                <p className="mt-2 text-xs font-bold text-slate-400">No promoted memory found</p>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                  Candidates and lifecycle controls remain in the Learning Cockpit.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {filteredMemories.map((memory) => (
                  <li key={memory.id} className="rounded-xl border border-slate-800 bg-[#0B0C0E]/70 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase ${categoryClass[memory.category]}`}>
                        {memory.category}
                      </span>
                      <span className="font-mono text-[8px] text-slate-600">confidence {memory.importance}/5</span>
                    </div>
                    <p className="mt-2 select-text text-[11px] leading-relaxed text-slate-300">{memory.content}</p>
                    <p className="mt-2 break-all font-mono text-[8px] text-slate-600">{memory.source}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'profile' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/10 p-3">
              <div className="flex items-center gap-1.5 text-amber-300">
                <Info size={12} />
                <span className="font-mono text-[9px] font-bold uppercase tracking-wider">Presentation only</span>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                This prompt-facing description is bundled with the app. It is not authoritative memory and is not editable or persisted here.
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#0B0C0E]/70 p-3">
              <p className="text-[11px] leading-relaxed text-slate-300">{profile.bio}</p>
              {profile.extractedName && <p className="mt-2 font-mono text-[9px] text-slate-600">Label: {profile.extractedName}</p>}
            </div>
          </div>
        )}

        {tab === 'lens' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-cyan-900/50 bg-cyan-950/10 p-3">
              <div className="flex items-center gap-1.5 text-cyan-300">
                <ShieldCheck size={12} />
                <span className="font-mono text-[9px] font-bold uppercase tracking-wider">No authority</span>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                The chat lens changes prompt presentation only. It cannot change kernel policy, provider routing, permissions, memory, or skills.
              </p>
            </div>
            {(Object.keys(frameworkDescriptions) as AgentFramework[]).map((framework) => (
              <button
                key={framework}
                type="button"
                aria-pressed={agentFramework === framework}
                onClick={() => onSetAgentFramework(framework)}
                className={`w-full rounded-xl border p-3 text-left ${
                  agentFramework === framework
                    ? 'border-teal-800 bg-teal-950/15'
                    : 'border-slate-800 bg-[#0B0C0E]/50 hover:border-slate-700'
                }`}
              >
                <span className="text-xs font-bold capitalize text-slate-200">{framework}</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-slate-500">{frameworkDescriptions[framework]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-slate-800 px-3 py-2 text-center font-mono text-[8px] uppercase tracking-wider text-slate-600">
        Kernel-backed memory / presentation-only profile and chat lens
      </footer>
    </div>
  );
}
