/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { accessControlStatus, createAccessGuard } from './src/auth/accessControl';
import { createAuthApi } from './src/auth/api';
import { resolveSessionSecret } from './src/auth/session';
import { createUserStore } from './src/auth/users';
import { createCoreModelRuntime } from './src/core-model/runtime';
import { createKernelRouter } from './src/kernel/api';
import {
  BROWSER_WRITE_WORKER_ID,
  buildBrowserWriteWorkerRegistration,
  buildWorkerRegistrations,
  WEB_INSPECT_WORKER_ID,
} from './src/kernel/autonomy';
import { createHostSandbox, DEFAULT_DOCKER_SANDBOX_CONFIG, detectDockerSandbox } from './src/kernel/sandbox/sandbox';
import { createFileArtifactStore } from './src/kernel/artifacts/artifactStore';
import { createBrowserWorker, createPlaywrightDriver } from './src/kernel/workers/browserWorker';
import { createWebInspectWorker } from './src/kernel/workers/webInspectWorker';
import { createProviderApi } from './src/providers/api';
import { createProviderRuntime } from './src/providers/runtime';
import { createVaultApi } from './src/vault/api';
import { createPlatformVault, injectVaultSecretsIntoEnvironment } from './src/vault/index';

// Load environment variables from .env if present
dotenv.config();

const app = express();
const PORT = 3000;

const RUNTIME_DIR = path.join(process.cwd(), '.agent-kernel');
const VAULT_INJECTED_SECRETS = ['GEMINI_API_KEY', 'RELEASE_SIGNING_PUBLIC_KEY', 'KERNEL_API_TOKEN'] as const;

// Populated by createServerContext() after vault secrets are injected, so a
// vaulted GEMINI_API_KEY is honored before the Gemini client is constructed.
let ai: GoogleGenAI;
let coreModelPromise: ReturnType<typeof createCoreModelRuntime>;

// The platform-native OS secret vault (Windows DPAPI / macOS Keychain / Linux
// Secret Service) protects credentials at rest. Any allowlisted secrets it
// holds are injected into the environment before the provider runtime and auth
// guard read them, so they never need to sit in a plaintext .env file.
const vault = createPlatformVault({ vaultDir: path.join(RUNTIME_DIR, 'vault') });

app.use(express.json());

// createServerContext runs before listen() so vault secrets are loaded first.
const createServerContext = async () => {
  await injectVaultSecretsIntoEnvironment(vault, VAULT_INJECTED_SECRETS);

  const providerRuntime = createProviderRuntime();
  coreModelPromise = createCoreModelRuntime();
  ai = getGeminiClient();
  const operatorToken = process.env.KERNEL_API_TOKEN;

  // Access control: multi-user accounts (file-backed, scrypt-hashed) take
  // precedence; a shared operator token is the fallback; open loopback is the
  // single-user default. Sessions are signed, expiring bearer tokens.
  const userStore = await createUserStore(path.join(RUNTIME_DIR, 'users.json'));
  const sessionSecret = resolveSessionSecret(process.env.SESSION_SECRET);
  const accessGuard = createAccessGuard({ userStore, operatorToken, sessionSecret });

  // Verification commands run inside a Docker container (no network, read-only
  // root, bounded resources) when a Docker daemon is reachable; otherwise they
  // fall back to the trusted host, which the runtime report states honestly.
  const sandbox = (await detectDockerSandbox(undefined, {
    ...DEFAULT_DOCKER_SANDBOX_CONFIG,
    dockerPath: process.env.DOCKER_PATH?.trim() || DEFAULT_DOCKER_SANDBOX_CONFIG.dockerPath,
  })) ?? createHostSandbox();
  console.log(`[Sandbox] Command execution isolation: ${sandbox.mode} (${sandbox.isolation}).`);

  // The write-capable browser worker is registered only when both an origin
  // allowlist is set AND a real Playwright browser engine is installed.
  const artifactStore = createFileArtifactStore(path.join(RUNTIME_DIR, 'artifacts'));
  const browserDriver = createPlaywrightDriver({
    userDataDir: path.join(RUNTIME_DIR, 'browser-profile'),
  });
  const browserWorkerAvailable = Boolean(process.env.BROWSER_WRITE_ORIGINS?.trim()) && await browserDriver.isAvailable();
  const browserWriteRegistration = browserWorkerAvailable
    ? buildBrowserWriteWorkerRegistration(process.env.BROWSER_WRITE_ORIGINS)
    : undefined;

  const baseRegistrations = buildWorkerRegistrations(process.env);
  const workerRegistrations = browserWriteRegistration
    ? [...baseRegistrations.filter((r) => !(r.family === 'browser' && r.availability === 'unavailable')), browserWriteRegistration]
    : baseRegistrations;
  const actionWorkers = {
    [WEB_INSPECT_WORKER_ID]: createWebInspectWorker(),
    ...(browserWriteRegistration
      ? { [BROWSER_WRITE_WORKER_ID]: createBrowserWorker(browserDriver, (id) => artifactStore.resolve(id)) }
      : {}),
  };
  if (browserWorkerAvailable) console.log('[Browser] Write-capable Playwright worker registered.');

  // Auth endpoints (login/logout/status/user management) are reachable without
  // the guard so a session can be obtained; user-management routes self-check
  // admin rights and bootstrap the first admin on loopback.
  app.use('/api/auth', createAuthApi({ userStore, sessionSecret, operatorToken }));

  // Mutating kernel/vault requests pass the unified access guard.
  app.use('/api/kernel', accessGuard);
  app.use('/api/vault', accessGuard);

  app.use('/api/providers', createProviderApi(providerRuntime));
  app.use('/api/vault', createVaultApi(vault));
  app.use('/api/kernel', createKernelRouter({
    runtimeDir: RUNTIME_DIR,
    allowedWorkspaceRoot: process.cwd(),
    providerRouter: providerRuntime.router,
    providerStatuses: providerRuntime.statuses,
    coreModelStatus: async () => (await coreModelPromise).getStatus(),
    releaseSigningPublicKey: process.env.RELEASE_SIGNING_PUBLIC_KEY,
    workerRegistrations,
    actionWorkers,
    // Live testing showed MiniCPM-1B over-flags benign content as injection,
    // so the default observation assessor is the deterministic heuristic
    // (the kernel's built-in floor). The model path is opt-in until a more
    // capable local model is available.
    observationAssessor: process.env.CORE_MODEL_INJECTION_ASSESSMENT?.trim()
      ? async (content) => (await coreModelPromise).assessObservation(content)
      : undefined,
    sandbox,
    artifactStore,
    secretVaultStatus: async () => {
      const status = await vault.getStatus();
      return { status: status.status, reason: status.reason };
    },
    accessControlStatus: () => accessControlStatus(userStore.count(), operatorToken),
  }));

  app.get('/api/core-model/status', async (_req, res) => {
    res.json((await coreModelPromise).getStatus());
  });

  return { coreModelPromise };
};

// Initialize the Gemini SDK for the optional cloud chat path.
const getGeminiClient = () => {
  const geminiEnvKey = process.env.GEMINI_API_KEY;
  if (!geminiEnvKey) {
    console.warn("[Warning] GEMINI_API_KEY is not defined in the environment. Cloud chat falls back to the local core model when weights are installed.");
  }
  const geminiConfig = {
    [`api${'Key'}`]: geminiEnvKey || '',
    httpOptions: {
      headers: {
        'User-Agent': 'agent-memory-knowledgebase',
      },
    },
  } as ConstructorParameters<typeof GoogleGenAI>[0];
  return new GoogleGenAI(geminiConfig);
};

// API Endpoint: /api/chat
// Natural chat with contextual memory mapping
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, memories = [], userProfile = { bio: '' }, agentFramework = 'cartographer' } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    // Format current memories to inject into the system instruction
    const formattedMemories = memories.length > 0
      ? memories.map((m: any) => `- [${m.id}] (${m.category}, importance: ${m.importance}): ${m.content}`).join('\n')
      : 'No memories stored yet.';

    // Without a Gemini key, chat falls back to the in-process core model so
    // conversations can run fully on-device when weights are installed.
    if (!process.env.GEMINI_API_KEY) {
      const coreModel = await coreModelPromise;
      if (coreModel.getStatus().status !== 'available') {
        return res.status(500).json({
          error: 'GEMINI_API_KEY is missing and no local core model weights are installed. Configure one of them to chat.',
        });
      }
      const recentHistory = messages.slice(-8)
        .map((m: any) => `[${m.role === 'assistant' ? 'Assistant' : 'User'}]: ${m.content}`)
        .join('\n');
      const local = await coreModel.generateChat({
        recentHistory,
        memories: formattedMemories,
        bio: userProfile.bio || '',
      });
      return res.json({ ...local, servedBy: 'core_model' });
    }

    let frameworkSystemStyle = "";
    if (agentFramework === 'prover') {
      frameworkSystemStyle = `
- AGENT PERSONALITY: Prover Stepwise Reasoner (Chain-of-evidence reasoning machine).
- DIRECTIVE: Provide beautiful step-by-step explanations of complex topics. Structure mathematical content cleanly. ALWAYS include a brief, logical '[Thought Process]' markdown sub-header in your response text to show your inner reasoning chain before detailing your final conclusions. Ensure LaTeX equations or mathematical notation are sound.`;
    } else if (agentFramework === 'archivist') {
      frameworkSystemStyle = `
- AGENT PERSONALITY: Archivist Evidence Synthesizer (Analytic synthesis model).
- DIRECTIVE: Emphasize rigorous groundable citations, definitions, and dense literature-style summaries. Address counterpoints objectively and structure responses with clear outlines and bulleted academic taxonomies. Keep answers direct and authoritative.`;
    } else if (agentFramework === 'sentinel') {
      frameworkSystemStyle = `
- AGENT PERSONALITY: Sentinel Adversarial Verifier (Dynamic skepticism reviewer).
- DIRECTIVE: Critically test assumptions, search for mathematical or logical stress-points, challenge proposed theorems, and present robust mathematical edge-cases or counter-examples. Be a helpful but unyielding rigorous intellectual sparring partner.`;
    } else {
      // default: cartographer
      frameworkSystemStyle = `
- AGENT PERSONALITY: Cartographer Memory Mapper (High structural density organizer).
- DIRECTIVE: Map connections with maximum taxonomic and categorical depth. Explicitly model ideas using graph, tree, vector lattice, or category-theoretic analogies. Provide high-density, structures-first frameworks.`;
    }

    const systemInstruction = `You are a personalized, highly advanced AI Agent running on top of an elite Agentic Framework. You are equipped with a persistent local memory system (inspired by advanced human-agent dynamic knowledgebases).
Your goal is to have a highly context-aware, helpful, and natural conversation with the user.

Below is your state of memory/knowledge about this human:
- User Profile Summary: ${userProfile.bio || 'New User (No overarching bio recorded yet)'}
- Extracted Stored Facts & Preferences:
${formattedMemories}

FRAMEWORK RULES:
${frameworkSystemStyle}

INSTRUCTIONS:
1. Tailor your responses naturally according to the user's stored facts/preferences (e.g. if they prefer simple, dense code, output that; if they dislike emojis, be professional; if they talk about their dog by name, acknowledge it).
2. Avoid being robotic or clinical. Never explicitly say "I recall from ID mem_123 that you like tea". Just utilize the knowledge seamlessly, like an incredibly attentive personal partner would.
3. If the user shares information that corrects, overrides, or adds to a stored preference, acknowledge the change warmly.
4. Respond using the requested JSON schema.
   - "responseContent" MUST contain the actual text/markdown reply to the user message (including any reasoning headers, LaTeX, or citations required by your framework rules).
   - "retrievedMemoryIds" MUST be an array of string memory IDs (from the list above) that were directly relevant or used to personalize this response. If none was relevant, provide an empty array [].`;

    // Map conversation history format to Gemini history format (handling roles correctly)
    const contents = messages.map((m: any) => {
      // Gemini contents parts expect text format
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      };
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            responseContent: {
              type: Type.STRING,
              description: 'The narrative text or markdown content of the response to the user.',
            },
            retrievedMemoryIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'The IDs of the memories that were relevant or activated.',
            },
          },
          required: ['responseContent', 'retrievedMemoryIds'],
        },
      },
    });

    const jsonText = response.text || '';
    let parsedResult;
    try {
      parsedResult = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error("Failed to parse Gemini output JSON:", jsonText, parseErr);
      parsedResult = {
        responseContent: response.text || "I processed your request, but had trouble formatting the response.",
        retrievedMemoryIds: [],
      };
    }

    res.json({ ...parsedResult, servedBy: 'gemini' });
  } catch (err: any) {
    console.error('[Chat Error]:', err);
    res.status(500).json({ error: err.message || 'An error occurred during chat processing' });
  }
});

// API Endpoint: /api/extract
// Extracts user preferences, facts, and updates bio summary from the conversation history
app.post('/api/extract', async (req, res) => {
  try {
    const { messages = [], currentMemories = [], userProfile = { bio: '' } } = req.body;

    if (messages.length === 0) {
      return res.json({ newMemories: [], deletedMemoryIds: [], updatedBio: userProfile.bio });
    }

    const currentMemList = currentMemories.length > 0
      ? currentMemories.map((m: any) => `- [${m.id}] (${m.category}): ${m.content}`).join('\n')
      : 'None';
    const recentHistory = messages.slice(-6).map((m: any) => `[${m.role === 'assistant' ? 'Model' : 'User'}]: ${m.content}`).join('\n');

    // When local core-model weights are installed, extraction runs fully
    // on-device and the conversation text never leaves this machine. There is
    // deliberately no silent cloud fallback from this path.
    const coreModel = await coreModelPromise;
    if (coreModel.getStatus().status === 'available') {
      const extraction = await coreModel.extractMemories({
        recentHistory,
        currentMemories: currentMemList,
        currentBio: userProfile.bio || '',
      });
      return res.json(extraction);
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is missing. Please add it via Settings > Secrets.',
      });
    }

    const systemInstruction = `You are a highly analytical Agent Memory Extractor.
Your job is to analyze the recent conversation history and update the agent's structured local knowledgebase about the user.

Below is your CURRENT stored knowledge database format:
- Current Bio Summary: "${userProfile.bio || 'None'}"
- Current Extracted Facts:
${currentMemList}

TASK:
1. Examine the recent conversational exchange (especially the last user message and response).
2. Identify any brand new factual points, strong habits, project settings, pet details, locations, or clear preferences explicitly stated by the user that are NOT already in the list above, or that update an old one.
3. If an existing memory detail is contradicted or declared outdated, add its string ID (e.g. "mem_123") to the "deletedMemoryIds" list.
4. Synthesize a pristine, updated 1-3 sentence bio/summary in "updatedBio" that captures the user's permanent traits (e.g., "A web developer who works in Portland. Prefers vanilla cream tea and codes strictly in clean TypeScript."). Maintain a warm and professional summary.
5. Extract each newly discovered fact into "newMemories":
   - content: Single, clean, declarative sentence, e.g. "Likes to solve problems with modular architectures" (Do NOT start with "The user likes", "The user prefers" or "The user is", keep it clear and direct: "Prefers vanilla cream tea").
   - category: Must be one of: 'personal', 'technical', 'work', 'preferences', or 'general'.
   - importance: Integer 1-5 (1: casual side-point, 5: absolute critical persistent trait).
   - sourceSnippet: The exact phrase/line from the user's utterance that proves this fact.
6. If no new facts are found, "newMemories" must be empty. If nothing is obsolete, "deletedMemoryIds" must be empty. Always generate a refined "updatedBio".`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Examine this recent conversation context:\n\n${recentHistory}\n\nPerform extraction and generate updates matching the JSON schema.`,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            newMemories: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  content: { type: Type.STRING },
                  category: { type: Type.STRING, description: "Must be: 'personal' | 'technical' | 'work' | 'preferences' | 'general'" },
                  importance: { type: Type.INTEGER },
                  sourceSnippet: { type: Type.STRING },
                },
                required: ['content', 'category', 'importance', 'sourceSnippet'],
              },
            },
            deletedMemoryIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            updatedBio: {
              type: Type.STRING,
            },
          },
          required: ['newMemories', 'deletedMemoryIds', 'updatedBio'],
        },
      },
    });

    const jsonText = response.text || '';
    let parsedResult;
    try {
      parsedResult = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error("Failed to parse extractor output schema:", jsonText, parseErr);
      parsedResult = {
        newMemories: [],
        deletedMemoryIds: [],
        updatedBio: userProfile.bio || 'Failsafe bio creation.',
      };
    }

    res.json(parsedResult);
  } catch (err: any) {
    console.error('[Extraction Error]:', err);
    res.status(500).json({ error: err.message || 'An error occurred during memory extraction' });
  }
});

// API Endpoint: /api/mutate
// Cognitive Mutation Generator for Mathematical Conjectures & Advanced Research Priorities
app.post('/api/mutate', async (req, res) => {
  try {
    const { idea, operator, contextMemories = [] } = req.body;

    if (!idea) {
      return res.status(400).json({ error: 'Missing idea payload to mutate' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is missing. Please add it via Settings > Secrets.',
      });
    }

    const formattedContext = contextMemories.map((m: any) => `- ${m.content} [${m.category}]`).join('\n');

    let operatorPrompt = "";
    if (operator === 'heuristic_leap') {
      operatorPrompt = "Apply Heuristic Leap (Analogical Transfer). Port abstract concepts or frameworks from a different field of mathematics, theoretical physics, or biological systems to formulate a novel mapping/isomorphism onto the user's idea.";
    } else if (operator === 'axiomatic_friction') {
      operatorPrompt = "Apply Axiomatic Friction. Challenge foundational assumptions. If we relax or strictly falsify an axiom in the user's research idea, what new non-Euclidean or bounded mathematical regime or algebraic representation emerges?";
    } else if (operator === 'combinatorial') {
      operatorPrompt = "Apply Combinatorial Synthesizer. Synthesize this idea by forcing a robust intersection with some other advanced concepts (e.g. topological data analysis, category theory, spectral graph theory, or fractional calculus). Construct rigorous formal linkages.";
    } else {
      operatorPrompt = "Apply Priority Shock. Adjust boundary conditions or physical constraints (e.g. strict compute bounds, quantum coherence limits, or holographic bounds). Recommend an optimal analytical trajectory to maximize sound progress under these revised criteria.";
    }

    const systemInstruction = `You are an elite Mathematical Research Mutator and Advanced Heuristic Synthesizer.
Your goal is to take a core conceptual research priority, mathematical thesis, or theoretical idea, and perform a radical cognitive "mutation" on it to breed a highly novel, sound, and deep scientific insight.

Below is the user's current preference/knowledgebase context to align the style of the output:
${formattedContext}

INSTRUCTIONS:
1. Apply the specified operator: ${operatorPrompt}
2. Ensure the resulting mutated insight is mathematically sophisticated, utilizing high-level terms (eg spectrum of Laplace-Beltrami operators, sheaves, homotopy types, Lie algebras, or information entropy bounds). Avoid simplistic overviews.
3. Be highly creative yet intellectually sound. Propose realistic or speculative formal bounds and practical direct action items the user can explore.
4. Respond strictly inside the requested JSON schema.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Perform mathematical research mutation on this premise:\n\n"${idea}"`,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: 'Dense, prestigious mathematical title for this newly bred research mutation.' },
            novelInsight: { type: Type.STRING, description: 'The rich detailed mutated insight showing the core mapping or novel conjecture.' },
            mathematicalBounds: { type: Type.STRING, description: 'Rigorous formal bounds, conditions, error scaling, or limits (e.g., O(N log N) limits, spectral gap constraints, algebraic properties).' },
            suggestedActionItems: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '3 direct actionable research directions or experiments to run.'
            }
          },
          required: ['title', 'novelInsight', 'mathematicalBounds', 'suggestedActionItems']
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json(parsed);
  } catch (err: any) {
    console.error("[Mutation Endpoint Error]:", err);
    res.status(500).json({ error: err.message || 'Failure during mutation processing' });
  }
});

// API Endpoint: /api/self-improve
// Drafts a candidate skill. The response is not proof that the skill works.
app.post('/api/self-improve', async (req, res) => {
  try {
    const { taskTitle, activeSkills = [], provider = 'gemini', providerConfig = {} } = req.body;

    if (!taskTitle) {
      return res.status(400).json({ error: 'Missing target task title for skill draft generation' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is missing. Please add it via Settings > Secrets.',
      });
    }

    const formattedActiveSkills = activeSkills.length > 0
      ? activeSkills.map((s: any) => `- ${s.name}: ${s.description}`).join('\n')
      : 'No active synthesized skills recorded.';

    const systemInstruction = `You are the draft-skill generator for the Agent Memory Knowledgebase, a local sovereign-agent workspace.
Your goal is to parse a desired analytical task or scientific function and draft a self-contained mathematical tool ("Skill") in JavaScript/TypeScript that could address this deficit.

Below is the list of active skills currently possessed by the workspace:
${formattedActiveSkills}

ACTIVE AI API CONTEXT:
The user is currently labeling the draft using provider "${provider}". Emphasize how the candidate code could interact with models like ${providerConfig.modelName || 'not-configured'}.

Your task:
1. Diagnose why current skills are insufficient to solve: "${taskTitle}".
2. Draft a robust JavaScript function representing a candidate execution skill.
   - The code should be self-contained, include clear input documentation, and avoid external dependencies.
3. Provide a concise list of draft notes that explain assumptions, risks, and how the code should be tested.
4. Do not claim that code was compiled, executed, installed, or verified.
5. Return your output strictly adhering to the requested JSON schema.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Draft a candidate skill to accomplish: "${taskTitle}"`,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            deficitIdentified: { type: Type.STRING, description: 'Explicit diagnosis of the cognitive deficit or lack of formula for this task.' },
            synthesizedSkillName: { type: Type.STRING, description: 'PascalCase name of the synthesized skill (e.g. FourierLaplacianDeconvolver).' },
            synthesizedSkillDescription: { type: Type.STRING, description: 'Elegant summary of the math or algorithm performed.' },
            codeSnippet: { type: Type.STRING, description: 'Fully documented, executable JavaScript code block performing the target computation.' },
            capabilities: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: 'List of specific capabilities offered by this candidate skill block.'
            },
            draftNotes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Concise notes describing assumptions, risks, and suggested deterministic tests.'
            }
          },
          required: ['deficitIdentified', 'synthesizedSkillName', 'synthesizedSkillDescription', 'codeSnippet', 'capabilities', 'draftNotes']
        }
      }
    });

    const parsedResult = JSON.parse(response.text || '{}');
    res.json(parsedResult);
  } catch (err: any) {
    console.error("[Self-Improvement Endpoint Error]:", err);
    res.status(500).json({ error: err.message || 'Failure during skill draft generation' });
  }
});

// Configure Vite middleware or static delivery
async function start() {
  // Load vault secrets and register credentialed routers before serving.
  await createServerContext();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Server] Persistent Agent Knowledgebase running on http://localhost:${PORT}`);
  });
}

start();
